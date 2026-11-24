/** Lifecycle, prompt/tool/skill decoration, message delivery, and budget retry tracking for orchestrator and worker DSH sessions. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { key, liveTicket, type Ticket } from '../core/index.ts'
import { mandateInstructions, ticketOfSession } from '../executor/dsh.ts'
import type { HealthEntry } from '../infra/health.ts'
import { AgentDelivery, messageId } from './delivery.ts'
import type { Effects } from './effects.ts'
import type { Variable } from './execution-environment.ts'
import { RetryHealth } from './retry-health.ts'
import { initializeRoleModel } from './role-models.ts'
import { bundledSkills } from './skill-files.ts'
import { SKILL_PREFIX, type PromptVersion, type Prompts } from './prompts.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'
import { ticketShell } from '../infra/ticket-shell.ts'
import type { RoleModel } from '../policy.ts'
import type { RegisterTool, Tool } from './tools/tool.ts'
import type { ReporterSessionContext } from '../reporter/autonomous.ts'

/** Host dependencies used by `Sessions`. */
export interface SessionsHost {
  /** DSH Cordis context: sessions, agents, persistence, and their events. */
  readonly context: Context
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'keys'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>
  /** The `models` health entry, which reports managed sessions waiting on a model-budget retry. */
  readonly health: HealthEntry
  readonly masterId: string
  readonly stateDir: string
  /** Enabled project sources whose setup is ready and therefore own a managed Orchestrator Session. */
  projectIds(): readonly string[]
  /** Configured project identity for a deterministic project Session ID, including disabled or unready sources. */
  projectIdForSession(sessionId: string): string | undefined
  /** All configured project sources and their readiness for the management view. */
  projectSources(): readonly { id: string; enabled: boolean; ready: boolean; repository: string; host?: string }[]
  /** Resolve a persisted domain object to its owning ProjectSource for durable effect recovery. */
  projectForTrigger(triggerId: string): string | undefined
  projectForTicket(ticketId: string): string | undefined
  projectForThread(threadKey: string): string | undefined
  projectForReporter(runId: string): string | undefined
  readonly lifetime: AbortSignal
  closing(): boolean
  /** Execution environment variables for `ticket`, rendered into its worker's system prompt. */
  environment(ticket: Ticket): Variable[]
  /** Tools to register on the main, worker, or explicitly identified Reporter Session. */
  tools(agent: Agent, ticket?: Ticket, reporter?: ReporterSessionContext, projectId?: string): Tool[]
  /** Reporter run metadata; DSH remains the owner of the Session itself. */
  reporter?(sessionId: string): ReporterSessionContext | undefined
}

function reporterInstructions(context: ReporterSessionContext): string {
  const { request, view, scenario_id: scenarioId } = context
  return [
    '你是主动、挑剔的产品审查者，也要像真实用户一样亲自使用产品。尽可能寻找实现薄弱点、失败路径、界面问题和行为矛盾；页面能打开、服务健康或一条正常流程成功，都不能代替深入调查。',
    '结合同项目源码审查与实际截图 GUI 操作来发现和核验问题。具体审查哪个区域、提出什么假设、采用什么工具和操作顺序，由你根据目标与真实反馈自主决定；不要执行主会话指定的固定路线。若截图、源码权限或视觉能力不可用，说明限制并继续其余可用方向。没有实际收到并查看截图图像时，不能声称做过截图审查。',
    '静态实现证据本身可以支持调查疑点，但不能把不确定的问题当成最终发现。把源码证据、GUI 观察/实际复现和推断清楚区分；对仍不确定的分支继续调查、复现、排除或标记受阻，不要提交为 confirmed finding。保持挑剔但不制造缺陷。',
    '一个候选被否定、一个页面或工具受阻、一次健康检查通过或暂时没有确认缺陷，都不足以结束整轮。单个候选被否决或暂不派工不代表本轮审查结束；编排者决定候选是否值得派工，但只处理当前候选。结束该分支后，继续调查其他有价值的方向，除非明确要求结束整个审查。',
    `运行：${view.id}；ProjectSource：${request.project_source_id}；目标：${request.goal}`,
    `授权能力：${JSON.stringify(request.permissions)}${scenarioId ? `；本地仿真场景：${scenarioId}` : ''}`,
    '只使用当前 DSH Session 提供的只读文件观察和 Reporter 工具。仿真动作必须经 LocalReporter/Runtime/Engine，等待 Superagent 的真实响应；不得伪造回复、直接修改业务状态或发布平台消息。',
    request.ticket_id ? `当前 DSH Workspace 绑定到同项目执行工单 ${request.ticket_id} 的只读目录。主动审查实现和相关测试，并根据线索扩展到关联调用路径、组件与失败处理；具体检查范围由你判断，不要只停留在单个文件表面。` : '当前没有绑定同项目源码目录。不要把缺少目录或命令权限当作正常收尾理由；若源码访问、运行命令或构建结果是继续目标所必需的，通过 reporter_candidate 向编排者提出具体执行请求，说明目的和需要的 Worker 结果。编排者会依据原始人类请求决定是否用现有工单链路派给 Worker，并经当前 Session 回传结果；这条 relay 不是工单或用户授权。你不能自行执行、派工、指定路径或假称已读取源码。与此同时继续所有可行的调查方向，不要求用户重发请求。',
    request.permissions.browser ? '本次已授权截图 GUI。请使用实际截图图像观察界面，并通过 GUI 像真实用户一样交互；只读 HTTP 或可访问性文本不能代替截图审查。' : '本次未授权截图 GUI，不要声称看过截图；如实说明后继续源码和其他授权方向。',
    '发现未确认疑点时调用 reporter_candidate，将它作为待验证调查分支 relay 给编排者。工具结果包含稳定 candidate_id、investigation_status=investigating 和 continue_investigation=true。疑点 relay 后必须在当前 DSH Session 继续调查、复现和核验同一分支；执行依赖 relay 后继续所有可行方向，并在 Worker 结果返回后核验该分支。不能因消息送达而等待批准、换题或结束审查。编排者的回复只处理当前分支，提供意见或证据，不替代你的核验；单个候选被否决或暂不派工不结束整轮。候选不是最终问题或工单。',
    '只有证据、影响和复现/源码依据已经足够明确的问题，才调用 reporter_submit_finding 进入正常工单链路；该工具不接受不确定置信度。完成调查、确认或排除当前分支后，再继续其他合理方向。',
    '完成对当前可用源码与截图 GUI 方向的充分调查，且没有未完成的调查分支后，调用 reporter_submit_report。最终“发现的问题”只能包含已经成功提交的 confirmed finding；已排除分支不作为问题，确实受阻的分支只能作为未确认背景，不能写成问题结论。摘要和完整报告均为自由文本，不要求 JSON、固定模板、最少发现数或文件清单。',
  ].filter(Boolean).join('\n')
}

