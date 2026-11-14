/** Read-only GitLab project, discussion, approval, pipeline, and repository-file readers. */
import { z } from 'zod'
import type { Commands, Tally } from '../infra/commands.ts'
import { validItems } from '../infra/commands.ts'
import { glabFor, type GlabRunner } from '../infra/gitlab.ts'
import type { ThreadFact, Trigger } from '../core/index.ts'
import { GitlabIssueSchema, GitlabMergeRequestSchema, GitlabNoteSchema, GitlabPipelineSchema, GitlabUserSchema,
  type GitlabIssue, type GitlabMergeRequest, type GitlabNote, type GitlabPipeline } from './gitlab-trigger.ts'
import type { ContextMessage, ContextPart, ContextPartName, ThreadContext } from './kind.ts'

const ProjectSchema = z.looseObject({ default_branch: z.string().nullish() })
const TreeEntrySchema = z.looseObject({ name: z.string(), type: z.string() })
const DiscussionSchema = z.looseObject({ id: z.string(), notes: z.array(z.unknown()), individual_note: z.boolean().optional() })
const ApprovalsSchema = z.looseObject({ approved: z.boolean(), approvals_required: z.number().optional(), approvals_left: z.number().optional(),
  approved_by: z.array(z.looseObject({ user: GitlabUserSchema })).optional() })
const PipelinePageSchema = z.array(z.unknown())

export interface GitlabCiSnapshot { head: string; pipelines: Pick<GitlabPipeline, 'id' | 'status' | 'ref' | 'sha'>[] }
const FAILING = new Set(['failed', 'canceled', 'cancelled'])
const RUNNING = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled', 'manual', 'blocked'])
export interface GitlabCiCounts { failed: number; running: number; passed: number; neutral: number }
export function gitlabCiCounts(snapshot: GitlabCiSnapshot): GitlabCiCounts {
  const failed = snapshot.pipelines.filter(item => FAILING.has(item.status)).length
  const running = snapshot.pipelines.filter(item => RUNNING.has(item.status)).length
  const passed = snapshot.pipelines.filter(item => item.status === 'success').length
  return { failed, running, passed, neutral: snapshot.pipelines.length - failed - running - passed }
}
export function gitlabCiSummary(snapshot: GitlabCiSnapshot, where: string, read: string): string {
  const counts = gitlabCiCounts(snapshot)
  const total = snapshot.pipelines.length
  const status = counts.failed ? `CI failed ${counts.failed}/${total}` : counts.running ? `CI pending ${counts.running}/${total}`
    : !total ? 'CI has no pipelines' : counts.neutral ? `CI incomplete ${counts.passed}/${total} passed, ${counts.neutral} neutral` : `CI passed ${counts.passed}/${total}`
  const names = snapshot.pipelines.slice(0, 5).map(item => `${item.ref}: ${item.status}`).join(', ')
  return `${status} on ${where} at ${snapshot.head.slice(0, 7)}${names ? `: ${names}` : ''}\nRead ${read} for every pipeline.`
}
export function gitlabCiFact(counts: GitlabCiCounts): ThreadFact {
  if (counts.failed) return { label: { zh: 'CI 失败', en: 'CI failed' }, value: String(counts.failed), problem: true }
  if (counts.running) return { label: { zh: 'CI 进行中', en: 'CI running' }, value: String(counts.running) }
  if (counts.neutral) return { label: { zh: 'CI 未完成', en: 'CI incomplete' }, value: `${counts.passed} passed, ${counts.neutral} neutral` }
  if (!counts.passed) return { label: { zh: 'CI 状态', en: 'CI status' }, value: { zh: '未运行', en: 'not run' } }
  return { label: 'CI', value: { zh: '通过', en: 'passed' } }
}

