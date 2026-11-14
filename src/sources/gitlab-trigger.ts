/** Normalizes GitLab Issues, Merge Requests, notes, approvals, and pipelines into project-local Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitlab'
export type GitlabResourceKind = 'issue' | 'merge_request'

export const GitlabUserSchema = z.looseObject({ id: z.number().int().optional(), username: z.string(), name: z.string().optional(), bot: z.boolean().optional() })
export const GitlabIssueSchema = z.looseObject({ iid: z.number().int().positive(), title: z.string(), description: z.string().nullish(),
  state: z.string(), created_at: z.string(), updated_at: z.string().optional(), web_url: z.string(), author: GitlabUserSchema })
export type GitlabIssue = z.infer<typeof GitlabIssueSchema>
export const GitlabMergeRequestSchema = z.looseObject({ iid: z.number().int().positive(), title: z.string(), description: z.string().nullish(),
  id: z.number().int().positive().optional(), source_project_id: z.number().int().positive().nullish(), target_project_id: z.number().int().positive().nullish(),
  state: z.string(), created_at: z.string().optional(), updated_at: z.string().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(),
  web_url: z.string(), author: GitlabUserSchema, source_branch: z.string(), target_branch: z.string().optional(), sha: z.string().optional(),
  merge_status: z.string().optional(), detailed_merge_status: z.string().optional(), merge_when_pipeline_succeeds: z.boolean().optional(),
  head_pipeline: z.looseObject({ id: z.number(), status: z.string(), web_url: z.string().optional(), sha: z.string().optional() }).nullish() })
export type GitlabMergeRequest = z.infer<typeof GitlabMergeRequestSchema>
export const GitlabNoteSchema = z.looseObject({ id: z.number().int().positive(), body: z.string().nullish(), author: GitlabUserSchema,
  created_at: z.string().nullish(), updated_at: z.string().nullish(), system: z.boolean().optional(), url: z.string().nullish(),
  discussion_id: z.string().nullish(), position: z.looseObject({ new_path: z.string().optional(), new_line: z.number().optional(),
    old_path: z.string().optional(), old_line: z.number().optional() }).nullish() })
export type GitlabNote = z.infer<typeof GitlabNoteSchema>
export const GitlabPipelineSchema = z.looseObject({ id: z.number().int().positive(), status: z.string(), ref: z.string(), sha: z.string(),
  created_at: z.string().optional(), updated_at: z.string().optional(), web_url: z.string().optional() })
export type GitlabPipeline = z.infer<typeof GitlabPipelineSchema>

export const gitlabThreadId = (kind: GitlabResourceKind, iid: number): string => `${kind === 'issue' ? 'issue' : 'mr'}:${iid}`
export const gitlabThreadKey = (kind: GitlabResourceKind, iid: number): string => `${SOURCE}:${gitlabThreadId(kind, iid)}`
export const gitlabPage = (host: string, project: string, kind: GitlabResourceKind, iid: number): string =>
  `https://${host}/${project}/-/${kind === 'issue' ? 'issues' : 'merge_requests'}/${iid}`

/** GitLab's issue and merge-request IIDs can overlap, so the type is part of the persisted Thread identity. */
export function gitlabChannel(host: string, project: string, kind: GitlabResourceKind, iid: number,
  extra: { url?: string; discussionId?: string } = {}): ChannelRef {
  return { source: SOURCE, thread: gitlabThreadKey(kind, iid), address: {
    number: String(iid), kind, host, project,
    ...(extra.url ? { url: extra.url } : {}),
    ...(extra.discussionId ? { discussionId: extra.discussionId } : {}),
  } }
}

