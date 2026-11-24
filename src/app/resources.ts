/** Serves paginated context resources to orchestrator_read so large bodies stay out of model prompts until requested. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import { UserError, key, latestReport, reached, runningAssignment, threadKey, type Ticket, type Trigger } from '../core/index.ts'
import { batchOf, inputMessage, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { readGithub } from '../sources/github-read.ts'
import { readGitlab } from '../sources/gitlab-read.ts'
import { projectForTrigger } from '../project-source.ts'
import { decisionProjectId, scopedTo, threadProjectId, ticketProjectId, triggerProjectId, type ProjectScopeHost } from './project-scope.ts'
import { feishuReferences, feishuRead, feishuResource } from '../sources/feishu-read.ts'
import { feishuRef } from '../sources/feishu.ts'
import { feishuTriggerId } from '../sources/feishu-trigger.ts'
import { ASSIGNMENTS, INPUTS, assignmentLine, decisionCard, decisionDetails, inputLine, newestPage, preview, textPage, threadCard, ticketCard,
  ticketDetails, triggerCard, type TicketThread } from './cards.ts'
import { threadTitle } from './views/records.ts'
import { transcriptEntry } from './context.ts'
import { builtInParts, defaultPrompts } from './prompts.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Commands } from '../infra/commands.ts'
import type { PromptVersion, Prompts } from './prompts.ts'
import type { Sessions } from './sessions.ts'
import type { Settings } from './settings.ts'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'

/** Resource descriptors exposed via orchestrator_read, marking which resources worker sessions may also read for their own ticket. */
export const RESOURCES: readonly { name: string; holds: string; executor?: true }[] = [
  { name: 'tickets', holds: 'ticket cards, newest first; a card\'s state is person/review after a ready report, person/blocked or person/failed after those reports, person/answer with a question, person/delivery when an input could not reach the worker, working or working/queued while it works, idle once the worker ended its turn without a report, else how the ticket ended' },
  { name: 'triggers', holds: 'trigger cards with where each went, newest first' },
  { name: 'threads', holds: 'subscribed threads, newest activity first, with their labels, tickets, current assessment and polling errors' },
  { name: 'thread/<key>', holds: 'one thread: its label and link, its tickets and latest decisions, and its triggers, newest first', executor: true },
  { name: 'decisions', holds: 'decisions, newest first' },
  { name: 'decision/<id>', holds: 'one decision with its audit' },
  { name: 'ticket/<id>', holds: 'a ticket\'s card, the trigger, decision and threads it is tied to, its latest assignments with the start of each '
    + 'report, and its inputs, newest first', executor: true },
  { name: 'ticket/<id>/assignment', holds: 'its assignment text', executor: true },
  { name: 'ticket/<id>/assignments', holds: 'its assignments, newest first, with the start of each report', executor: true },
  { name: 'ticket/<id>/inputs', holds: 'its inputs, newest first', executor: true },
  { name: 'ticket/<id>/result', holds: 'its latest report', executor: true },
  { name: 'ticket/<id>/report/<id>', holds: 'the report of one of its assignments', executor: true },
  { name: 'ticket/<id>/transcript', holds: 'its Executor Session\'s messages, newest first', executor: true },
  { name: 'ticket/<id>/message/<n>', holds: 'one message of that transcript', executor: true },
  { name: 'ticket/<id>/input/<id>', holds: 'one input it was delivered', executor: true },
  { name: 'trigger/<id>', holds: 'a trigger\'s text, where it went, the message it replies to and the messages around it on its thread',
    executor: true },
  { name: 'settings', holds: 'settings by block, each with the revision a save names: the small blocks whole, the Policy and the Source '
    + 'instances summarized; project Sessions see only their own Source instance' },
  { name: 'settings/<block>', holds: 'one settings block whole, as orchestrator_settings_save takes it: policy, eval, executor, pause or '
    + 'source:<id>' },
  { name: 'prompts', holds: 'the prompt revision each Session reads, the skills, and the saved versions' },
  { name: 'prompts/<revision>', holds: 'one prompt version by number, or current, the one the Session works under', executor: true },
  { name: 'prompts/defaults', holds: 'the built-in prompt configuration, and the built-in parts by the key an override names' },
  { name: 'prompt-preview/<id>', holds: 'a composed prompt that orchestrator_prompts_save previewed' },
  { name: 'models', holds: 'model providers, the DSH default and each role\'s model' },
  { name: 'models/<provider>', holds: 'one provider\'s models' },
  { name: 'feishu/<trigger-id>/…', holds: 'a Feishu original, as the dsh-superagent-feishu skill describes', executor: true },
  { name: 'github/…', holds: 'a GitHub original in the current ProjectSource; workers are bound to their ticket project', executor: true },
  { name: 'gitlab/…', holds: 'a GitLab original in the current ProjectSource; workers are bound to their ticket project', executor: true },
  { name: 'project/<source-id>/<github|gitlab>/…', holds: 'an original in an explicitly selected project; workers can only select their own project', executor: true },
]
export const resourceGrammar = (executor: boolean, projectId?: string): string => RESOURCES.filter(resource => (!executor || resource.executor)
  && !(projectId && resource.name.startsWith('project/')))
  .map(resource => `${resource.name}: ${resource.holds}`).join('; ')