function safePath(path: string): string[] {
  if (path.includes('\\') || path.includes('\0')) throw new Error('Only non-hidden repository source paths are available')
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  return parts
}
async function defaultBranch(runner: GlabRunner): Promise<string> {
  const project = await runner.api(ProjectSchema, runner.projectPath)
  if (!project.default_branch) throw new Error('GitLab project has no default branch')
  return project.default_branch
}

/** Reads a non-hidden file or directory from this project's default branch. */
export async function readGitlabRepositoryPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string> {
  const runner = glabFor(commands)
  const parts = safePath(path)
  const branch = await defaultBranch(runner)
  if (kind === 'file') {
    if (!parts.length) throw new Error('The repository root is a directory')
    const file = encodeURIComponent(parts.join('/'))
    const endpoint = `${runner.projectPath}/repository/files/${file}/raw?ref=${encodeURIComponent(branch)}`
    return runner.raw(endpoint)
  }
  const query = new URLSearchParams({ ref: branch, per_page: '100', ...(parts.length ? { path: parts.join('/') } : {}) })
  const entries = await runner.pages(TreeEntrySchema, `${runner.projectPath}/repository/tree?${query.toString()}`)
  return entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
}

/** Reads the Merge Request identified by its project IID, including the fields required for ticket association. */
export async function readGitlabMergeRequest(commands: Commands, iid: number): Promise<GitlabMergeRequest> {
  const runner = glabFor(commands)
  return runner.api(GitlabMergeRequestSchema, `${runner.projectPath}/merge_requests/${positive(iid)}`)
}
function positive(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('GitLab IID must be a positive integer')
  return String(value)
}

/** Returns all MR pipelines, ordered by the GitLab API, without emitting a Trigger. */
export async function readGitlabMergeRequestPipelines(commands: Commands, iid: number, tally?: Tally): Promise<GitlabPipeline[]> {
  const runner = glabFor(commands)
  return runner.pages(GitlabPipelineSchema, `${runner.projectPath}/merge_requests/${positive(iid)}/pipelines?per_page=100`, tally)
}
/** Returns one project's pipeline list, optionally scoped to a ref. */
export async function readGitlabPipelines(commands: Commands, ref?: string, tally?: Tally, updatedAfter?: string): Promise<GitlabPipeline[]> {
  const runner = glabFor(commands)
  const query = new URLSearchParams({ per_page: '100', ...(ref ? { ref } : {}), ...(updatedAfter ? { updated_after: updatedAfter } : {}) })
  return runner.pages(GitlabPipelineSchema, `${runner.projectPath}/pipelines?${query.toString()}`, tally)
}

/** Reads the latest CI state for one Merge Request's head. */
export async function readGitlabCi(commands: Commands, mr: GitlabMergeRequest, tally?: Tally): Promise<GitlabCiSnapshot> {
  const all = await readGitlabMergeRequestPipelines(commands, mr.iid, tally)
  const head = mr.sha ?? all[0]?.sha ?? ''
  const pipelines = all.filter(item => !head || item.sha === head).slice(0, 20)
  return { head, pipelines: pipelines.map(({ id, status, ref, sha }) => ({ id, status, ref, sha })) }
}