/**
 * What Sessions registered for an agent it decorated: the releases of its prompt section, tools and skill scope, the scope
 * its skills are registered in, and the skills of one prompt revision; for a worker's subagent, only its tool limits.
 */
interface SessionBinding { disposers: (() => void)[]; scope?: Context; skills?: { revision: number; dispose: () => void }; subagent?: true; reporter?: true; projectId?: string }

/** The agent presets Executor Sessions and the main Session are created with, which the bundle's patch defines. */
export const WORKER_PRESET = 'dsh-superagent-worker', ROUTER_PRESET = 'dsh-superagent-router', REPORTER_PRESET = 'dsh-superagent-reporter'

/** Stable DSH identity for the Orchestrator that owns one ProjectSource. */
export function projectOrchestratorSessionId(projectId: string): string {
  return `orchestrator-${key('project-orchestrator', projectId)}`
}

function isProjectOrchestratorId(sessionId: string, masterId: string): boolean {
  return sessionId !== masterId && /^orchestrator-[a-f0-9]{32}$/.test(sessionId)
}

/** Project Orchestrators use an empty, per-project DSH workspace rather than the shared state or a repository checkout. */
export function projectOrchestratorWorkspace(stateDir: string, projectId: string): string {
  return join(stateDir, 'project-orchestrators', key('project-orchestrator-workspace', projectId))
}

/** Serialize a tool result as text while passing a top-level DSH image reference through its native image block. */
export function renderSessionToolOutput(value: unknown): ContentBlock[] {
  const output = value && typeof value === 'object' ? value as Record<string, unknown> : undefined
  const image = output?.image
  const textValue = image ? Object.fromEntries(Object.entries(output!).filter(([key]) => key !== 'image')) : value
  const content = [{ type: 'text' as const, text: JSON.stringify(textValue) ?? String(textValue) }]
  return image ? [...content, { type: 'image' as const, attachment: image as ImageAttachmentRef }] : content
}

/** Prefer xhigh only when the active DSH model route advertises it; otherwise keep that route's default effort. */
export function selectReporterModel(catalog: Pick<ModelCatalog, 'default' | 'groups'>): RoleModel {
  const selected = catalog.default
  if (!selected.provider || !selected.model) throw new Error('Reporter DSH Session requires DSH default model')
  const model = catalog.groups.find(group => group.id === selected.provider)?.models.find(item => item.id === selected.model)
  const efforts = model?.reasoning?.efforts.map(effort => effort.id)
  const reasoningEffort = efforts?.includes('xhigh') ? 'xhigh'
    : selected.reasoningEffort && efforts?.includes(selected.reasoningEffort) ? selected.reasoningEffort
      : model?.reasoning?.defaultEffort && efforts?.includes(model.reasoning.defaultEffort) ? model.reasoning.defaultEffort
        : undefined
  return { provider: selected.provider, model: selected.model, ...(reasoningEffort ? { reasoningEffort } : {}) }
}

function reporterSessionModel(agent: Agent): RoleModel | undefined {
  const selection = agent.session.snapshotEvents().reduce<RoleModel | undefined>((current, event) =>
    event.type === 'model/selection' ? event.data : current, undefined)
  if (selection?.provider && selection.model) return selection
  const actual = agent.session.requestHeader()?.config
  return actual?.provider && actual.model ? { provider: actual.provider, model: actual.model,
    ...(actual.reasoningEffort ? { reasoningEffort: actual.reasoningEffort } : {}) } : undefined
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** DSH's agent preset registry selected `agentPreset` for a Session. */
    'agent-preset/selected'(sessionId: string, agentPreset: string): void
  }
}
/**
 * The DSH tools an Executor Session works with: files, search, the shell and its jobs, the web, skills, its todo list and
 * subagents. It gets no other tool the profile has, whenever it was registered: none that asks or shows a person something,
 * changes the profile, schedules work or starts goals outside the worker slots, the pause and a person's hold, starts or
 * messages other Sessions, or edits documents.
 */