export interface ResourceHost {
  readonly store: Pick<Store, 'get' | 'settings' | 'triggers' | 'tickets' | 'threads' | 'read' | 'decisions' | 'replyStatus'>
  readonly pages: TextCache
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'skills' | 'defaultChanged'>
  readonly commands: Commands
  readonly masterId: string
  /** Session identity for per-session snapshots; workers use their Worker Session identity instead. */
  readonly sessionId?: string
  /** Set by Runtime for a project Orchestrator Session; every resource is filtered to this ProjectSource. */
  readonly projectId?: string
  readonly context: Context
  promptVersion(sessionId: string): PromptVersion
  /** Whether a Session may read `revision` (the revision it currently runs under or any revision it ran under previously). */
  mayRead(sessionId: string, revision: number): boolean
  feishuPageSize(): number
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
}
export interface MainResourceHost extends ResourceHost {
  readonly sessions: Pick<Sessions, 'status' | 'modelRetry'>
  readonly settings: Pick<Settings, 'view' | 'block'>
}
interface Read {
  host: ResourceHost; resource: string; rest: string; offset: number; limit?: number
  sessionId: string; ticketId?: string; signal?: AbortSignal
}
/** Old single-project history remains readable only while the same sole group is still an implicit legacy binding. */
function legacyFeishuHistoryAllowed(read: Read, trigger: Trigger): boolean {
  if (trigger.meta.projectBindingLegacy !== true) return false
  const config = read.host.store.settings().sources.feishu?.config
  const chats = config?.chats
  if (!Array.isArray(chats) || chats.length !== 1 || !chats[0] || typeof chats[0] !== 'object') return false
  const chat = chats[0] as Record<string, unknown>
  return chat.chatId === trigger.meta.chatId && !chat.projectSourceId
}
type Route = readonly [name: string, read: (read: Read) => unknown]

/** Enforces that main-Session-only resources cannot be read by worker Sessions. */
const main = ({ host, ticketId }: Read): MainResourceHost => {
  if (ticketId || !('settings' in host)) throw new Error('This resource belongs to the main Session')
  return host as MainResourceHost
}
const text = ({ resource, offset, limit }: Read, body: string) => textPage(resource, body, offset, limit ?? 4000)
function list<T>({ offset, limit }: Read, fetch: (offset: number, count: number) => T[]) {
  const size = Math.min(limit ?? 20, 50)
  const items = fetch(offset, size + 1)
  return { items: items.slice(0, size), next_offset: items.length > size ? offset + size : null }
}
/** Filters rows before applying the caller's page, so another project cannot affect results or pagination. */
function filteredList<T>(read: Read, fetch: (offset: number, count: number) => T[], belongs: (item: T) => boolean) {
  const size = Math.min(read.limit ?? 20, 50), wanted = read.offset + size + 1, batch = 250
  const matches: T[] = []
  let cursor = 0
  while (matches.length < wanted) {
    const page = fetch(cursor, batch)
    matches.push(...page.filter(belongs))
    cursor += page.length
    if (page.length < batch) break
  }
  const items = matches.slice(read.offset, read.offset + size)
  return { items, next_offset: matches.length > read.offset + size ? read.offset + size : null }
}
const ownsTrigger = (read: Read, value: Trigger | undefined) => scopedTo(read.host.projectId,
  triggerProjectId(read.host.commands.deployment, value, read.host.store))