function message(note: GitlabNote, text = note.body ?? '', id = String(note.id)): ContextMessage {
  const path = note.position?.new_path ?? note.position?.old_path
  const line = note.position?.new_line ?? note.position?.old_line
  return { id, from: note.author.username, at: note.created_at ?? note.updated_at ?? '', text,
    ...(note.author.bot || /\[bot\]$/i.test(note.author.username) ? { bot: true as const } : {}),
    ...(note.url ? { url: note.url } : {}), ...(path ? { path, ...(line != null ? { line } : {}) } : {}) }
}
function noteText(note: GitlabNote): string {
  const path = note.position?.new_path ?? note.position?.old_path
  const line = note.position?.new_line ?? note.position?.old_line
  return [path ? `${path}${line != null ? `:${line}` : ''}` : '', note.body ?? ''].filter(Boolean).join('\n\n')
}
async function notesPage(runner: GlabRunner, kind: 'issue' | 'merge_request', iid: number, page: number, tally?: Tally): Promise<GitlabNote[]> {
  const endpointKind = kind === 'issue' ? 'issues' : 'merge_requests'
  const path = `${runner.projectPath}/${endpointKind}/${positive(iid)}/notes?per_page=100&page=${page}`
  const result = await runner.api(PipelinePageSchema, path)
  return validItems(GitlabNoteSchema, result, tally)
}
async function conversationPage(commands: Commands, kind: 'issue' | 'merge_request', iid: number, page: number): Promise<ContextPart> {
  const runner = glabFor(commands)
  const messages: ContextMessage[] = []
  if (page === 1) {
    if (kind === 'issue') {
      const issue = await runner.api(GitlabIssueSchema, `${runner.projectPath}/issues/${positive(iid)}`)
      messages.push({ id: issue.web_url, from: issue.author.username, at: issue.created_at,
        text: `${issue.title}\n\n${issue.description ?? ''}`, ...(issue.author.bot ? { bot: true as const } : {}), url: issue.web_url })
    } else {
      const mr = await runner.api(GitlabMergeRequestSchema, `${runner.projectPath}/merge_requests/${positive(iid)}`)
      messages.push({ id: mr.web_url, from: mr.author.username, at: mr.created_at ?? '',
        text: `${mr.title}\n\n${mr.description ?? ''}`, ...(mr.author.bot ? { bot: true as const } : {}), url: mr.web_url })
    }
  }
  const notes = (await notesPage(runner, kind, iid, page)).filter(note => !note.system)
  messages.push(...notes.map(note => message(note)))
  const body = { status: 'conversation', messages }
  return { messages, next: notes.length === 100 ? String(page + 1) : undefined, body, status: 'conversation' }
}

