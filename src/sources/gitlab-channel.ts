/** GitLab issue and Merge Request note delivery through glab, with idempotent markers for retries. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError, validItems } from '../infra/commands.ts'
import { normalizeHost, normalizeProject } from '../project-source.ts'
import { glabFor } from '../infra/gitlab.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { GitlabNoteSchema, SOURCE, gitlabPage, type GitlabNote, type GitlabResourceKind } from './gitlab-trigger.ts'

const DiscussionSchema = z.looseObject({ id: z.string(), notes: z.array(z.unknown()) })
const missing = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410)
const locked = (error: unknown): boolean => error instanceof CliError && error.code === 403 && /locked/i.test(error.message)

/** Posts a top-level note or a reply in an MR discussion; an embedded marker makes the operation idempotent. */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const project = host.commands.deployment.activeProject
  if (!project || project.provider !== 'gitlab') throw new Error('A GitLab ProjectSource is required for note delivery')
  const address = message.channel.address
  const iid = Number(address.number)
  if (!Number.isSafeInteger(iid) || iid < 1) throw new Error('Missing GitLab reply target')
  const kind = address.kind === 'issue' ? 'issue' : address.kind === 'merge_request' ? 'merge_request' : undefined
  if (!kind) throw new Error('Missing GitLab reply target kind')
  if (typeof address.host !== 'string' || normalizeHost(address.host) !== project.host || typeof address.project !== 'string'
    || normalizeProject(address.project) !== normalizeProject(project.project)) throw new Error('GitLab reply target does not belong to the active ProjectSource')
  const runner = glabFor(host.commands)
  const endpointKind = kind === 'issue' ? 'issues' : 'merge_requests'
  const base = `${runner.projectPath}/${endpointKind}/${iid}`
  const discussionId = kind === 'merge_request' ? address.discussionId : undefined
  const discussionPath = discussionId ? `${base}/discussions/${encodeURIComponent(discussionId)}` : undefined
  const notesPath = discussionPath ? `${discussionPath}/notes` : `${base}/notes`
  const marker = `<!-- dsh-superagent:${message.id} -->`
  try {
    const notes = discussionPath
      ? validItems(GitlabNoteSchema, (await runner.api(DiscussionSchema, discussionPath)).notes)
      : await runner.pages(GitlabNoteSchema, `${notesPath}?per_page=100`)
    if (notes.some(note => note.author.username.toLowerCase() === project.login.toLowerCase() && (note.body ?? '').includes(marker))) return 'sent'
    await runner.raw(notesPath, '--method', 'POST', '--field', `body=${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (missing(error) || locked(error)) return 'gone'
    throw error
  }
}

export function gitlabAddressAllowed(address: Record<string, string>): boolean {
  return address.kind === 'issue' || address.kind === 'merge_request'
    ? !!address.number && !!address.host && !!address.project : false
}

export function gitlabLink(address: Record<string, string>, _links: ChannelLinks): ChannelLink {
  const kind: GitlabResourceKind = address.kind === 'issue' ? 'issue' : 'merge_request'
  const number = Number(address.number)
  const url = address.url || (address.host && address.project && number ? gitlabPage(address.host, address.project, kind, number) : '')
  return { url, label: kind === 'issue'
    ? { zh: `GitLab Issue #${address.number ?? ''}`, en: `GitLab Issue #${address.number ?? ''}` }
    : { zh: `GitLab MR !${address.number ?? ''}`, en: `GitLab MR !${address.number ?? ''}` } }
}