const WORK_TOOLS = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill', 'web_search',
  'web_fetch', 'skill', 'todo_write', 'subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent']
/**
 * Creates and decorates orchestrator and worker DSH `Agent` sessions with role models, system prompt sections from `Prompts`, runtime skills, and restricted tool sets.
 * `Runtime`, `DshExecutor`, `MasterAssessor`, `Settings`, and management routes/tools use it to ensure sessions, deliver deduplicated messages via `AgentDelivery`, and process project-partitioned `relay` and `notice` effects.
 * Feeds session events into `RetryHealth` to report model budget waits on the `models` `HealthEntry`, and durably records which prompt revisions each session has worked under in `Store` (`KV.sessions.prompts`) to authorize prompt version reads.
 */
export class Sessions {
  private readonly agentDelivery: AgentDelivery
  /** Decorated agents mapped to their registered disposers and skill scope until the agent is disposed or `Sessions.dispose()` runs. */
  private readonly bindings = new Map<Agent, SessionBinding>()
  private readonly retryHealth = new RetryHealth()
  private readonly projectSessionFailures = new Map<string, string>()
  private readonly projectSessionEnsures = new Map<string, Promise<Agent>>()
  private readonly ctx: Context
  /** Registers project-partitioned `relay` and `notice` effect handlers. */
  constructor(private readonly host: SessionsHost) {
    this.ctx = host.context
    this.agentDelivery = new AgentDelivery(host.context)
    // A failed effect for one project must not hold work for another; rows remain ordered inside each project partition.
    host.effects.handle('relay', async (payload, requestId) => {
      const projectId = payload.projectId ?? this.projectFromRelay(payload.text, requestId)
      await this.ensureEffectProject(projectId)
      await this.prompt(this.requireProjectSession(projectId), requestId, payload.text, 'steer')
    }, { limit: () => 16, partition: (payload, requestId) => `project:${payload.projectId ?? this.projectFromRelay(payload.text, requestId)}` })
    host.effects.handle('notice', async (payload, name) => {
      // Historical Feishu settings notices linked to a global settings resource that project sessions cannot read.
      // The new save path does not enqueue them; consume old rows so they do not retry forever or expose bot settings.
      if ((payload.name ?? name) === 'settings:source:feishu') return
      const projectId = payload.projectId ?? this.projectFromNotice(name, payload)
      if (projectId) {
        await this.ensureEffectProject(projectId)
        await this.inject(projectId, payload.name ?? name, payload.value, payload.summary)
        return
      }
      if (!payload.allProjects && !this.isLegacyGlobalNotice(name)) throw new Error(`Cannot determine the ProjectSource for queued notice ${name}`)
      const projects = host.projectIds()
      if (!projects.length) throw new Error(`No ready ProjectSource can receive queued notice ${name}`)
      for (const id of projects) {
        await this.ensureEffectProject(id)
        await this.inject(id, payload.name ?? name, payload.value, payload.summary)
      }
    }, { limit: () => 16, partition: (payload, name) => `project:${payload.projectId ?? this.projectFromNotice(name, payload) ?? `legacy:${name}`}` })
  }
  /** Subscribes to host agent and session events so newly created sessions are decorated and model-budget retries are reflected in health. Call once at startup. */
  install(): void {
    const ctx = this.ctx
    ctx.on('agent/disposed', ({ agent }) => {
      this.release(agent)
      this.retryHealth.clear(agent.id); this.updateModelHealth()
    })
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      const binding = agent && agent.session === session ? this.bindings.get(agent) : undefined
      if (!agent || !binding || binding.subagent) return
      this.retryHealth.observe(agent.id, event)
      this.updateModelHealth()
    })
    ctx.on('agent/created', async ({ agent }) => { await this.decorate(agent); return undefined })
    // Opening a Session in DSH's Web UI before its first turn may select the default preset for it: select ours again. After
    // its first turn DSH refuses any selection, which leaves it as it is.
    ctx.inject(['agentPresets'], child => {
      child.on('agent-preset/selected', (sessionId, preset) => {
        const ticketId = ticketOfSession(sessionId), agent = ctx.agents.get(sessionId as SessionId)
        const isProjectSession = isProjectOrchestratorId(sessionId, this.host.masterId)
        const projectOrchestrator = this.host.projectIdForSession(sessionId) !== undefined || isProjectSession
        const ours = projectOrchestrator ? ROUTER_PRESET : ticketId && this.host.store.tickets.get(ticketId) ? WORKER_PRESET
          : this.host.reporter?.(sessionId) ? REPORTER_PRESET : undefined
        if (!ours || preset === ours || !agent) return
        const presets = child.get('agentPresets') as { select(agent: Agent, preset: string): Promise<string> }
        presets.select(agent, ours).catch(() => {})
      })
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && !this.host.closing()) { this.retryHealth.clear(agent.id); this.updateModelHealth() }
    })
  }
  /** Resolves or creates a persistent DSH session and applies its role-specific model, prompt, tools and workspace. */
  async ensure(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker'): Promise<Agent> {
    return this.ensureWithModel(id, cwd, title, role)
  }
  /** Creates or resumes the stable, project-scoped Orchestrator DSH Session. */
  async ensureProjectOrchestrator(projectId: string, stateDir: string, title: string): Promise<Agent> {
    const id = projectOrchestratorSessionId(projectId)
    if (this.host.closing()) throw new Error('Runtime is stopping')
    if (this.host.projectIdForSession(id) !== projectId || !this.host.projectIds().includes(projectId)) {
      throw new Error(`ProjectSource ${projectId} is not ready for an Orchestrator Session`)
    }
    const pending = this.projectSessionEnsures.get(projectId)
    if (pending) return pending
    const workspace = projectOrchestratorWorkspace(stateDir, projectId)
    const ensure = this.ensureWithModel(id, workspace, title, 'orchestrator')
      .then(agent => { this.projectSessionFailures.delete(projectId); return agent })
      .catch(error => {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code : error instanceof Error ? error.name : 'session_unavailable'
        this.projectSessionFailures.set(projectId, /^[A-Za-z0-9_.:-]{1,100}$/.test(code) ? code : 'session_unavailable')
        throw error
      }).finally(() => { this.projectSessionEnsures.delete(projectId) })
    this.projectSessionEnsures.set(projectId, ensure)
    return ensure
  }
  private async ensureEffectProject(projectId: string | undefined): Promise<void> {
    if (!projectId || !this.host.projectIds().includes(projectId)) throw new Error(`No ready ProjectSource can receive this Orchestrator message${projectId ? ` (${projectId})` : ''}`)
    const project = this.host.projectSources().find(item => item.id === projectId)
    const label = project?.host && project.host !== 'github.com' ? `${project.host}/${project.repository}` : project?.repository || projectId
    await this.ensureProjectOrchestrator(projectId, this.host.stateDir, `dsh-superagent orchestrator ${label}`)
  }
  /** Creates or resumes a Reporter Session with a DSH-supported selection and returns that exact selection for its run view. */
  async ensureReporter(id: string, cwd: string, title: string): Promise<RoleModel> {
    const resolved = await this.ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in resolved && resolved.error.code !== 'session/not-found') throw resolved.error
    const requested = ('error' in resolved ? undefined : reporterSessionModel(resolved.agent))
      ?? selectReporterModel(await this.ctx.sessionController.modelCatalog())
    const agent = await this.ensureWithModel(id, cwd, title, 'reporter', requested)
    const selection = reporterSessionModel(agent)
    if (selection) return selection
    throw new Error('Reporter DSH Session has no persisted model selection')
  }
  private async ensureWithModel(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker' | 'reporter', reporterModel?: RoleModel): Promise<Agent> {
    const ctx = this.ctx
    let result = await ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in result && result.error.code === 'session/not-found') {
      // DSH registers an existing directory. Project orchestrators own their workspace under stateDir.
      if (role === 'orchestrator' && this.host.projectIdForSession(id)) await mkdir(cwd, { recursive: true, mode: 0o700 })
      const workspace = await ctx.workspaceRegistry.create(cwd)
      // A Session keeps the preset it was created with, one of the bundle's own (cordis.patch.yml).
      await ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id,
        agentPreset: role === 'worker' ? WORKER_PRESET : role === 'reporter' ? REPORTER_PRESET : ROUTER_PRESET })
      result = await ctx.sessionController.resolveAgent(id as SessionId)
    }
    if ('error' in result) throw result.error
    const settings = this.host.store.settings()
    const model = role === 'orchestrator' ? settings.eval.model : role === 'worker' ? settings.executor.model : reporterModel ?? null
    if (role === 'reporter' && !model) throw new Error('Reporter DSH model selection is unavailable')
    await initializeRoleModel(ctx, result.agent, model)
    await this.decorate(result.agent)
    if (role === 'worker') ctx.permissionPresets.set(result.agent.session, 'danger-full-access')
    else if (role === 'orchestrator' && this.host.projectIdForSession(id)) ctx.permissionPresets.set(result.agent.session, 'workspace-write')
    await ctx.sessionController.rename({ sessionId: id as SessionId, title })
    return result.agent
  }
  /** Returns whether `sessionId` already holds the message delivered under `requestId`, or `false` if the session does not exist. */
  async holds(sessionId: string, requestId: string): Promise<boolean> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    return !('error' in result) && await this.agentDelivery.holds(result.agent, key(requestId))
  }
  /** Deliver a message once per request id: to the next turn, the current one, or `inject`ed with its label without waking the agent. */
  async prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) throw result.error
    await this.agentDelivery.send(result.agent, key(requestId), text, mode, this.host.lifetime, authorize, accepted)
  }
  /** The id of the message `prompt` delivers under `requestId`, which DSH's inbox events name it by. */
  promptedId(requestId: string): MessageId { return messageId(key(requestId)) }
  /** Enqueues a steering relay to the main Session; relays are durable and retried by `Effects` until delivered, at most once per `requestId`. */
  relay(requestId: string, text: string, projectId?: string): void {
    this.host.effects.enqueue('relay', requestId, { text, ...(projectId ? { projectId } : {}) })
  }
  /** Enqueues a durable background notice for injection into the main Session; a new notice with the same `name` replaces a still-waiting notice of that `name`. */
  notify(name: string, value: Record<string, unknown>, summary: string, projectId?: string): void {
    if (projectId && this.host.projectSources().some(project => project.id === projectId)) {
      this.host.effects.enqueue('notice', this.noticeKey(projectId, name), { name, projectId, value, summary })
      return
    }
    if (projectId && projectId !== 'feishu') {
      // Unknown project identities are retained for diagnosis instead of leaking into every project's Session.
      this.host.effects.enqueue('notice', this.noticeKey(projectId, name), { name, projectId, value, summary })
      return
    }
    const projects = this.host.projectIds()
    if (!projects.length) {
      this.host.effects.enqueue('notice', name, { name, value, summary, allProjects: true })
      return
    }
    for (const id of projects) this.host.effects.enqueue('notice', this.noticeKey(id, name), { name, projectId: id, value, summary })
  }
  /** Waits for currently runnable `notice` effects to settle and returns `'injected'` if notice `name` has reached the main Session or `'pending'` if it is still queued. */
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.noticePending(name) ? 'pending' : 'injected'
  }
  /** Injects a notice into the main Session without waking it; no-op if the main Session does not exist yet. */
  private async inject(projectId: string, name: string, value: Record<string, unknown>, summary: string): Promise<void> {
    const resolved = await this.ctx.sessionController.resolveAgent(this.requireProjectSession(projectId) as SessionId)
    if ('error' in resolved) throw resolved.error
    // Deduplicate by notice name and payload hash so retries are idempotent while updated payloads still deliver.
    const text = JSON.stringify(value)
    await this.agentDelivery.send(resolved.agent, `notice:${projectId}:${name}:${key(text)}`, text, { inject: summary }, this.host.lifetime)
  }
  /** Returns the current prompt revision, the active prompt revision of each loaded Session, and whether the main Session still has a pending `'prompts'` notice. */
  status() {
    const { store, prompts } = this.host
    const sessions = store.keys(KV.sessions.prompts).flatMap(name => {
      const sessionId = name.slice(KV.sessions.prompts.prefix.length), revision = store.get(name)?.at(-1)
      return this.ctx.agents.get(sessionId as SessionId) && revision !== undefined ? [{ sessionId, revision }] : []
    })
    return { revision: prompts.current().revision, sessions, notificationPending: this.noticePending('prompts'),
      project_orchestrators: this.projectOrchestrators() }
  }
  /** Stable project Session identities and their live DSH status for the management view. */
  projectOrchestrators() {
    return this.host.projectSources().map(project => {
      const sessionId = projectOrchestratorSessionId(project.id), agent = this.ctx.agents.get(sessionId as SessionId)
      return { project_source_id: project.id, session_id: sessionId,
        status: this.projectSessionFailures.has(project.id) ? 'error' as const
          : agent?.status === 'running' ? 'running' as const : agent ? 'idle' as const : 'missing' as const,
        enabled: project.enabled, ready: project.ready, repository: project.repository, ...(project.host ? { host: project.host } : {}),
        ...(this.projectSessionFailures.get(project.id) ? { error: this.projectSessionFailures.get(project.id) } : {}) }
    })
  }
  /** Active project Orchestrator sessions, including sessions whose ProjectSource was removed after they were created. */
  projectSessionIds(): string[] {
    return [...this.bindings.keys()].map(agent => agent.id)
      .filter(id => isProjectOrchestratorId(id, this.host.masterId))
  }
  /** Returns the prompt version a Session runs under (the one bound on its latest model request, or the current version). */
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }
  /** Whether a Session is authorized to read `revision` (its active revision or any revision it previously ran under). */
  mayRead(sessionId: string, revision: number): boolean {
    return revision === this.promptVersion(sessionId).revision || (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
  }
  /** Returns a tool registrar for `agent` that renders tool output as JSON text and attaches `output.image` as an image when present. */
  private registerTool(agent: Agent, binding: SessionBinding): RegisterTool {
    return (name, description, schema, execute) => {
      binding.disposers.push(agent.ctx.tools.register({ name, description, parameters: z.toJSONSchema(schema),
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
          return renderSessionToolOutput(value)
        } },
        execute: (args, execution) => execute(schema.parse(args), execution.signal) }))
    }
  }
  /** Returns `sessionId`'s active model-budget retry state (`{ model_retry }`) for status listings, or `{}` when not waiting on one. */
  modelRetry(sessionId: string | undefined) {
    const retry = sessionId ? this.retryHealth.get(sessionId) : undefined
    return retry ? { model_retry: retry } : {}
  }
  private updateModelHealth(): void {
    const retries = this.retryHealth.list()
    this.host.health.set(retries.length
      ? { state: 'error', detail: retries.slice(0, 5).map(item => `${item.sessionId}: ${item.provider} is over its model budget; retried ${item.attempts} times, waiting since ${item.since}; the model and retry policy are unchanged`).join('; ') + (retries.length > 5 ? `; ${retries.length - 5} more Sessions` : ''), at: retries.at(-1)!.lastAt }
      : { state: 'ready', detail: 'No managed Session is waiting on a model budget retry' })
  }
  private noticeKey(projectId: string, name: string): string { return `project:${projectId}:${name}` }
  private noticePending(name: string): boolean {
    return this.host.effects.pending('notice', name)
      || this.host.projectSources().some(project => this.host.effects.pending('notice', this.noticeKey(project.id, name)))
  }
  private requireProjectSession(projectId: string | undefined): string {
    if (!projectId || !this.host.projectIds().includes(projectId)) {
      throw new Error(`A ready ProjectSource is required for this Orchestrator message${projectId ? ` (${projectId})` : ''}`)
    }
    return projectOrchestratorSessionId(projectId)
  }
  /** Recover ownership from the source object embedded in pre-upgrade durable relays. */
  private projectFromRelay(text: string, requestId: string): string {
    let value: unknown
    try { value = JSON.parse(text) } catch { value = undefined }
    const objects: Record<string, unknown>[] = []
    const visit = (item: unknown, depth = 0) => {
      if (!item || typeof item !== 'object' || depth > 5) return
      objects.push(item as Record<string, unknown>)
      for (const child of Object.values(item)) if (child && typeof child === 'object') visit(child, depth + 1)
    }
    visit(value)
    const owners = new Set<string>()
    for (const item of objects) {
      const triggerId = typeof item.trigger_id === 'string' ? item.trigger_id : undefined
      if (triggerId) {
        const project = this.host.projectForTrigger(triggerId)
        if (project) owners.add(project)
      }
      const ticketId = typeof item.ticket_id === 'string' ? item.ticket_id : undefined
      if (ticketId) {
        const project = this.host.projectForTicket(ticketId)
        if (project) owners.add(project)
      }
      const runId = typeof item.run_id === 'string' ? item.run_id : undefined
      if (runId) {
        const project = this.host.projectForReporter(runId)
        if (project) owners.add(project)
      }
    }
    const fromKey = /^attention:([^:]+):/.exec(requestId)?.[1]
    if (fromKey) {
      const project = this.host.projectForTicket(fromKey)
      if (project) owners.add(project)
    }
    const reporterRun = /^reporter-(?:candidate|report):([^:]+):/.exec(requestId)?.[1]
    if (reporterRun) {
      const project = this.host.projectForReporter(reporterRun)
      if (project) owners.add(project)
    }
    if (owners.size > 1) throw new Error(`Conflicting ProjectSource references for queued relay ${requestId}`)
    if (owners.size === 1) return owners.values().next().value!
    throw new Error(`Cannot determine the ProjectSource for queued relay ${requestId}`)
  }
  /** Recover ownership from old notice keys and their persisted Trigger/Ticket/Thread references. */
  private projectFromNotice(name: string, payload: { value: Record<string, unknown> }): string | undefined {
    const value = payload.value
    const owners = new Set<string>()
    const triggerId = typeof value.trigger_requeued === 'string' ? value.trigger_requeued
      : typeof value.trigger_id === 'string' ? value.trigger_id : undefined
    if (triggerId) {
      const project = this.host.projectForTrigger(triggerId)
      if (project) owners.add(project)
    }
    const nestedId = (key: string) => {
      const item = value[key]
      return item && typeof item === 'object' && typeof (item as Record<string, unknown>).ticket_id === 'string'
        ? String((item as Record<string, unknown>).ticket_id) : undefined
    }
    const nestedThread = (key: string) => {
      const item = value[key]
      return item && typeof item === 'object' && typeof (item as Record<string, unknown>).thread === 'string'
        ? String((item as Record<string, unknown>).thread) : undefined
    }
    const ticketId = typeof value.ticket_id === 'string' ? value.ticket_id
      : nestedId('ticket_ended') ?? nestedId('thread_unrelated') ?? nestedId('thread_followed')
    if (ticketId) {
      const project = this.host.projectForTicket(ticketId)
      if (project) owners.add(project)
    }
    const referencedThread = typeof value.thread === 'string' ? value.thread
      : nestedThread('thread_unrelated') ?? nestedThread('thread_followed')
    if (referencedThread) {
      const project = this.host.projectForThread(referencedThread)
      if (project) owners.add(project)
    }
    const thread = /^subscription:(.+)$/.exec(name)?.[1]
    if (thread) {
      const project = this.host.projectForThread(thread)
      if (project) owners.add(project)
      // Legacy Thread keys already namespaced by the single-source Provider can be recovered without choosing
      // whichever ProjectSource happens to remain enabled after an upgrade.
      const source = thread.slice(0, thread.indexOf(':'))
      if (source && this.host.projectSources().some(project => project.id === source)) {
        owners.add(source)
      }
    }
    const sourceBlock = /^settings:source:(.+)$/.exec(name)?.[1]
    if (sourceBlock && sourceBlock !== 'feishu' && this.host.projectSources().some(project => project.id === sourceBlock)) {
      owners.add(sourceBlock)
    }
    if (owners.size > 1) throw new Error(`Conflicting ProjectSource references for queued notice ${name}`)
    if (owners.size === 1) return owners.values().next().value
    return undefined
  }
  private isLegacyGlobalNotice(name: string): boolean {
    return name === 'prompts' || name === 'settings' || /^settings:(?:policy|eval|executor|pause|source:feishu)$/.test(name)
  }
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  private async decorate(agent: Agent): Promise<void> {
    if (this.bindings.has(agent)) return
    const host = this.host
    const projectId = host.projectIdForSession(agent.id)
    // Retain the historical global master Session for DSH UI/history only. It receives no new managed input and cannot
    // route or execute work across projects if an operator opens it manually.
    if (agent.id === host.masterId) {
      const binding: SessionBinding = { disposers: [] }
      this.bindings.set(agent, binding)
      binding.disposers.push(agent.ctx.tools.restrict({ allow: ['skill'] }), agent.ctx.tools.guard(() => 'This historical Session is read-only; use the project Orchestrator Session.'))
      return
    }
    if (isProjectOrchestratorId(agent.id, host.masterId) && !projectId) {
      // Project ids are hashed into their stable Session ids. If configuration was removed, the owner can no longer be
      // recovered, so keep the orphaned Session available for history while refusing all actions.
      const binding: SessionBinding = { disposers: [] }
      this.bindings.set(agent, binding)
      binding.disposers.push(agent.ctx.tools.restrict({ allow: ['skill'] }), agent.ctx.tools.guard(() => 'This project Session has no configured ProjectSource and is read-only.'))
      return
    }
    const projectMaster = projectId !== undefined
    if (projectMaster && !host.projectIds().includes(projectId)) {
      const binding: SessionBinding = { disposers: [], projectId }
      this.bindings.set(agent, binding)
      binding.disposers.push(agent.ctx.tools.restrict({ allow: ['skill'] }), agent.ctx.tools.guard(() => `ProjectSource ${projectId} is not ready; this Session is read-only.`))
      return
    }
    const ticket = projectMaster ? undefined : this.ticketOf(agent)
    const reporter = !projectMaster && !ticket ? host.reporter?.(agent.id) : undefined
    if (!projectMaster && !ticket && !reporter) { this.limitSubagent(agent); return }
    const binding: SessionBinding = { disposers: [], ...(reporter ? { reporter: true as const } : {}), ...(projectId ? { projectId } : {}) }
    this.bindings.set(agent, binding)
    this.retryHealth.restore(agent.id, agent.session.snapshotEvents())
    if (agent.status === 'idle') this.retryHealth.clear(agent.id)
    this.updateModelHealth()
    // Disable variable interpolation so literal ${{ ... }} expressions in team prompts are preserved.
    binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-policy', order: 9999, interpolate: false, text: context => {
      const version = this.promptFor(agent, context.signal !== undefined)
      const current = ticket && host.store.tickets.get(ticket.id)
      const composed = reporter ? reporterInstructions(reporter)
        : host.prompts.compose(version.config, projectMaster ? 'orchestrator' : 'worker', current ? host.environment(current) : undefined, projectId)
      return `[dsh-superagent prompt revision ${version.revision}]\n${composed}\n${current ? mandateInstructions(current.mandate) : ''}`
    }, ...(projectMaster ? { complete: true } : {}) }))
    // A recreated skill scope (e.g. after the skills service restarts) starts empty, so reset `binding.skills` before rebinding.
    const skillScope = agent.ctx.inject(['skills'], scope => {
      binding.scope = scope
      binding.skills = undefined
      this.bindSkills(binding, host.prompts.current())
    })
    binding.disposers.push(() => { skillScope.dispose().catch((error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release a skill scope: %s', String(error)) }) })
    await skillScope
    // Bail out if the agent was disposed while awaiting the skill scope.
    if (this.bindings.get(agent) !== binding) return
    const register = this.registerTool(agent, binding)
    const tools = host.tools(agent, ticket, reporter, projectId)
    for (const tool of tools) register(tool.name, tool.description, tool.schema, tool.execute)
    if (projectMaster) {
      // Project routers receive bounded reads through their own tools. Do not expose inherited filesystem, shell, job or web tools.
      // A guard also refuses raw tools if another plugin registers one in this Agent's local scope, where `restrict` cannot mask it.
      const localTools = new Set(tools.map(tool => tool.name))
      binding.disposers.push(agent.ctx.tools.restrict({ allow: ['skill'] }), agent.ctx.tools.guard(execution => {
        if (!host.projectIds().includes(projectId)) return `ProjectSource ${projectId} is not ready; orchestration is unavailable`
        if (execution.name !== 'skill' && !localTools.has(execution.name)) return 'Project Orchestrators may use only project-scoped orchestration tools and skills'
      }))
    } else if (reporter) {
      const fileTools = reporter.request.ticket_id ? ['read', 'read_image', 'glob', 'grep'] : []
      // DSH restrictions mask inherited global tools only. Reporter tools are registered in this Agent scope and remain
      // visible without naming them here; passing scope-local names to restrict() is rejected by DSH.
      binding.disposers.push(agent.ctx.tools.restrict({ allow: fileTools }))
    } else {
      // An Executor Session keeps the profile's work tools it has, which DSH requires to be known; its own tools are not masked.
      binding.disposers.push(...this.workOnly(agent, ticket!.id))
      this.bindShell(agent, ticket!.id, binding)
    }
  }
  /**
   * An Executor Session's tools: only the profile's work tools, which DSH requires to be known, and none once its ticket
   * ended. A failed or blocked worker keeps its tools, so a person may continue it in its Session; only automated input waits
   * (see the executor). Read inherited tools through the parent scope, which includes the preset's tools. The global view
   * misses preset tools; the agent's own view also includes local tools such as subagent, which restrict refuses to name.
   */
  private workOnly(agent: Agent, ticketId: string): (() => void)[] {
    const store = this.host.store
    const parent = scopeParentOf(agent)
    const allow = WORK_TOOLS.filter(name => agent.ctx.tools.get(name, parent))
    return [agent.ctx.tools.restrict({ allow }), agent.ctx.tools.guard(() => {
      const current = store.tickets.get(ticketId)
      return !current || !liveTicket(current) ? 'Ticket ended; new work needs a new authorized ticket' : undefined
    })]
  }
  /**
   * A subagent of an Executor Session, or of one of its subagents, which runs under DSH's `standard` preset with the worker's
   * permissions, gets the same work tools as the worker, and none once the worker's ticket ended. Any other agent is left as
   * it is.
   */
  private limitSubagent(agent: Agent): void {
    let parent = agent.session.header.parentSession
    // Up the subagents' parents to the worker, which are loaded while their subagents run.
    for (let depth = 0; parent !== undefined && ticketOfSession(parent) === undefined && depth < 8; depth++) {
      parent = this.ctx.agents.get(parent)?.session.header.parentSession
    }
    const ticketId = parent === undefined ? undefined : ticketOfSession(parent)
    if (ticketId === undefined || !this.host.store.tickets.get(ticketId)) return
    const binding: SessionBinding = { disposers: this.workOnly(agent, ticketId), subagent: true }
    this.bindings.set(agent, binding)
    this.bindShell(agent, ticketId, binding)
  }
  private bindShell(agent: Agent, ticketId: string, binding: SessionBinding): void {
    const current = this.host.store.tickets.get(ticketId)
    if (!current) return
    const variables = this.host.environment(current)
    const gitConfig = variables.find(variable => variable.key === 'GIT_CONFIG_GLOBAL')?.value
    if (!gitConfig || !variables.some(variable => variable.key === 'DSH_SUPERAGENT_SOURCE')) return
    for (const name of ['bash', 'pwsh']) {
      const definition = agent.ctx.tools.get(name, agent)
      if (!definition) continue
      binding.disposers.push(agent.ctx.tools.register(ticketShell(definition, () => {
        const ticket = this.host.store.tickets.get(ticketId)
        if (!ticket || !liveTicket(ticket)) throw new Error('Ticket ended; shell execution refused')
        return Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
      }, join(dirname(gitConfig), 'shell-environments'))))
    }
  }
  /** Register the skills of a prompt version in the agent's skill scope, in place of an earlier version's. */
  private bindSkills(binding: SessionBinding, version: PromptVersion): void {
    const { scope, skills: previous } = binding
    if (!scope || previous?.revision === version.revision) return
    previous?.dispose()
    const disposers: (() => void)[] = []
    for (const [name, content] of this.host.prompts.skills(version.config)) {
      const bundled = Object.hasOwn(bundledSkills, name) ? bundledSkills[name as keyof typeof bundledSkills] : undefined
      const body = version.config.skills[name] ?? ''
      const description = bundled?.description ?? (body.replace(/\s+/g, ' ').slice(0, 120) || 'Custom dsh-superagent operational skill.')
      disposers.push(scope.skills.register({ name: `${SKILL_PREFIX}${name}`, description, content, source: 'runtime',
        ...(bundled ? { resourceBase: { kind: 'directory' as const, path: dirname(bundled.path) } } : {}) }))
    }
    binding.skills = { revision: version.revision, dispose: () => { disposers.forEach(dispose => dispose()) } }
  }
  /** Return the current prompt version, updating the agent's skills and recording the revision in Store when bound to a model request. */
  private promptFor(agent: Agent, bind: boolean): PromptVersion {
    const version = this.host.prompts.current()
    if (!bind) return version
    const binding = this.bindings.get(agent)
    if (binding) this.bindSkills(binding, version)
    const { store } = this.host
    const revisions = store.get(KV.sessions.prompts(agent.id)) ?? []
    const bound = [...revisions.filter(revision => revision !== version.revision), version.revision]
    if (revisions.at(-1) !== version.revision) store.set(KV.sessions.prompts(agent.id), bound)
    return version
  }
  /** Releases registrations for `agent` in reverse order (LIFO); disposing its skill scope releases its skills as well. */
  private release(agent: Agent): void {
    const binding = this.bindings.get(agent)
    if (!binding) return
    this.bindings.delete(agent)
    binding.skills?.dispose()
    for (const dispose of binding.disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { this.ctx.logger.warn('dsh-superagent could not release what it registered for a Session: %s', String(error)) }
    }
  }
  /** Releases prompt sections, skills, and tools registered by `Sessions` across all decorated agents. */
  dispose(): void { for (const agent of [...this.bindings.keys()]) this.release(agent) }
  /** Waits for Session creates already in flight before Runtime snapshots agents for shutdown cancellation. */
  async settleProjectOrchestratorEnsures(): Promise<void> { await Promise.allSettled([...this.projectSessionEnsures.values()]) }
}