const DUMMY_TALLY: Tally = { skipped: 0 }
const resourceError = 'Use gitlab/issue/<iid> or gitlab/merge_request/<iid>, optionally followed by /notes/<page>, /discussions/<id>, /approvals, /pipelines or /checks.'
/** Reads a GitLab item or its notes, discussions, approvals, and pipelines as model-facing structured data. */
export async function readGitlab(commands: Commands, resource: string): Promise<unknown> {
  const commit = /^gitlab\/commits\/([0-9a-f]{7,40})\/checks$/i.exec(resource)
  if (commit) {
    const list = await readGitlabPipelines(commands)
    const selected = list.filter(item => item.sha === commit[1])
    return { head: commit[1], pipelines: selected }
  }
  const match = /^gitlab\/(issues?|merge_requests?|mrs)\/([1-9]\d*)(?:\/(notes|comments|discussions|approvals|pipelines|checks)(?:\/([^/]+))?)?$/.exec(resource)
  if (!match) throw new Error(resourceError)
  const [, type, iidText, section, pageOrDiscussion] = match
  const iid = Number(iidText)
  const kind: 'issue' | 'merge_request' = type === 'issue' || type === 'issues' ? 'issue' : 'merge_request'
  if (kind === 'issue' && ['approvals', 'pipelines', 'checks', 'discussions'].includes(section ?? '')) throw new Error('Approvals, pipelines, and discussions require a Merge Request')
  const runner = glabFor(commands)
  const endpointKind = kind === 'issue' ? 'issues' : 'merge_requests'
  if (section === 'checks') {
    if (pageOrDiscussion) throw new Error('Checks do not take a page number')
    const mr = await readGitlabMergeRequest(commands, iid)
    return readGitlabCi(commands, mr)
  }
  if (section === 'approvals') {
    if (pageOrDiscussion) throw new Error('Approvals do not take a page number')
    return runner.api(ApprovalsSchema, `${runner.projectPath}/merge_requests/${iid}/approvals`)
  }
  if (section === 'pipelines') return readGitlabMergeRequestPipelines(commands, iid)
  if (section === 'discussions') {
    if (!pageOrDiscussion) throw new Error('Name the GitLab discussion: gitlab/merge_request/<iid>/discussions/<discussion-id>')
    const discussion = await runner.api(DiscussionSchema, `${runner.projectPath}/merge_requests/${iid}/discussions/${encodeURIComponent(pageOrDiscussion)}`)
    const notes = validItems(GitlabNoteSchema, discussion.notes, DUMMY_TALLY).filter(note => !note.system)
    return { discussion_id: discussion.id, messages: notes.map(note => message(note, noteText(note))) }
  }
  if (!section) {
    if (kind === 'issue') {
      const issue: GitlabIssue = await runner.api(GitlabIssueSchema, `${runner.projectPath}/issues/${iid}`)
      return { iid: issue.iid, number: issue.iid, title: issue.title, state: issue.state,
        ...message({ id: 0, body: issue.description, author: issue.author, created_at: issue.created_at, updated_at: issue.updated_at }, issue.description ?? '', String(issue.iid)),
        url: issue.web_url }
    }
    const mr: GitlabMergeRequest = await readGitlabMergeRequest(commands, iid)
    const approvals = await runner.api(ApprovalsSchema, `${runner.projectPath}/merge_requests/${iid}/approvals`)
    return { iid: mr.iid, number: mr.iid, title: mr.title, state: mr.state, ...mr.merged_at ? { merged: true } : {},
      source_branch: mr.source_branch, target_branch: mr.target_branch, merge_status: mr.detailed_merge_status ?? mr.merge_status,
      approved: approvals.approved, approvals_required: approvals.approvals_required, approvals_left: approvals.approvals_left,
      ...message({ id: 0, body: mr.description, author: mr.author, created_at: mr.created_at, updated_at: mr.updated_at }, mr.description ?? '', String(mr.iid)),
      url: mr.web_url }
  }
  const page = Number(pageOrDiscussion ?? '1')
  if (!Number.isInteger(page) || page < 1 || page > 10000) throw new Error('The GitLab note page must be a positive integer')
  const notes = (await notesPage(runner, kind, iid, page)).filter(note => !note.system)
  const messages = notes.map(note => message(note, noteText(note)))
  return { messages, ...(notes.length === 100 ? { next_resource: `gitlab/${kind === 'issue' ? 'issue' : 'merge_request'}/${iid}/${section}/${page + 1}` } : {}) }
}

/** Bounded context reader used by assessments; note pages and inline MR discussions share the provider's thread model. */
export const gitlabThreadContext: ThreadContext<unknown> = {
  messageId: trigger => trigger.url ?? trigger.id,
  read: async (commands, trigger: Trigger, part: ContextPartName, cursor) => {
    if (typeof trigger.meta.branch === 'string') {
      const item: ContextMessage = { id: trigger.url ?? trigger.id, from: 'CI', at: trigger.at, text: trigger.text, bot: true }
      return { messages: [item], body: { status: 'pipeline', messages: [item] }, status: 'pipeline' }
    }
    const iid = Number(trigger.meta.iid ?? trigger.meta.number)
    const kind = trigger.meta.isMr === true || trigger.meta.isPr === true ? 'merge_request' : 'issue'
    if (!iid) throw new Error('GitLab Trigger has no Issue or Merge Request IID')
    if (typeof trigger.meta.discussionId === 'string') {
      const runner = glabFor(commands)
      const discussion = await runner.api(DiscussionSchema, `${runner.projectPath}/merge_requests/${iid}/discussions/${encodeURIComponent(trigger.meta.discussionId)}`)
      const notes = validItems(GitlabNoteSchema, discussion.notes).filter(note => !note.system)
      const messages = notes.map(note => message(note, noteText(note)))
      const read = part === 'thread' ? messages : messages.slice(0, 1)
      return { messages: read, body: { status: 'discussion', messages: read }, status: 'discussion' }
    }
    return conversationPage(commands, kind, iid, Number(cursor ?? '1'))
  },
}