function scopeHost(read: Read): ProjectScopeHost {
  return { projectId: read.host.projectId, deployment: read.host.commands.deployment, store: read.host.store }
}
const ownsTicket = (read: Read, value: Ticket | undefined) => scopedTo(read.host.projectId, ticketProjectId(scopeHost(read), value))
const ownsThread = (read: Read, value: import('../core/index.ts').Thread | undefined) => scopedTo(read.host.projectId, threadProjectId(scopeHost(read), value))
const ownsDecision = (read: Read, value: import('../core/index.ts').Decision | undefined) => scopedTo(read.host.projectId, decisionProjectId(scopeHost(read), value))
function projectTicket(read: Read, ticket: Ticket): Ticket {
  if (!read.host.projectId) return ticket
  const inputs = ticket.inputs.filter(input => input.kind === 'trigger' || input.kind === 'resumed'
    ? ownsTrigger(read, read.host.store.triggers.get(input.triggerId))
    : input.kind === 'reopen' ? ownsDecision(read, read.host.store.decisions.get(input.decisionId)) : true)
  const follows = ticket.follows?.filter(follow => ownsThread(read, read.host.store.threads.get(follow.thread)))
  const originTrigger = read.host.store.triggers.get(ticket.origin.triggerId)
  const origin = { triggerId: ownsTrigger(read, originTrigger) ? ticket.origin.triggerId : '',
    triggerIds: ticket.origin.triggerIds.filter(id => ownsTrigger(read, read.host.store.triggers.get(id))) }
  const decisionId = ownsDecision(read, read.host.store.decisions.get(ticket.decisionId)) ? ticket.decisionId : ''
  return { ...ticket, inputs, origin, ...(follows ? { follows } : {}), decisionId }
}
function assertThreadProject(read: Read, value: import('../core/index.ts').Thread | undefined): asserts value is import('../core/index.ts').Thread {
  if (!ownsThread(read, value)) throw new Error('Unknown or inaccessible thread')
}
function threadCardFor(read: Read, thread: import('../core/index.ts').Thread) {
  const card = threadCard(thread, threadTitle(read.host.store, thread))
  if (!read.host.projectId) return card
  const ticketIds = thread.subscriptions.filter(id => ownsTicket(read, read.host.store.tickets.get(id)))
  const pending = thread.pending.filter(id => ownsTrigger(read, read.host.store.triggers.get(id)))
  const { evaluating: _evaluating, ...safeCard } = card
  const evaluating = thread.evaluating?.triggerIds.every(id => ownsTrigger(read, read.host.store.triggers.get(id))) ? card.evaluating : undefined
  return { ...safeCard, ...evaluating ? { evaluating } : {}, tickets: ticketIds, pending: pending.length }
}
function settingsView(read: Read) {
  const settings = main(read).settings.view()
  if (!read.host.projectId) return settings
  return { project_source_id: read.host.projectId, sources: settings.sources.filter(source => source.id === read.host.projectId) }
}
function settingsBlock(read: Read) {
  if (read.host.projectId && read.rest !== `source:${read.host.projectId}`) throw new Error('Project Sessions may only read their own Source settings')
  return text(read, JSON.stringify(main(read).settings.block(read.rest)))
}
function triggerDisposition(read: Read, trigger: Trigger, ticket?: Ticket) {
  const disposition = read.host.store.triggers.disposition(trigger.id)
  if (!disposition) return undefined
  if (ticket) return { ...disposition, decisionId: undefined, fanout: disposition.fanout.filter(id => id === ticket.id),
    handbacks: (disposition.handbacks ?? []).filter(item => item.ticketId === ticket.id) }
  if (!read.host.projectId) return disposition
  return { ...disposition,
    decisionId: disposition.decisionId && ownsDecision(read, read.host.store.decisions.get(disposition.decisionId)) ? disposition.decisionId : undefined,
    fanout: disposition.fanout.filter(id => ownsTicket(read, read.host.store.tickets.get(id))),
    handbacks: (disposition.handbacks ?? []).filter(item => ownsTicket(read, read.host.store.tickets.get(item.ticketId))) }
}
/** Check whether a worker session's ticket is authorized to read a trigger (via delivery, ticket origin, or followed thread). */
const readable = (host: ResourceHost, ticket: Ticket, trigger: Trigger): boolean => reached(ticket, trigger, key => host.store.threads.get(key))
  || ticket.origin.triggerIds.includes(trigger.id) || trigger.threads.some(ref => ticket.follows?.some(follow => follow.thread === threadKey(ref)))
