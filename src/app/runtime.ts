/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, key, reasonText, latestReport, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { gitlabMergeRequestEndNotices } from '../sources/gitlab-pull.ts'
import { createLocalReporter, type LocalReporter } from '../reporter/local-reporter.ts'
import type { ReporterRuntimeSnapshot } from '../reporter/protocol.ts'
import { ReporterAutonomousRuns, type ReporterAutonomousHost, type ReporterReadOnlyProbe } from '../reporter/autonomous.ts'
import { createReporterBrowserDriver } from '../reporter/browser.ts'
import { createReporterModelInvoker, resolveReporterModel } from '../reporter/dsh-model.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'
import type { TriggerContext } from '../sources/kind.ts'
import { projectForTrigger } from '../project-source.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly reporter?: LocalReporter
  readonly reporterRuns?: ReporterAutonomousRuns
  private readonly reporterToken?: string
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu,
        () => Object.entries(store.settings().sources).some(([id, source]) => (source.kind ?? id) === 'gitlab' && source.enabled))
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        lifetime: this.lifetime,
        closing: () => this.closing(), environment,
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => this.reporterThreadContext(trigger) ?? sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused(),
        capture: message => this.reporter?.capture(message) ?? false })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          if (this.reporter) store.afterCommit(() => this.reporter?.observe(event))
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            const follow = ended.follows?.filter(item => item.closed).sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
            const id = follow?.thread.split(':')[0] ?? sourceTrigger(this, ended)?.source ?? 'github'
            const project = setup.deployment.projects?.[id]
            if (project?.provider === 'gitlab') {
              for (const message of gitlabMergeRequestEndNotices(ended, request, id, project.host, project.project)) outbox.send(message)
            } else {
              const context = this.context({ kind: 'github', id, health: [] })
              const local = context.tickets.get(ended.id) ?? ended
              for (const message of pullEndNotices(local, request, context.deployment.repository)) context.notify(message)
            }
          }
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      if (process.env.DSH_SUPERAGENT_REPORTER_ENABLED === '1') {
        const token = process.env.DSH_SUPERAGENT_REPORTER_TOKEN
        if (!token || token.length < 32) throw new Error('启用本地 Reporter 需要至少 32 字符的 DSH_SUPERAGENT_REPORTER_TOKEN')
        this.reporterToken = token
        this.reporter = createLocalReporter({ stateDir: machine.stateDir, enabled: true,
          resolveProject: id => {
            if (!setup.configured() || !sources.instance(id)?.enabled) return undefined
            const project = setup.deployment.projects?.[id]
            if (project) return project
            return id === 'github' ? { id, provider: 'github', host: 'github.com', project: setup.deployment.repository } : undefined
          }, receive: trigger => this.receive(trigger), lookup: id => {
            if (!store.triggers.get(id)) return undefined
            return store.triggers.disposition(id)?.filtered ? 'filtered' : 'stored'
          }, snapshot: (_scenario, ids) => this.reporterSnapshot(ids) })
        const resolveReporterProject: ReporterAutonomousHost['resolveProject'] = id => {
          if (!setup.configured() || !sources.instance(id)?.enabled) return undefined
          const project = setup.deployment.projects?.[id]
          if (project) return project
          return id === 'github' ? { id, provider: 'github', host: 'github.com', project: setup.deployment.repository } : undefined
        }
        const browserEnabled = process.env.DSH_SUPERAGENT_REPORTER_BROWSER === '1'
        const browser = browserEnabled ? {
          create: (signal: AbortSignal) => {
            // DSH owns both the listener origin and the short-lived browser login URL.
            // Keep its token inside the browser driver's initial navigation only.
            const host = this.ctx as unknown as { connection?: { authenticatedUrl(origin: string): string | Promise<string> } }
            const webServer = this.ctx.webServer as typeof this.ctx.webServer & { getOrigin?: () => string }
            const origin = webServer.getOrigin?.() ?? `${webServer.protocol}//${webServer.host}:${webServer.port}`
            if (!host.connection?.authenticatedUrl) throw new Error('DSH connection browser authentication is unavailable')
            return createReporterBrowserDriver({ expectedOrigin: origin, getAuthenticatedUrl: () => {
              const url = host.connection!.authenticatedUrl(origin)
              if (typeof url !== 'string') throw new Error('DSH browser authentication URL must be synchronous')
              return url
            }, signal })
          },
        } : undefined
        this.reporterRuns = new ReporterAutonomousRuns({ reporter: this.reporter, enabled: true,
          resolveProject: resolveReporterProject,
          allowedActors: id => resolveReporterProject(id) ? store.settings().policy.sources[id]?.allowed.map(actor => actor.id) ?? [] : [],
          safeState: id => this.reporterSafeState(id, resolveReporterProject),
          resolveModel: async () => {
            const route = await resolveReporterModel(ctx)
            return { ...route, invoke: createReporterModelInvoker(ctx, route) }
          },
          waitForSuperagent: (scenarioId, signal) => this.waitForReporterTarget(scenarioId, signal),
          probeReadOnly: (probe, signal) => this.probeReporterReadOnly(probe, signal),
          ...(browser ? { browser } : {}), lifetime: this.lifetime, stateDir: machine.stateDir })
      }
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        sourceContext: ticket => {
          const origin = sourceTrigger(this, ticket)
          const project = projectForTrigger(setup.deployment, origin)
          return this.context({ kind: project?.provider ?? 'github', id: project?.id ?? 'github', health: [] })
        },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[]; id?: string }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  private reporterThreadContext(trigger: Trigger): TriggerContext | undefined {
    if (!this.reporter || trigger.channel?.source !== 'local-reporter') return undefined
    return { messageId: trigger.id, images: () => [], image: async () => { throw new Error('Reporter 没有图片附件') },
      read: async (_commands, part) => {
        const thread = trigger.threads[0]
        const history = thread ? this.store.read.threadTriggers(`${thread.source}:${thread.id}`, 100)
          .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)) : [trigger]
        const index = history.findIndex(item => item.id === trigger.id)
        const selected = part === 'root' ? history.slice(0, 1) : part === 'parent' ? (index > 0 ? history.slice(index - 1, index) : []) : history
        const messages = selected.map(item => ({ id: item.id, from: item.actor.id, at: item.at, text: item.text, ...!item.human ? { bot: true as const } : {} }))
        return { messages, body: { messages } }
      } }
  }
  private reporterSnapshot(ids: string[]): ReporterRuntimeSnapshot {
    const selected = new Set(ids)
    const triggers = ids.map(id => ({ id, disposition: this.store.triggers.disposition(id) }))
    const decisionIds = new Set(triggers.flatMap(trigger => trigger.disposition?.decisionId ?? []))
    const decisions = [...decisionIds].flatMap(id => {
      const decision = this.store.decisions.get(id)
      return decision ? [{ id, kind: decision.kind, triggerIds: decision.triggerIds, ...decision.ticketId ? { ticketId: decision.ticketId } : {} }] : []
    })
    const ticketIds = new Set(triggers.flatMap(trigger => trigger.disposition?.fanout ?? []))
    for (const decision of decisions) if (decision.ticketId) ticketIds.add(decision.ticketId)
    const tickets = this.store.tickets.list().filter(ticket => ticketIds.has(ticket.id) || ticket.origin.triggerIds.some(id => selected.has(id)))
      .map(ticket => ({ id: ticket.id, originTriggerIds: ticket.origin.triggerIds,
        state: ticket.ended ? 'ended' as const : 'open' as const,
        ...ticket.ended ? { outcome: ticket.ended.outcome } : {},
        ...latestReport(ticket) ? { reportState: latestReport(ticket)!.state } : {},
        ...ticket.attention ? { attention: { question: ticket.attention.question, ...ticket.attention.triggerId ? { triggerId: ticket.attention.triggerId } : {} } } : {} }))
    return { triggers, decisions, tickets }
  }
  /** A project-scoped, credential-free summary shown only to the autonomous Reporter. */
  private reporterSafeState(id: string, resolveProject: ReporterAutonomousHost['resolveProject']): unknown {
    const project = resolveProject(id)
    if (!project) return { available: false }
    const tickets = this.store.tickets.list().filter(ticket => this.store.triggers.get(ticket.origin.triggerId)?.source === id)
    const threads = this.store.threads.list().filter(thread => thread.ref.source === id)
    const health = Object.fromEntries(Object.entries(this.health).filter(([name]) => name === 'runtime' || name === id || name.endsWith(`:${id}`))
      .map(([name, value]) => [name, value.state]))
    return { available: true, project: { id: project.id, provider: project.provider, host: project.host, project: project.project },
      paused: this.store.settings().paused, health, open_tickets: tickets.filter(ticket => !ticket.ended).length,
      ended_tickets: tickets.filter(ticket => !!ticket.ended).length, active_threads: threads.length,
      allowed_actors: this.store.settings().policy.sources[id]?.allowed.length ?? 0 }
  }
  /** Wait for Engine dispositions, effects, and the real DSH sessions touched by one Reporter scenario. */
  private async waitForReporterTarget(scenarioId: string, signal: AbortSignal): Promise<void> {
    const reporter = this.reporter
    if (!reporter) throw Object.assign(new Error('Reporter is disabled'), { code: 'reporter_disabled' })
    const sessions = new Set<string>([this.masterId])
    const failedSessions = new Set<string>()
    let targetFailed = false
    const dispose = this.ctx.on('agent/error', ({ agent }) => {
      failedSessions.add(agent.id)
      if (sessions.has(agent.id)) targetFailed = true
    })
    const abortable = async <T>(promise: Promise<T>): Promise<T> => {
      signal.throwIfAborted()
      let onAbort: (() => void) | undefined
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
        signal.addEventListener('abort', onAbort, { once: true })
      })
      try { return await Promise.race([promise, aborted]) }
      finally { if (onAbort) signal.removeEventListener('abort', onAbort) }
    }
    const delay = (ms: number) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
      const onAbort = () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')) }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      let quietPasses = 0
      while (quietPasses < 2) {
        signal.throwIfAborted()
        if (targetFailed) throw Object.assign(new Error('A target DSH session failed'), { code: 'target_agent_error' })
        await abortable(this.passes.idle())
        await abortable(this.effects.idle())
        const scenario = reporter.scenario(scenarioId)
        if (!scenario) throw Object.assign(new Error('Reporter scenario is missing'), { code: 'scenario_not_found' })
        const scenarioTriggerIds = new Set(scenario.inputs.map(input => input.trigger.id))
        const ticketIds = new Set<string>()
        let pending = scenario.inputs.length === 0
        for (const input of scenario.inputs) {
          const disposition = this.store.triggers.disposition(input.trigger.id)
          if (!disposition) { pending = true; continue }
          if (disposition.filtered) continue
          const owners = [...new Set([...disposition.fanout.filter(id => !disposition.context?.includes(id)), ...(disposition.acked ?? [])])]
          for (const id of owners) ticketIds.add(id)
          if (disposition.decisionId) {
            const decision = this.store.decisions.get(disposition.decisionId)
            if (!decision) { pending = true; continue }
            if (decision.ticketId) ticketIds.add(decision.ticketId)
            if ((decision.kind === 'accept' || decision.kind === 'reopen') && !decision.ticketId && !owners.length) pending = true
          } else if (!owners.length) pending = true
        }
        for (const id of ticketIds) {
          const ticket = this.store.tickets.get(id)
          if (!ticket) { pending = true; continue }
          const sessionId = workerSessionId(id)
          sessions.add(sessionId)
          if (failedSessions.has(sessionId)) targetFailed = true
          const agent = this.ctx.agents.get(sessionId as SessionId)
          const ended = ticket.ended || ticket.assignments.at(-1)?.state === 'ended'
          if (ended) {
            // A domain terminal event can precede final DSH handling; a missing Agent is not proof that its Session finished.
            if (!agent || agent.status !== 'idle') pending = true
            continue
          }
          const assignment = ticket.assignments.at(-1)
          const report = assignment?.report
          const undelivered = ticket.inputs.some(input => input.kind === 'trigger' && scenarioTriggerIds.has(input.triggerId)
            && (ticket.undelivered.includes(input.id) || !input.deliveredTo))
          const reportPredatesDelivery = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at
          if (undelivered || !report || report.state === 'progress' || reportPredatesDelivery || !agent || agent.status !== 'idle') pending = true
        }
        const master = this.ctx.agents.get(this.masterId as SessionId)
        if (!master || master.status !== 'idle') pending = true
        if (targetFailed) throw Object.assign(new Error('A target DSH session failed'), { code: 'target_agent_error' })
        if (pending) quietPasses = 0
        else quietPasses++
        if (quietPasses < 2) await delay(50)
      }
    } finally { dispose() }
  }
  /** Fixed-path, bounded loopback probe; the model cannot supply a URL, method, or request headers. */
  private async probeReporterReadOnly(probe: ReporterReadOnlyProbe, signal: AbortSignal) {
    const paths: Record<ReporterReadOnlyProbe, string> = { state: 'state', overview: 'overview', sources: 'sources', tickets: 'tickets',
      threads: 'threads', decisions: 'decisions' }
    const server = this.ctx.webServer as typeof this.ctx.webServer & { getOrigin?: () => string }
    const origin = server.getOrigin?.() ?? `${server.protocol}//${server.host}:${server.port}`
    const response = await fetch(new URL(`/orchestrator/api/${paths[probe]}`, origin), { method: 'GET', cache: 'no-store', redirect: 'error', signal,
      headers: { 'x-orchestrator-request': '1' } })
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let body = '', size = 0, truncated = false
    if (reader) {
      try {
        while (true) {
          const item = await reader.read()
          if (item.done) break
          const remaining = 16 * 1024 - size
          if (item.value.byteLength > remaining) {
            body += decoder.decode(item.value.subarray(0, Math.max(0, remaining)), { stream: true })
            size = 16 * 1024; truncated = true
            await reader.cancel()
            break
          }
          size += item.value.byteLength
          body += decoder.decode(item.value, { stream: true })
        }
      } finally { body += decoder.decode() }
    }
    if (truncated) body += '\n[响应已截断]'
    return { probe_id: probe, status: response.status, body, json: response.headers.get('content-type')?.includes('application/json') ?? false }
  }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    this.sessions.install()
    this.executor.install()
    await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks,
      ...this.reporter && this.reporterToken ? { reporter: { client: this.reporter, token: this.reporterToken } } : {},
      get reporterRuns() { return runtime.reporterRuns },
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    try {
      this.assessor.stop()
      const ids = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.sessions.dispose()
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