export const mentions = (text: string, username: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(username)}(?![a-zA-Z0-9_-])`, 'i').test(text)
const isBot = (user: z.infer<typeof GitlabUserSchema>): boolean => user.bot === true || /\[bot\]$/i.test(user.username)
const actor = (user: z.infer<typeof GitlabUserSchema>, agent: string) => ({ actor: { source: SOURCE, id: user.username },
  human: !isBot(user) && !sameName(user.username, agent) })
const openedText = (title: string, description: string | null | undefined): string => `${title}\n\n${description ?? ''}`

export function issueTrigger(issue: GitlabIssue, agent: string, host: string, project: string): Trigger {
  const body = issue.description ?? ''
  return { id: key('gitlab-issue', String(issue.iid)), source: SOURCE,
    threads: [{ source: SOURCE, id: gitlabThreadId('issue', issue.iid) }], ...actor(issue.author, agent), at: issue.created_at,
    text: openedText(issue.title, body), ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(host, project, 'issue', issue.iid, { url: issue.web_url }), url: issue.web_url,
    meta: { iid: issue.iid, number: issue.iid, kind: 'issue', isPr: false, title: issue.title } }
}

export function mergeRequestTrigger(mr: GitlabMergeRequest, agent: string, host: string, project: string): Trigger {
  const body = mr.description ?? ''
  return { id: key('gitlab-mr', String(mr.iid)), source: SOURCE,
    threads: [{ source: SOURCE, id: gitlabThreadId('merge_request', mr.iid) }], ...actor(mr.author, agent), at: mr.created_at ?? new Date().toISOString(),
    text: openedText(mr.title, body), ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(host, project, 'merge_request', mr.iid, { url: mr.web_url }), url: mr.web_url,
    meta: { iid: mr.iid, number: mr.iid, kind: 'merge_request', isPr: true, isMr: true, title: mr.title,
      sourceBranch: mr.source_branch, targetBranch: mr.target_branch ?? '' } }
}

export function noteTrigger(note: GitlabNote, ref: { iid: number; kind: GitlabResourceKind; url?: string },
  detail: { host: string; project: string; discussionId?: string; path?: string; line?: number } , agent: string): Trigger {
  const body = note.body ?? ''
  const at = note.updated_at ?? note.created_at ?? new Date().toISOString()
  const path = detail.path ?? note.position?.new_path ?? note.position?.old_path
  const line = detail.line ?? note.position?.new_line ?? note.position?.old_line
  const url = note.url
  const text = [path ? `${path}${line != null ? `:${line}` : ''}` : '', body].filter(Boolean).join('\n\n')
  return { id: key('gitlab-note', ref.kind, String(ref.iid), String(note.id), at), source: SOURCE,
    threads: [{ source: SOURCE, id: gitlabThreadId(ref.kind, ref.iid) }], ...actor(note.author, agent), at, text,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(detail.host, detail.project, ref.kind, ref.iid, { ...(url ?? ref.url ? { url: url ?? ref.url } : {}),
      ...(detail.discussionId ?? note.discussion_id ? { discussionId: detail.discussionId ?? note.discussion_id! } : {}) }),
    ...(url ? { url } : {}), meta: { iid: ref.iid, number: ref.iid, kind: path ? 'inline' : 'conversation',
      isPr: ref.kind === 'merge_request', isMr: ref.kind === 'merge_request', noteId: note.id,
      ...(note.discussion_id ? { discussionId: note.discussion_id } : {}), ...(path ? { path } : {}), ...(line != null ? { line } : {}) } }
}

/** Emits a stable user-visible change when a Merge Request approval state changes. */
export function approvalTrigger(mr: GitlabMergeRequest, approved: boolean, revision: number, host: string, project: string,
  approver?: z.infer<typeof GitlabUserSchema>): Trigger {
  const actorValue = approver && !isBot(approver) ? { actor: { source: SOURCE, id: approver.username }, human: true }
    : { actor: { source: SOURCE, id: '' }, human: false }
  const text = approved ? `Merge Request !${mr.iid} was approved.` : `Approval was removed from Merge Request !${mr.iid}.`
  return { id: key('gitlab-approval', String(mr.iid), String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: gitlabThreadId('merge_request', mr.iid) }], ...actorValue, at: new Date().toISOString(), text,
    channel: gitlabChannel(host, project, 'merge_request', mr.iid, { url: mr.web_url }), url: mr.web_url,
    meta: { iid: mr.iid, number: mr.iid, kind: 'approval', isPr: true, isMr: true, approved, revision } }
}

export function pipelineTrigger(pipeline: GitlabPipeline, revision: number, host: string, project: string,
  mr?: GitlabMergeRequest, projectObserved = false): Trigger {
  const mrId = mr ? gitlabThreadId('merge_request', mr.iid) : `ci:${pipeline.ref}`
  const summary = `Pipeline ${pipeline.status} on ${pipeline.ref} at ${pipeline.sha.slice(0, 7)}.`
  return { id: key('gitlab-pipeline', mr ? String(mr.iid) : `branch:${pipeline.ref}`, String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: mrId }], actor: { source: SOURCE, id: '' }, human: false, at: pipeline.updated_at ?? pipeline.created_at ?? new Date().toISOString(),
    text: summary, ...(mr ? { channel: gitlabChannel(host, project, 'merge_request', mr.iid, { url: pipeline.web_url ?? mr.web_url }) } : {}),
    ...(pipeline.web_url ? { url: pipeline.web_url } : {}), meta: { ...(mr ? { iid: mr.iid, number: mr.iid, isPr: true, isMr: true } : { branch: pipeline.ref }),
      kind: 'pipeline', ci: true, projectPipeline: projectObserved, sha: pipeline.sha, status: pipeline.status, revision } }
}

/** Parses an Issue/MR URL belonging to the configured host and project. */
export function gitlabAddress(url: string, host: string, project: string): { iid: number; kind: GitlabResourceKind } | undefined {
  const prefix = `https://${host}/${project}/-/`
  if (!url.toLowerCase().startsWith(prefix.toLowerCase())) return undefined
  const match = /^https:\/\/[^/]+\/.+\/-\/(issues|merge_requests)\/(\d+)(?:#.*)?\/?$/i.exec(url)
  if (!match) return undefined
  return { iid: Number(match[2]), kind: match[1]!.toLowerCase() === 'issues' ? 'issue' : 'merge_request' }
}