const trigger = (host: ResourceHost, id: string, ticketId?: string): Trigger => {
  const found = host.store.triggers.get(id)
  if (!found) throw new UserError('unknownTrigger')
  const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
  if (ticketId && (!ticket || !readable(host, ticket, found))) throw new UserError('notReached')
  if (!scopedTo(host.projectId, triggerProjectId(host.commands.deployment, found, host.store))) throw new UserError('unknownTrigger')
  return found
}
/** Fetch and cache a source resource on offset 0, serving subsequent offsets from the session cache. */
async function sourcePage(read: Read, source: string, fetch: () => Promise<unknown>) {
  const { host, resource, offset, sessionId } = read
  const body = offset === 0 ? JSON.stringify(await fetch()) : host.pages.get(`${sessionId}:${resource}`)
  if (body === undefined) throw new Error(`Read this ${source === 'feishu' ? 'Feishu' : 'GitHub'} resource from offset 0 first`)
  if (offset === 0) host.pages.set(`${sessionId}:${resource}`, body)
  return text(read, body)
}
/** 项目选择在读取入口完成；项目编排会话和 Worker 都不能通过资源路径切换到其他项目。 */
function projectCommands(read: Read, source?: string): Commands {
  const ticket = read.ticketId ? read.host.store.tickets.get(read.ticketId) : undefined
  const origin = ticket ? read.host.store.triggers.get(ticket.origin.triggerId) : undefined
  const deployment = read.host.commands.deployment
  if (read.host.projectId && source) throw new Error('Project Sessions use their bound ProjectSource without a selector')
  if (read.host.projectId && deployment.projects && !deployment.projects[read.host.projectId]) throw new Error('The project has not completed setup')
  if (read.host.projectId && ticket && !ownsTicket(read, ticket)) throw new UserError('unknownTicket')
  if (source && deployment?.projects && !deployment.projects[source]) throw new Error('The project has not completed setup')
  if (!read.host.projectId && !ticket && !source && Object.keys(deployment?.projects ?? {}).length > 1) throw new Error('Select a project explicitly with project/<source-id>/…')
  const ticketProject = ticket ? ticketProjectId(scopeHost(read), ticket) : undefined
  if (ticket && !ticketProject) throw new UserError('unknownTicket')
  if (source && ticket && source !== ticketProject) throw new Error('The project does not belong to this ticket')
  const selected = !read.host.projectId && !source && !ticket && Object.keys(deployment?.projects ?? {}).length === 1
    ? projectForTrigger(deployment) : undefined
  const id = source ?? read.host.projectId ?? ticketProject ?? selected?.id ?? origin?.source
  if (id && deployment.projects && !deployment.projects[id]) throw new Error('The project has not completed setup')
  return (id ? read.host.commands.forSource?.(id) ?? read.host.commands : read.host.commands).withSignal(read.signal)
}
async function projectPage(read: Read, provider: 'github' | 'gitlab', resource: string, source?: string) {
  const commands = projectCommands(read, source)
  const active = commands.deployment?.activeProject
  if (active && active.provider !== provider) throw new Error('Resource provider does not match this project')
  return sourcePage(read, provider, async () => {
    const result: unknown = provider === 'github' ? await readGithub(commands, resource) : await readGitlab(commands, resource)
    if (source && result && typeof result === 'object' && 'next_resource' in result && typeof result.next_resource === 'string') {
      return { ...result, next_resource: `project/${source}/${result.next_resource}` }
    }
    return result
  })
}
const THREAD_DECISIONS = 5
const triggerLine = (trigger: Trigger) => ({ trigger_id: trigger.id, actor: trigger.actor.id, human: trigger.human, at: trigger.at,
  preview: preview(trigger.text), chars: trigger.text.length, read: `trigger/${trigger.id}` })
