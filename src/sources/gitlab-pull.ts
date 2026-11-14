/** GitLab Merge Request association, lifecycle observation, and terminal notices. */
import { key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type Ticket } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import type { Commands } from '../infra/commands.ts'
import type { SourceContext } from './host.ts'
import { gitlabPage, gitlabThreadId, SOURCE, type GitlabMergeRequest } from './gitlab-trigger.ts'
import { readGitlabMergeRequest } from './gitlab-read.ts'

const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }
const MR_LOCAL = /^mr:([1-9]\d*)$/
const mrIid = (thread: string): number | undefined => {
  const match = MR_LOCAL.exec(thread.startsWith(`${SOURCE}:`) ? thread.slice(SOURCE.length + 1) : thread)
  return match ? Number(match[1]) : undefined
}
export const mergeRequestsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => mrIid(item.thread) ?? [])
export const mergeRequestOf = (ticket: Pick<Ticket, 'follows'>): number | undefined =>
  mergeRequestsOf(ticket, true).at(-1) ?? mergeRequestsOf(ticket).at(-1)

export async function readGitlabMergeRequestForContext(ctx: SourceContext, iid: number, signal?: AbortSignal): Promise<GitlabMergeRequest> {
  return readGitlabMergeRequest(ctx.commands.withSignal(signal), iid)
}

/** Binds a project Merge Request to a live ticket when it is the origin MR or the agent's ticket branch MR. */
export function claimGitlabMergeRequest(ctx: SourceContext, ticketId: string, mr: GitlabMergeRequest): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its Merge Request was closed'
  const project = ctx.deployment.activeProject
  if (!project || project.provider !== 'gitlab') return 'This ticket has no active GitLab ProjectSource'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.meta.isMr === true && Number(source.meta.iid ?? source.meta.number) === mr.iid
  const sameProject = mr.source_project_id != null && mr.target_project_id != null && mr.source_project_id === mr.target_project_id
  const opened = sameProject && sameName(mr.author.username, project.login) && ticketBranch(ticket, mr.source_branch)
  if (!started && !opened) {
    return `Merge Request does not belong to this ticket: use the source MR or an MR by ${project.login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit mr_iid when no MR exists`
  }
  const owner = ctx.tickets.open().find(item => mergeRequestsOf(item, true).includes(mr.iid))
  if (owner && owner.id !== ticketId) return 'Merge Request already belongs to another active ticket'
  const local = gitlabThreadId('merge_request', mr.iid)
  const follow = ticket.follows?.find(item => item.thread === `${SOURCE}:${local}`)
  if (mr.state === 'opened' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, mr, opened)
  return undefined
}

/** Reconciles MR closure/merge and the auto-merge fact; an agent MR binds only to a unique ticket branch owner. */
export async function observeGitlabMergeRequest(ctx: SourceContext, mr: GitlabMergeRequest): Promise<boolean> {
  const ended = mr.state === 'merged' || mr.state === 'closed' || !!mr.merged_at
  if (ended) close(ctx, mr)
  else {
    const project = ctx.deployment.activeProject
    const sameProject = mr.source_project_id != null && mr.target_project_id != null && mr.source_project_id === mr.target_project_id
    const candidates = project && sameProject && sameName(mr.author.username, project.login)
      ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, mr.source_branch)) : []
    const ticket = candidates.length === 1 ? candidates[0] : undefined
    const local = gitlabThreadId('merge_request', mr.iid)
    const reopened = ticket?.follows?.some(item => item.thread === `${SOURCE}:${local}` && item.closed)
    if (ticket && (reopened || mergeRequestsOf(ticket, true).every(iid => iid === mr.iid))) claimGitlabMergeRequest(ctx, ticket.id, mr)
  }
  ctx.threads.describe(`${SOURCE}:${gitlabThreadId('merge_request', mr.iid)}`, { facts: {
    autoMerge: !ended && mr.merge_when_pipeline_succeeds ? AUTO_MERGE_ON : null,
  } })
  return ended
}

function bind(ctx: SourceContext, ticketId: string, mr: GitlabMergeRequest, own: boolean): void {
  const thread = gitlabThreadId('merge_request', mr.iid)
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: thread }, own)
    ctx.threads.patch(`${SOURCE}:${thread}`, { number: mr.iid, iid: mr.iid, isPr: true, isMr: true, url: mr.web_url,
      prAuthor: mr.author.username, sourceBranch: mr.source_branch, targetBranch: mr.target_branch ?? '' })
  })
}
function close(ctx: SourceContext, mr: GitlabMergeRequest): void {
  if (!ctx.tickets.open().some(ticket => mergeRequestsOf(ticket, true).includes(mr.iid))) return
  const at = mr.merged_at ?? mr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id: gitlabThreadId('merge_request', mr.iid) }, mr.state === 'merged' || !!mr.merged_at ? 'merged' : 'closed', at)
}
function ticketBranch(ticket: Pick<Ticket, 'execution'>, ref: string): boolean {
  return !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
}

/** Builds terminal notices for other ticket channels and keeps host/project/source identity in the notice key. */
export function gitlabMergeRequestEndNotices(ticket: Ticket, request: string, sourceId: string, host: string, project: string): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const sourceMr = (thread: string): number | undefined => {
    const localPrefix = `${sourceId}:`
    const local = thread.startsWith(localPrefix) ? thread.slice(localPrefix.length) : sourceId === SOURCE && thread.startsWith(`${SOURCE}:`)
      ? thread.slice(SOURCE.length + 1) : ''
    const match = /^mr:([1-9]\d*)$/.exec(local)
    return match ? Number(match[1]) : undefined
  }
  const closed = (ticket.follows ?? []).filter(item => item.closed && sourceMr(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(closed.filter(item => item.own)) ?? latest(closed)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const iid = sourceMr(follow.thread)!
  const url = gitlabPage(host, project, 'merge_request', iid)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese ? outcome === 'merged' ? `[MR !${iid}](${url}) 已合并。` : `[MR !${iid}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[MR !${iid}](${url}) has merged.` : `[MR !${iid}](${url}) was closed without merging.`
  // Locally mapped GitLab channels use `gitlab`; persisted project channels may use the stable ProjectSource id.
  return ticket.channels.filter(channel => channel.source !== SOURCE && channel.source !== sourceId && !channel.source.startsWith('gitlab-')).map(channel => ({
    id: key('gitlab-mr-terminal', sourceId, String(iid), channel.source, JSON.stringify(channel.address), outcome), channel,
    text, kind: 'notice', ticketId: ticket.id,
  }))
}

/** Reads an MR through the currently project-bound Commands object. */
export const readGitlabMergeRequestForProject = (commands: Commands, iid: number): Promise<GitlabMergeRequest> => readGitlabMergeRequest(commands, iid)