async function transcript(host: ResourceHost, ticketId: string) {
  return (await host.context.sessionController.inspect(workerSessionId(ticketId) as SessionId)).events
}

const ROUTES: readonly Route[] = [
  ['tickets', read => {
    const host = main(read)
    const card = (ticket: Ticket) => ({ ...ticketCard(ticket), ...host.sessions.modelRetry(runningAssignment(ticket) && workerSessionId(ticket.id)) })
    const tickets = host.store.tickets.list()
    const page = filteredList(read, (offset, count) => tickets.slice(offset, offset + count), ticket => ownsTicket(read, ticket))
    return { ...page, items: page.items.map(card) }
  }],
  ['triggers', read => {
    const { store } = main(read)
    const page = filteredList(read, (offset, count) => store.read.recentTriggers(offset, count), item => ownsTrigger(read, item))
    return { ...page, items: page.items.map(item => triggerCard(item, triggerDisposition(read, item))) }
  }],
  ['threads', read => {
    const { store } = main(read)
    const threads = store.read.subscribedThreads().sort((a, b) => (b.lastAt ?? b.createdAt).localeCompare(a.lastAt ?? a.createdAt))
    const page = filteredList(read, (offset, count) => threads.slice(offset, offset + count), thread => ownsThread(read, thread))
    return { ...page, items: page.items.map(thread => threadCardFor(read, thread)) }
  }],
  ['thread/', read => {
    const { host, rest, ticketId } = read
    const thread = host.store.threads.get(rest)
    const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
    // Worker Sessions may only read threads their own ticket subscribes to or follows.
    if (!thread || (ticketId && !(thread.subscriptions.includes(ticketId) || ticket?.follows?.some(follow => follow.thread === rest)))) {
      throw new Error('Unknown or inaccessible thread')
    }
    if (!ticketId) assertThreadProject(read, thread)
    const { store } = host
    const { read: _read, tickets: ids, ...card } = threadCardFor(read, thread)
    const page = read.host.projectId
      ? filteredList(read, (offset, count) => store.read.threadPage(thread.key, offset, count), item => ownsTrigger(read, item))
      : list(read, (offset, count) => store.read.threadPage(thread.key, offset, count))
    const triggerItems = page.items.map(triggerLine)
    // Worker sessions cannot inspect other tickets or decisions on a shared thread.
    if (ticketId) return { ...card, items: triggerItems, next_offset: page.next_offset }
    const tickets = ids.flatMap(id => { const found = store.tickets.get(id); return found && ownsTicket(read, found) ? [ticketCard(found)] : [] })
    const decisions = store.decisions.byThread(thread.key).filter(decision => ownsDecision(read, decision)).slice(-THREAD_DECISIONS).reverse().map(decisionCard)
    return { ...card, tickets, decisions, items: triggerItems, next_offset: page.next_offset }
  }],
  ['decisions', read => {
    const { store } = main(read)
    const page = filteredList(read, (offset, count) => store.read.recentDecisions(offset, count), decision => ownsDecision(read, decision))
    return { ...page, items: page.items.map(decisionCard) }
  }],
  ['decision/', read => {
    const decision = main(read).store.decisions.get(read.rest)
    if (!decision || !ownsDecision(read, decision)) throw new Error('Unknown decision')
    return decisionDetails(decision)
  }],
  ['settings', read => settingsView(read)],
  ['settings/', read => settingsBlock(read)],
  ['prompts', read => {
    const host = main(read), current = host.prompts.current(), status = host.sessions.status()
    const history = host.prompts.history(read.offset, Math.min(read.limit ?? 20, 50)), skills = host.prompts.skills(current.config).map(([name]) => name)
    // The built-in parts whose text changed since the team overrode them, and those this version no longer has, which the
    // panel shows and the next save drops.
    const changes = host.prompts.defaultChanged(current.config)
    const changed = changes.filter(item => !item.removed).map(item => item.part)
    const removed = changes.filter(item => item.removed).map(item => item.part)
    return { revision: status.revision, read: `prompts/${current.revision}`, notification_pending: status.notificationPending,
      ...changed.length ? { default_changed: changed } : {}, ...removed.length ? { removed_parts: removed } : {},
      sessions: status.sessions.filter(session => !read.host.projectId || session.sessionId === read.sessionId)
        .map(session => ({ session_id: session.sessionId, revision: session.revision })),
      skills: { built_in: skills.filter(name => !(name in current.config.skills)).map(name => `dsh-superagent-${name}`),
        team: Object.keys(current.config.skills).map(name => `dsh-superagent-${name}`) },
      items: history.revisions.map(({ previousRevision, savedAt, ...version }) =>
        ({ ...version, previous_revision: previousRevision, saved_at: savedAt })),
      next_offset: history.next_offset }
  }],
  // A worker Session may read only its current prompt revision and revisions it previously ran under.
  ['prompts/', read => {
    const { host, resource, rest, sessionId, ticketId } = read
    const prompts = host.prompts
    const bound = host.promptVersion(sessionId)
    const parts = () => Object.fromEntries(Object.entries(builtInParts()).map(([key, part]) => [key, part.text]))
    const version = rest === 'current' ? bound : rest === 'defaults' && !ticketId ? { revision: 0, config: defaultPrompts(), parts: parts() }
      : /^\d+$/.test(rest) ? (Number(rest) === 0 && prompts.current().revision === 0 ? prompts.current() : prompts.version(Number(rest))) : undefined
    if (!version || (ticketId && !host.mayRead(sessionId, version.revision))) throw new Error('Unknown or inaccessible prompt version')
    return text({ ...read, resource: rest === 'current' ? `prompts/${version.revision}` : resource }, JSON.stringify(version))
  }],
  ['prompt-preview/', read => {
    const body = main(read).pages.get(`${read.sessionId}:${read.resource}`)
    if (body === undefined) throw new Error('Unknown preview for this Session')
    return text(read, body)
  }],
  ['models', async read => {
    const host = main(read), catalog = await host.context.sessionController.modelCatalog(), settings = host.store.settings()
    const roles = { orchestrator: settings.eval.model, worker: settings.executor.model }
    return { default: catalog.default, roles, failures: catalog.failures,
      providers: catalog.groups.map(group => ({ id: group.id, name: group.name, count: group.models.length, read: `models/${group.id}` })) }
  }],
  ['models/', async read => {
    const models = (await main(read).context.sessionController.modelCatalog()).groups.find(group => group.id === read.rest)?.models
    if (!models) throw new Error('Unknown model provider')
    return list(read, (offset, count) => models.slice(offset, offset + count))
  }],
  ['feishu/', async read => {
    const request = feishuResource(read.resource)
    const source = trigger(read.host, request.triggerId, read.ticketId)
    const ref = feishuRef(source)
    if (!ref) throw new Error('A Feishu source trigger is required')
    const commands = read.host.commands.withSignal(read.signal)
    const legacyHistory = legacyFeishuHistoryAllowed(read, source)
    return sourcePage(read, 'feishu', async () => {
      const result = await feishuRead(commands, ref, read.resource, read.host.feishuPageSize(), legacyHistory)
      if (result.status !== 'project_scoped_history_unavailable' || !read.host.projectId) return result
      const { store } = read.host
      const domainThread = source.threads[0]
      if (!domainThread) return result
      const thread = threadKey(domainThread)
      const related = (messageId: unknown) => {
        if (typeof messageId !== 'string') return undefined
        const item = store.triggers.get(feishuTriggerId(messageId))
        return item?.meta.chatId === ref.chatId && item.threads.some(value => threadKey(value) === thread) && ownsTrigger(read, item) ? item : undefined
      }
      const message = (item: Trigger) => ({ id: String(item.meta.messageId), from: item.actor.id, at: item.at, text: item.text,
        ...item.url ? { url: item.url } : {} })
      if (request.section === 'root' || request.section === 'parent') {
        const item = related(source.meta[`${request.section}Id`])
        return item ? { status: 'available', message: message(item) } : result
      }
      if (request.section !== 'thread') return result
      const offset = Number(request.cursor ?? 0)
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid project thread cursor')
      const page = filteredList({ ...read, offset, limit: read.host.feishuPageSize() },
        (from, count) => store.read.threadPage(thread, from, count), item => item.meta.chatId === ref.chatId && ownsTrigger(read, item))
      return { status: 'available', messages: page.items.map(message), next_resource: page.next_offset === null ? null
        : `feishu/${ref.triggerId}/thread/${page.next_offset}` }
    })
  }],
  ['github/', read => projectPage(read, 'github', read.resource)],
  ['gitlab/', read => projectPage(read, 'gitlab', read.resource)],
  ['project/', read => {
    const [source, provider, ...path] = read.rest.split('/')
    if (!source || (provider !== 'github' && provider !== 'gitlab') || !path.length) throw new Error('Use project/<source-id>/<github|gitlab>/…')
    return projectPage(read, provider, `${provider}/${path.join('/')}`, source)
  }],
  ['trigger/', async read => {
    const { host, rest, ticketId, offset, signal } = read
    if (!rest) throw new Error('Unknown context resource')
    const found = trigger(host, rest, ticketId)
    const ref = feishuRef(found)
    // Redact decision IDs, other tickets, and unreachable neighbour triggers when a worker session reads a trigger.
    const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
    const shown = (item: Trigger | undefined) => item && ownsTrigger(read, item) && (!ticket || readable(host, ticket, item)) ? item : undefined
    const visible = triggerDisposition(read, found, ticket)
    // Omit card preview and self-reference because this resource returns the full text.
    const { preview: _preview, chars: _chars, read: _read, ...card } = triggerCard(found, visible)
    const parent = found.source === 'feishu' && typeof found.meta.parentId === 'string' ? found.meta.parentId : undefined
    const repliedTo = shown(parent ? host.store.triggers.get(feishuTriggerId(parent)) : undefined)
    const neighbours = host.store.read.neighbours(threadKey(found.threads[0]!), found.at, found.id)
    const around = { before: shown(neighbours.before), after: shown(neighbours.after) }
    const legacyHistory = ref ? legacyFeishuHistoryAllowed(read, found) : false
    return { ...card, ...await host.sourceLink(found, signal), acknowledgement: host.store.replyStatus(key('ack', found.id)) ?? 'not_requested',
      ...(ref ? { context: feishuReferences(ref, legacyHistory) } : {}),
      ...(offset === 0 ? {
        ...repliedTo ? { replied_to: triggerLine(repliedTo) } : {},
        around: { ...around.before ? { before: triggerLine(around.before) } : {}, ...around.after ? { after: triggerLine(around.after) } : {} },
      } : {}),
      ...text(read, found.text) }
  }],
  ['ticket/', async read => {
    const { host, resource, rest, ticketId, signal } = read
    const [id, section, part, ...more] = rest.split('/')
    if (!id || more.length) throw new Error('Unknown context resource')
    if (ticketId && ticketId !== id) throw new Error('Ticket does not belong to this worker')
    const stored = host.store.tickets.get(id)
    if (!ownsTicket(read, stored)) throw new UserError('unknownTicket')
    const ticket = projectTicket(read, stored!)
    if (section === undefined) {
      const running = runningAssignment(ticket) && workerSessionId(ticket.id)
      const retry = 'sessions' in host ? (host as MainResourceHost).sessions.modelRetry(running) : {}
      // Merge subscribed threads (including context-only subscriptions) and source-bound threads without duplicates.
      const bound = new Set((ticket.follows ?? []).map(follow => follow.thread))
      const subscribed = host.store.read.subscribedThreads().filter(thread => thread.subscriptions.includes(id))
      const marked = (key: string, context: boolean): TicketThread =>
        ({ thread: key, ...context ? { context: true } : {}, ...bound.has(key) ? { bound: true } : {} })
      const threads = [...subscribed.filter(thread => ownsThread(read, thread)).map(thread => marked(thread.key, !!thread.context?.includes(id))),
        ...[...bound].filter(key => !subscribed.some(thread => thread.key === key))
          .filter(key => ownsThread(read, host.store.threads.get(key))).map(key => marked(key, false))]
      const batch = batchOf(host, ticket).filter(trigger => ownsTrigger(read, trigger))
      return { ...ticketDetails(ticket, threads, batch, !!ticketId), ...retry }
    }
    if (section === 'assignments' || section === 'inputs') {
      if (part !== undefined) throw new Error('Unknown context resource')
      const size = Math.min(read.limit ?? (section === 'assignments' ? ASSIGNMENTS : INPUTS), 50)
      const { items, next_offset } = section === 'assignments'
        ? newestPage(ticket.assignments, read.offset, size, item => assignmentLine(ticket, item), resource)
        : newestPage(ticket.inputs, read.offset, size, input => inputLine(ticket, input, !!ticketId), resource)
      return { items, next_offset: next_offset ?? null }
    }
    let body: string
    if (section === 'input' && part) {
      // Render the input on demand with its resolved source link, matching either its short key or full input ID.
      const input = ticket.inputs.find(item => key(item.id) === part || item.id === part)
      const trigger = input?.kind === 'trigger' ? host.store.triggers.get(input.triggerId) : undefined
      if (input?.kind === 'trigger' && !ownsTrigger(read, trigger)) throw new Error('Unknown ticket input')
      if (input?.kind === 'reopen' && !ownsDecision(read, host.store.decisions.get(input.decisionId))) throw new Error('Unknown ticket input')
      const card = trigger && input?.kind === 'trigger' ? triggerMessage(trigger, await host.sourceLink(trigger, signal), input.note) : undefined
      const message = input && inputMessage(input, card)
      if (message === undefined) throw new Error('Unknown ticket input')
      body = message
    } else if (section === 'message' && part && /^\d+$/.test(part)) {
      const event = (await transcript(host, id))[Number(part)]
      const entry = event && transcriptEntry(event)
      if (!entry) throw new Error('Unknown transcript entry')
      body = JSON.stringify(entry)
    } else if (section === 'report' && part) {
      const report = ticket.assignments.find(item => item.id === part)?.report
      if (!report) throw new Error('Unknown assignment report')
      body = report.summary
    } else if (part !== undefined) throw new Error('Unknown context resource')
    else if (section === 'assignment') body = ticket.execution?.assignment ?? ''
    else if (section === 'result') body = latestReport(ticket)?.summary ?? ''
    else if (section === 'transcript') {
      body = (await transcript(host, id)).flatMap((event, index) => {
        const entry = transcriptEntry(event)
        const said = entry?.message.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join(' ') ?? ''
        return entry ? [{ type: entry.type, preview: preview(said).slice(0, 80), chars: JSON.stringify(entry).length,
          read: `ticket/${id}/message/${index}` }] : []
      }).reverse().map(event => JSON.stringify(event)).join('\n')
    } else throw new Error('Unknown context resource')
    return text(read, body)
  }],
]

/**
 * Read a paginated resource for the main Session or a ticket's worker Session.
 * Legacy prefixes (`event/`, `task/`, `observation/`) remain accepted so references in older Session history stay readable.
 */
export async function readResource(host: ResourceHost, resource: string, offset: number, limit: number | undefined, ticketId?: string,
  signal?: AbortSignal) {
  const name = resource.replace(/^event\//, 'trigger/').replace(/^task\//, 'ticket/').replace(/^observation\//, 'decision/')
  const route = ROUTES.find(([route]) => route.endsWith('/') ? name.startsWith(route) : name === route)
  if (!route) throw new Error('Unknown context resource')
  const sessionId = ticketId ? workerSessionId(ticketId) : host.sessionId ?? host.masterId
  const rest = route[0].endsWith('/') ? name.slice(route[0].length) : ''
  return route[1]({ host, resource: name, rest, offset, sessionId, ...limit ? { limit } : {}, ...ticketId ? { ticketId } : {},
    ...signal ? { signal } : {} })
}
