/** 自主 Reporter 运行的请求、状态与边界类型。 */
import { z } from 'zod'
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, truncateSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { ReporterAutonomousReviewInput, ReporterBrowserModelInput, ReporterExperimentEvidence, ReporterExplorerInput,
  ReporterBrowserStep, ReporterModelInvoker, ReporterModelRequest } from './coordinator.ts'
import { REPORTER_REVIEWER_INSTRUCTIONS, parseReporterReviewerOutput, runQualitativeReviewer, runUserSimulator } from './coordinator.ts'
import type { LocalReporter, ReporterScenarioResult } from './local-reporter.ts'
import type { ReporterModelResponse } from './coordinator.ts'
import { ReporterBrowserActionSchema, type ReporterBrowserAction, type ReporterBrowserDriver, type ReporterBrowserObservation } from './browser.ts'
import { stableJson } from './protocol.ts'
import type { ReporterOutputKind } from './protocol.ts'
import type { ReporterScenarioDefinition } from './protocol.ts'
import { ReporterProgressStalledError, ReporterProgressWatchdog, type ReporterProgressKind } from './progress.ts'

const projectSourceId = z.string().regex(/^[a-z][a-z0-9-]{0,99}$/)

const ReporterBudgetSchema = z.object({ max_model_calls: z.number().int().min(2).max(20).default(8), max_actions: z.number().int().min(2).max(12).default(4),
  max_experiments: z.number().int().min(1).max(2).default(1), max_total_tokens: z.number().int().min(100).max(100_000).default(20_000),
  /** 最长连续无真实进展窗口，不是运行总时限。 */
  timeout_ms: z.number().int().min(5_000).max(600_000).default(600_000) }).strict().prefault({})

export const ReporterAutonomousRunRequestSchema = z.object({
  /** 调用方生成的幂等键；相同键与请求体始终返回原运行。 */
  idempotency_key: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  goal: z.string().trim().min(1).max(4_000),
  project_source_id: projectSourceId,
  mode: z.enum(['simulation', 'real-service', 'browser', 'both']),
  permissions: z.object({ simulation: z.boolean().default(false), read_only_service: z.boolean().default(false), browser: z.boolean().default(false) }).strict().prefault({}),
  budget: ReporterBudgetSchema,
}).strict().superRefine((request, context) => {
  if (!request.permissions.simulation && !request.permissions.read_only_service && !request.permissions.browser) {
    context.addIssue({ code: 'custom', path: ['permissions'], message: '至少需要一种明确的测试权限' })
  }
  if (request.mode === 'simulation' && !request.permissions.simulation) {
    context.addIssue({ code: 'custom', path: ['permissions', 'simulation'], message: 'simulation 模式需要 simulation 权限' })
  }
  if (request.mode === 'real-service' && !request.permissions.read_only_service) {
    context.addIssue({ code: 'custom', path: ['permissions', 'read_only_service'], message: 'real-service 模式需要只读服务检查权限' })
  }
  if (request.mode === 'browser' && !request.permissions.browser) {
    context.addIssue({ code: 'custom', path: ['permissions', 'browser'], message: 'browser 模式需要明确授权浏览器检查' })
  }
  if (request.mode === 'both' && (!request.permissions.simulation || !request.permissions.read_only_service)) {
    context.addIssue({ code: 'custom', path: ['permissions'], message: 'both 模式需要同时明确授权仿真和只读服务检查' })
  }
})
export type ReporterAutonomousRunRequest = z.infer<typeof ReporterAutonomousRunRequestSchema>

export type ReporterAutonomousRunStatus = 'running' | 'completed' | 'incomplete' | 'failed' | 'cancelled'
export interface ReporterAutonomousFinding {
  severity: 'info' | 'warning' | 'error'
  status: 'candidate' | 'confirmed' | 'invalid-test'
  title: string
  evidence: string[]
  reproduction: string[]
}
export type ReporterAutonomousBrowserStep = ReporterBrowserStep
export interface ReporterAutonomousExperiment {
  kind: 'simulation' | 'real-service' | 'browser'
  hypothesis: string
  observation: string
  evidence: string[]
  scenario_id?: string
  browser_steps?: ReporterAutonomousBrowserStep[]
  public_transcript?: ReporterAutonomousTranscriptMessage[]
}
export interface ReporterAutonomousTranscriptMessage {
  sequence: number
  role: 'actor' | 'superagent'
  actor_id?: string
  kind?: ReporterOutputKind
  at: string
  text: string
}
export interface ReporterAutonomousReportExperiment extends Omit<ReporterAutonomousExperiment, 'public_transcript'> {
  public_transcript?: ReporterAutonomousTranscriptMessage[]
  oracle_status?: 'passed' | 'failed' | 'unavailable'
}
export type ReporterAutonomousDeliveryStatus = 'pending' | 'delivered' | 'failed'
export interface ReporterAutonomousReport {
  run_id: string
  goal: string
  project_source_id: string
  mode: ReporterAutonomousRunRequest['mode']
  status: Exclude<ReporterAutonomousRunStatus, 'running'>
  summary: string
  model: ReporterAutonomousRunView['model']
  model_usage: ReporterAutonomousRunView['model_usage']
  experiments: ReporterAutonomousReportExperiment[]
  findings: ReporterAutonomousFinding[]
  error_code?: string
}
export interface ReporterAutonomousRunView {
  id: string
  goal: string
  project_source_id: string
  mode: ReporterAutonomousRunRequest['mode']
  status: ReporterAutonomousRunStatus
  phase: string
  started_at: string
  updated_at: string
  progress?: { at: string; kind: ReporterProgressKind }
  model: { provider: string; model: string; reasoningEffort: 'medium' }
  experiments: number
  turns: number
  model_calls: number
  model_usage: { prompt_tokens: number | null; completion_tokens: number | null; cost_usd: number | null; latency_ms: number | null; retries: number | null;
    completeness: 'reported' | 'partial' | 'unknown' }
  scenario_ids: string[]
  experiment_log: ReporterAutonomousExperiment[]
  report_delivery: { status: ReporterAutonomousDeliveryStatus; master_session_id?: string; error_code?: string }
  summary?: string
  findings?: ReporterAutonomousFinding[]
  error_code?: string
}

/** 只读管理状态，不含 capability、隐藏 Oracle 或模型凭据。 */
export interface ReporterAutonomousManagementView { enabled: boolean; runs: ReporterAutonomousRunView[] }

const ProbeIds = ['state', 'overview', 'sources', 'tickets', 'threads', 'decisions'] as const
const ExploreDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('simulation'), hypothesis: z.string().trim().min(1).max(500), goal: z.string().trim().min(1).max(1_000),
    persona: z.string().trim().min(1).max(1_000) }).strict(),
  z.object({ kind: z.literal('real-service'), hypothesis: z.string().trim().min(1).max(500), probe_id: z.enum(ProbeIds) }).strict(),
  z.object({ kind: z.literal('browser'), hypothesis: z.string().trim().min(1).max(500) }).strict(),
  z.object({ kind: z.literal('finished'), summary: z.string().trim().min(1).max(2_000) }).strict(),
])
const BrowserStepSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('observe') }).strict(),
  z.object({ kind: z.literal('act'), action: ReporterBrowserActionSchema }).strict(),
  z.object({ kind: z.literal('finished'), summary: z.string().trim().min(1).max(1_000) }).strict()])
const ReadOnlyProbeSchema = z.enum(ProbeIds)
const BROWSER_STEP_SNAPSHOT_CHARS = 4_000
const PROGRESS_PERSIST_INTERVAL_MS = 60_000
export type ReporterReadOnlyProbe = z.infer<typeof ReadOnlyProbeSchema>
export interface ReporterReadOnlyObservation { probe_id: ReporterReadOnlyProbe; status: number; body: string; json: boolean }
export interface ReporterBrowserFactory { create(signal: AbortSignal): Promise<ReporterBrowserDriver> }
export interface ReporterAutonomousHost {
  reporter: Pick<LocalReporter, 'registerScenario' | 'simulatorFeedback' | 'submit' | 'recordUsage' | 'completeScenario' | 'scenario' | 'reviewEvidence' | 'recordReview'>
  enabled: boolean
  resolveProject(id: string): { id: string; provider: string; host: string; project: string } | undefined
  allowedActors(id: string): string[]
  safeState(id: string): unknown
  resolveModel(): Promise<{ provider: string; model: string; invoke: ReporterModelInvoker }>
  deliverReport(input: { runId: string; report: ReporterAutonomousReport }): Promise<{ masterSessionId: string }>
  waitForSuperagent(scenarioId: string, signal: AbortSignal, onProgress?: () => void): Promise<void>
  probeReadOnly(probe: ReporterReadOnlyProbe, signal: AbortSignal): Promise<ReporterReadOnlyObservation>
  browser?: ReporterBrowserFactory
  lifetime: AbortSignal
  stateDir: string
  now?: () => string
}

/** Reporter 自主运行的结构化错误；状态码用于 API 响应，错误码用于稳定诊断。 */
export class ReporterAutonomousRunError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, readonly code: string, message: string) { super(message) }
}

interface PersistedStart { type: 'started'; digest: string; idempotency_key: string; view: ReporterAutonomousRunView }
interface PersistedUpdate { type: 'updated'; view: ReporterAutonomousRunView }
interface PersistedReportPrepared { type: 'report-prepared'; report: ReporterAutonomousReport }
type PersistedRun = PersistedStart | PersistedUpdate | PersistedReportPrepared
interface RunRecord { digest: string; idempotencyKey: string; view: ReporterAutonomousRunView; controller: AbortController; report?: ReporterAutonomousReport;
  progressPersistedAtMs?: number }
interface PendingStart { digest: string; promise: Promise<ReporterAutonomousRunView>; resolve(view: ReporterAutonomousRunView): void; reject(error: unknown): void }
const RUN_LIMIT = { count: 50, bytes: 64 * 1024 * 1024, fileBytes: 8 * 1024 * 1024, events: 500, eventBytes: 256 * 1024 } as const
const stable = stableJson
const json = (value: unknown): string => JSON.stringify(value)
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => { cleanup(); reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}
const cloneView = (view: ReporterAutonomousRunView): ReporterAutonomousRunView => {
  const cloned = structuredClone(view)
  if (cloned.model_usage.retries === undefined) cloned.model_usage.retries = null
  if (!cloned.report_delivery) cloned.report_delivery = { status: 'failed', error_code: 'report_delivery_state_missing' }
  return cloned
}
const nowIso = () => new Date().toISOString()

/** 有界、0600 的 Reporter 运行目录；重启只恢复证据和终态，不恢复正在收费的任务。 */
export class ReporterAutonomousRuns {
  private readonly directory: string
  private readonly records = new Map<string, RunRecord>()
  private readonly idempotency = new Map<string, string>()
  private readonly pendingStarts = new Map<string, PendingStart>()
  private readonly eventCounts = new Map<string, number>()
  private totalBytes = 0
  private active?: string
  private readonly now: () => string
  constructor(private readonly host: ReporterAutonomousHost) {
    this.directory = join(resolve(host.stateDir), 'reporter', 'runs')
    this.now = host.now ?? nowIso
    if (!host.enabled) return
    mkdirSync(this.directory, { recursive: true, mode: 0o700 }); chmodSync(this.directory, 0o700)
    this.load()
  }

  async start(input: unknown): Promise<ReporterAutonomousRunView> {
    if (!this.host.enabled) throw new ReporterAutonomousRunError(404, 'reporter_disabled', '自主 Reporter 未启用')
    const request = ReporterAutonomousRunRequestSchema.parse(input)
    const digest = hash(stable(request)), priorId = this.idempotency.get(request.idempotency_key)
    if (priorId) {
      const prior = this.records.get(priorId)!
      if (prior.digest !== digest) throw new ReporterAutonomousRunError(409, 'idempotency_conflict', '幂等键已用于不同的 Reporter 请求')
      return cloneView(prior.view)
    }
    const pending = this.pendingStarts.get(request.idempotency_key)
    if (pending) {
      if (pending.digest !== digest) throw new ReporterAutonomousRunError(409, 'idempotency_conflict', '幂等键已用于不同的 Reporter 请求')
      return pending.promise.then(cloneView)
    }
    if (!this.host.resolveProject(request.project_source_id)) throw new ReporterAutonomousRunError(404, 'project_not_found', '测试项目不存在或未启用')
    if (request.mode === 'simulation' || request.mode === 'both') {
      if (!this.host.allowedActors(request.project_source_id).length) throw new ReporterAutonomousRunError(409, 'no_allowed_actor', '该项目没有可用于仿真测试的已授权用户')
    }
    if (request.mode === 'browser' && !this.host.browser) throw new ReporterAutonomousRunError(503, 'browser_unavailable', '浏览器测试驱动不可用')
    if (this.active) throw new ReporterAutonomousRunError(409, 'run_active', '已有自主 Reporter 运行正在执行')
    if (this.records.size >= RUN_LIMIT.count) throw new ReporterAutonomousRunError(409, 'run_limit', '已达到保留运行数量上限')
    this.active = `preparing:${request.idempotency_key}`
    let resolvePending!: PendingStart['resolve'], rejectPending!: PendingStart['reject']
    const pendingPromise = new Promise<ReporterAutonomousRunView>((resolve, reject) => { resolvePending = resolve; rejectPending = reject })
    this.pendingStarts.set(request.idempotency_key, { digest, promise: pendingPromise, resolve: resolvePending, reject: rejectPending })
    let route: { provider: string; model: string; invoke: ReporterModelInvoker }
    try { route = await this.host.resolveModel() }
    catch {
      this.active = undefined; this.pendingStarts.delete(request.idempotency_key)
      const error = new ReporterAutonomousRunError(503, 'reporter_model_unavailable', 'Reporter 模型不可用或不支持 medium 推理等级')
      rejectPending(error); throw error
    }
    const id = `auto-${hash(request.idempotency_key).slice(0, 32)}`, at = this.now()
    const view: ReporterAutonomousRunView = { id, goal: request.goal, project_source_id: request.project_source_id, mode: request.mode,
      status: 'running', phase: '发现可测试行为', started_at: at, updated_at: at,
      model: { provider: route.provider, model: route.model, reasoningEffort: 'medium' }, experiments: 0, turns: 0, model_calls: 0,
      model_usage: { prompt_tokens: 0, completion_tokens: 0, cost_usd: null, latency_ms: 0, retries: null, completeness: 'partial' },
      scenario_ids: [], experiment_log: [], report_delivery: { status: 'pending' }, findings: [] }
    const controller = new AbortController(), record = { digest, idempotencyKey: request.idempotency_key, view, controller, progressPersistedAtMs: Date.now() }
    this.records.set(id, record); this.idempotency.set(request.idempotency_key, id); this.active = id
    try { this.append(id, { type: 'started', digest, idempotency_key: request.idempotency_key, view: cloneView(view) }) }
    catch (error) {
      this.records.delete(id); this.idempotency.delete(request.idempotency_key); this.active = undefined; this.pendingStarts.delete(request.idempotency_key)
      rejectPending(error); throw error
    }
    this.pendingStarts.delete(request.idempotency_key); resolvePending(cloneView(view))
    const watchdog = new ReporterProgressWatchdog(request.budget.timeout_ms)
    const signal = AbortSignal.any([controller.signal, this.host.lifetime, watchdog.signal])
    void this.execute(record, request, signal, route.invoke, watchdog).catch(error => {
      if (record.view.status === 'running') this.update(record, { status: signal.aborted ? 'cancelled' : 'failed', phase: '结束', error_code: safeCode(error) })
    }).finally(() => { if (this.active === id) this.active = undefined })
    return cloneView(view)
  }

  list(): ReporterAutonomousRunView[] { return [...this.records.values()].map(item => item.view).sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 20).map(cloneView) }
  get(id: string): ReporterAutonomousRunView | undefined { const value = this.records.get(id)?.view; return value && cloneView(value) }
  cancel(id: string): ReporterAutonomousRunView {
    const record = this.records.get(id)
    if (!record) throw new ReporterAutonomousRunError(404, 'run_not_found', 'Reporter 运行不存在')
    if (record.view.status === 'running') record.controller.abort(new Error('cancelled'))
    return cloneView(record.view)
  }

  /** Runtime 初始化后重试已持久化的终态待交付报告；接收端以 run ID 去重。 */
  async resumePendingDeliveries(): Promise<void> {
    const pending = [...this.records.values()].filter(record => record.view.status !== 'running' && record.view.report_delivery.status === 'pending')
    for (const record of pending) await this.deliverTerminalReport(record)
  }

  /** 显式重试失败报告；不会重新运行 Explorer、Simulator 或 Reporter 模型。 */
  async retryReport(id: string): Promise<ReporterAutonomousRunView> {
    const record = this.records.get(id)
    if (!record) throw new ReporterAutonomousRunError(404, 'run_not_found', 'Reporter 运行不存在')
    if (record.view.status === 'running') throw new ReporterAutonomousRunError(409, 'report_not_ready', 'Reporter 运行尚未结束')
    if (record.view.report_delivery.status === 'delivered') return cloneView(record.view)
    if (record.view.report_delivery.status !== 'pending') this.update(record, { report_delivery: { status: 'pending' } })
    await this.deliverTerminalReport(record)
    return cloneView(record.view)
  }

  private update(record: RunRecord, change: Partial<ReporterAutonomousRunView>): void {
    Object.assign(record.view, change, { updated_at: this.now() })
    this.append(record.view.id, { type: 'updated', view: cloneView(record.view) })
  }

  private append(id: string, record: PersistedRun): void {
    const line = `${json(record)}\n`, size = Buffer.byteLength(line), file = this.file(id)
    if ((this.eventCounts.get(id) ?? 0) >= RUN_LIMIT.events || size > RUN_LIMIT.eventBytes || this.totalBytes + size > RUN_LIMIT.bytes
      || (existsSync(file) && statSync(file).size + size > RUN_LIMIT.fileBytes)) {
      throw new ReporterAutonomousRunError(409, 'run_evidence_limit', 'Reporter 运行证据达到存储上限')
    }
    const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600)
    try { fchmodSync(fd, 0o600); writeSync(fd, line); fsyncSync(fd); this.totalBytes += size; this.eventCounts.set(id, (this.eventCounts.get(id) ?? 0) + 1) }
    finally { closeSync(fd) }
  }

  private load(): void {
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const file = join(this.directory, entry.name), size = statSync(file).size
      this.totalBytes += size
      if (size > RUN_LIMIT.fileBytes || this.totalBytes > RUN_LIMIT.bytes) throw new ReporterAutonomousRunError(409, 'run_evidence_corrupt', 'Reporter 运行证据超过存储上限')
      const bytes = readFileSync(file), lastNewline = bytes.lastIndexOf(0x0a)
      if (lastNewline !== bytes.length - 1) { truncateSync(file, lastNewline + 1); this.totalBytes -= bytes.length - lastNewline - 1 }
      const lines = bytes.subarray(0, Math.max(lastNewline + 1, 0)).toString('utf8').split('\n').filter(Boolean)
      if (lines.length > RUN_LIMIT.events) throw new ReporterAutonomousRunError(409, 'run_evidence_corrupt', 'Reporter 运行证据事件数超过上限')
      let started: PersistedStart | undefined, latest: ReporterAutonomousRunView | undefined, report: ReporterAutonomousReport | undefined
      try {
        for (const line of lines) {
          const record = JSON.parse(line) as PersistedRun
          if (record.type === 'started') { started = record; latest = cloneView(record.view) }
          else if (record.type === 'updated' && started) latest = cloneView(record.view)
          else if (record.type === 'report-prepared' && started && latest) {
            if (record.report.run_id !== latest.id || (report && stable(report) !== stable(record.report))) throw new Error('invalid prepared report')
            report = record.report
          }
          else throw new Error('invalid run journal')
        }
      } catch { throw new ReporterAutonomousRunError(409, 'run_evidence_corrupt', 'Reporter 运行轨迹损坏') }
      if (!started || !latest || this.file(latest.id) !== file) throw new ReporterAutonomousRunError(409, 'run_evidence_corrupt', 'Reporter 运行轨迹缺少身份记录')
      if (latest.status === 'running') { latest = { ...latest, status: 'incomplete', phase: '运行进程已重启', updated_at: this.now(), error_code: 'runtime_restarted' } }
      const controller = new AbortController(), value: RunRecord = { digest: started.digest, idempotencyKey: started.idempotency_key, view: latest, controller,
        ...(report ? { report } : {}), progressPersistedAtMs: latest.progress ? Date.parse(latest.progress.at) : Date.now() }
      this.records.set(latest.id, value); this.idempotency.set(value.idempotencyKey, latest.id)
      this.eventCounts.set(latest.id, lines.length)
      if (latest.status !== 'incomplete' || latest.error_code !== 'runtime_restarted') continue
      this.append(latest.id, { type: 'updated', view: cloneView(latest) })
    }
  }
  private file(id: string): string { return join(this.directory, `${hash(id)}.jsonl`) }

  private async execute(record: RunRecord, request: ReporterAutonomousRunRequest, signal: AbortSignal, modelInvoker: ReporterModelInvoker,
    watchdog: ReporterProgressWatchdog): Promise<void> {
    const { view } = record, scenarios: string[] = [], actor = this.host.allowedActors(request.project_source_id)[0]
    const observations: ReporterExperimentEvidence[] = []
    let calls = 0, tokens = 0, tokenKnown = true, tokenBudgetExceeded = false, actions = 0, experiments = 0, finalSummary = '', incompleteReason = ''
    const budgetLeft = () => ({ total_tokens: Math.max(0, request.budget.max_total_tokens - tokens) })
    const invoke: ReporterModelInvoker = async (modelRequest: ReporterModelRequest): Promise<ReporterModelResponse> => {
      signal.throwIfAborted()
      if (calls >= request.budget.max_model_calls) throw new ReporterAutonomousRunError(409, 'model_call_budget', '模型调用次数达到上限')
      if (!tokenKnown) throw new ReporterAutonomousRunError(409, 'usage_unknown', '上次模型调用 Token 用量未知，已停止后续调用')
      if (tokenBudgetExceeded) throw new ReporterAutonomousRunError(409, 'token_budget_exceeded', '已知模型用量超过 Token 预算，已停止后续调用')
      if (tokens >= request.budget.max_total_tokens) throw new ReporterAutonomousRunError(409, 'token_budget', 'Token 预算已耗尽')
      calls++; this.update(record, { model_calls: calls })
      const started = Date.now()
      let response: ReporterModelResponse
      try {
        const forward = modelRequest.onProgress
        response = await abortable(modelInvoker({ ...modelRequest, remaining_budget: budgetLeft(), onProgress: () => {
          if (signal.aborted || record.view.status !== 'running') return
          forward?.()
          this.recordProgress(record, watchdog, 'model_stream')
        } }), signal)
        signal.throwIfAborted()
        this.recordProgress(record, watchdog, 'model_call')
      }
      catch (error) { this.updateModelUsage(record, undefined, Date.now() - started); throw error }
      const usage = parseUsage(response.usage)
      if (usage === undefined || usage.prompt_tokens === undefined || usage.completion_tokens === undefined) tokenKnown = false
      else tokens += usage.prompt_tokens + usage.completion_tokens
      if (tokens > request.budget.max_total_tokens) tokenBudgetExceeded = true
      this.updateModelUsage(record, usage, Date.now() - started)
      return response
    }
    try {
      for (let index = 0; index < request.budget.max_experiments; index++) {
        signal.throwIfAborted()
        if (calls >= request.budget.max_model_calls) { incompleteReason ||= 'model_call_budget'; break }
        if (!tokenKnown) { incompleteReason ||= 'usage_unknown'; break }
        if (tokenBudgetExceeded || tokens >= request.budget.max_total_tokens) { incompleteReason ||= 'token_budget_exceeded'; break }
        this.update(record, { phase: '自主选择测试方向', experiments })
        const effectivePermissions = {
          simulation: request.permissions.simulation && ['simulation', 'both'].includes(request.mode),
          read_only_service: request.permissions.read_only_service && ['real-service', 'both'].includes(request.mode),
          browser: request.permissions.browser && request.mode === 'browser' && !!this.host.browser,
        }
        const explorerInput: ReporterExplorerInput = { goal: request.goal, mode: request.mode, permissions: effectivePermissions,
          remaining: { experiments: request.budget.max_experiments - experiments,
            actions: request.budget.max_actions - actions, model_calls: request.budget.max_model_calls - calls, tokens: budgetLeft().total_tokens },
            capabilities: PRODUCT_CAPABILITIES, project: this.host.resolveProject(request.project_source_id), safe_state: this.host.safeState(request.project_source_id),
            available_read_only_probes: effectivePermissions.read_only_service ? [...ProbeIds] : [],
            can_simulate_users: effectivePermissions.simulation, can_test_browser: effectivePermissions.browser,
            previous_experiments: observations }
        const decisionResponse = await invoke({ role: 'autonomous-explorer', instructions: EXPLORER_INSTRUCTIONS,
          input: explorerInput,
          signal, remaining_budget: budgetLeft() })
        if (!tokenKnown) { incompleteReason = 'usage_unknown'; break }
        if (tokenBudgetExceeded) { incompleteReason = 'token_budget_exceeded'; break }
        const decision = parseDecision(decisionResponse.output)
        if (!decision) { incompleteReason = 'invalid_explorer_output'; this.addFinding(view, { severity: 'warning', status: 'invalid-test', title: '探索者输出无法解析', evidence: ['自主规划结果不符合允许的实验格式'], reproduction: [] }); break }
        if (decision.kind === 'finished') { finalSummary = decision.summary; break }
        if (!modeAllowed(decision.kind, request)) { incompleteReason = 'permission_denied'; this.addFinding(view, { severity: 'warning', status: 'invalid-test', title: '探索者选择了未授权能力', evidence: [decision.kind], reproduction: [] }); break }
        experiments++; this.update(record, { experiments })
        const logIndex = view.experiment_log.length
        this.pushExperiment(record, { kind: decision.kind, hypothesis: decision.hypothesis, observation: '探索者已选择此实验，正在执行。', evidence: [] })
        if (decision.kind === 'simulation') {
          if (actions + 2 > request.budget.max_actions) { incompleteReason = 'action_budget'; break }
          const scenarioId = `${view.id}-e${experiments}`
          scenarios.push(scenarioId); view.scenario_ids = [...scenarios]
          this.host.reporter.registerScenario(makeScenario(request, scenarioId, actor!, decision))
          this.update(record, { scenario_ids: [...scenarios], phase: '仿真用户逐轮测试' })
          const remainingActions = request.budget.max_actions - actions
          const result = await runUserSimulator({ reporter: this.host.reporter, scenarioId, invoke,
            waitForSuperagent: (childSignal, onProgress) => this.host.waitForSuperagent(scenarioId, childSignal, onProgress), maxTurns: remainingActions, minTurns: 2,
            onProgress: progress => {
              if (progress.phase === 'model_stream' || progress.phase === 'model_call') return // 已由统一模型调用边界记录。
              if (progress.phase === 'target_state') { this.recordProgress(record, watchdog, 'target_state'); return }
              if (progress.phase === 'action_submitted') this.recordProgress(record, watchdog, 'user_action')
              if (progress.phase === 'target_completed') this.recordProgress(record, watchdog, 'target_state')
              const phase = progress.phase === 'target_waiting' ? '等待被测 Superagent' : progress.phase === 'target_completed' ? '读取目标真实回复' : '提交仿真用户动作'
              this.update(record, { phase, turns: actions + progress.turns })
              if (progress.phase === 'action_submitted' || progress.phase === 'target_completed') {
                this.updateExperiment(record, logIndex, { evidence: [...view.experiment_log[logIndex]!.evidence, `sequence:${progress.sequence}:${progress.phase}`] })
              }
            },
            validateAction: (action, turn) => turn > 0 || (action.kind === 'message' && action.addressed === 'mention'),
            budget: { max_calls: Math.max(1, request.budget.max_model_calls - calls), max_total_tokens: Math.max(1, request.budget.max_total_tokens - tokens), timeout_ms: request.budget.timeout_ms }, signal })
          actions += result.turns; this.update(record, { turns: actions, phase: '检查仿真证据' })
          const report = result.report ?? this.host.reporter.scenario(scenarioId)
          const evidence = `status=${result.status}; stop=${result.stop_reason}; actions=${result.turns}; snapshot=${report?.snapshot_available ?? false}; outputs=${report?.outputs.length ?? 0}`
          observations.push({ kind: 'simulation', hypothesis: decision.hypothesis, observation: evidence, evidence: report?.inputs.map(item => `trigger:${item.trigger.id}`) ?? [], scenario_id: scenarioId })
          this.updateExperiment(record, logIndex, { kind: 'simulation', hypothesis: decision.hypothesis, observation: evidence,
            evidence: [...view.experiment_log[logIndex]!.evidence, ...(report?.inputs.map(item => `trigger:${item.trigger.id}`) ?? [])], scenario_id: scenarioId,
            public_transcript: report ? publicScenarioTranscript(report) : [] })
          if (result.status !== 'completed') {
            const errorCode = result.error_code ?? result.stop_reason
            const invalidTest = isInvalidTestCode(errorCode)
            const validationEvidence = result.validation_issues?.map(issue => `schema:${issue.path}:${issue.code}`) ?? []
            this.addFinding(view, { severity: 'warning', status: invalidTest ? 'invalid-test' : 'candidate',
              title: invalidTest ? '仿真输入或动作未通过校验' : '仿真测试未完整结束', evidence: [evidence, errorCode, ...validationEvidence], reproduction: [] })
            this.updateExperiment(record, logIndex, { evidence: [...view.experiment_log[logIndex]!.evidence, ...validationEvidence] })
            incompleteReason = errorCode
            break
          }
          if (!report?.outputs.length) { incompleteReason ||= 'target_no_visible_response'; this.addFinding(view, { severity: 'warning', status: 'candidate',
            title: '没有观察到被测系统的公开回复', evidence: [evidence], reproduction: report?.inputs.map(item => `用户动作 ${item.envelope.sequence}: ${item.trigger.text}`) ?? [] }) }
          if (!report?.snapshot_available) { incompleteReason = 'snapshot_unavailable'; this.addFinding(view, { severity: 'warning', status: 'candidate',
            title: '仿真未取得确定性状态证据', evidence: ['运行时快照不可用'], reproduction: [] }) }
          const failedChecks = report?.oracle.checks.filter(check => !check.passed) ?? []
          for (const check of failedChecks) {
            const acceptFailed = check.assertion.kind === 'decision' && check.assertion.decision === 'accept'
            incompleteReason ||= acceptFailed ? 'oracle_failed' : 'oracle_precondition_failed'
            this.addFinding(view, { severity: acceptFailed ? 'error' : 'warning', status: acceptFailed ? 'candidate' : 'invalid-test',
              title: acceptFailed ? '明确授权请求未得到预期接单决定' : '仿真输入未满足确定性前置条件',
              evidence: [acceptFailed ? '确定性检查未观察到预期的请求处理结果。' : '确定性输入检查未通过。',
                ...(report?.inputs.map(item => `trigger:${item.trigger.id}`) ?? [])],
              reproduction: (report?.inputs ?? []).map(item => `用户动作 ${item.envelope.sequence}: ${item.trigger.text}`) })
          }
          const review = await runQualitativeReviewer({ reporter: this.host.reporter, scenarioId, invoke,
            budget: { max_calls: Math.max(1, request.budget.max_model_calls - calls), max_total_tokens: Math.max(1, request.budget.max_total_tokens - tokens), timeout_ms: request.budget.timeout_ms }, signal })
          if (review.report?.review) {
            finalSummary = review.report.review.summary
            for (const item of review.report.review.findings) this.addFinding(view, { severity: item.severity, status: 'candidate', title: item.text,
              evidence: item.evidence ?? [], reproduction: observations.flatMap(value => [value.observation]) })
          }
          if (review.status !== 'recorded') { incompleteReason ||= review.stop_reason; this.addFinding(view, { severity: 'info', status: 'candidate', title: '定性审查未完成', evidence: [review.stop_reason], reproduction: [] }) }
        } else if (decision.kind === 'real-service') {
          this.update(record, { phase: '调用只读管理服务' })
          const first = await this.host.probeReadOnly(decision.probe_id, signal)
          const second = first.status >= 500 ? await this.host.probeReadOnly(decision.probe_id, signal) : undefined
          this.recordProgress(record, watchdog, 'service_probe')
          const evidence = `GET ${decision.probe_id} returned ${first.status}; json=${first.json}; ${first.body.slice(0, 2_000)}`
          const experiment = { kind: 'real-service' as const, hypothesis: decision.hypothesis, observation: evidence,
            evidence: [`GET /orchestrator/api/${decision.probe_id}`, `HTTP ${first.status}`, ...(second ? [`重复 GET HTTP ${second.status}`] : [])] }
          observations.push(experiment); this.updateExperiment(record, logIndex, experiment)
          if (first.status >= 500 && second?.status === first.status) this.addFinding(view, { severity: 'error', status: 'confirmed', title: '只读管理接口重复返回服务端错误', evidence: experiment.evidence,
            reproduction: [`GET /orchestrator/api/${decision.probe_id}`] })
          else if (first.status >= 500) this.addFinding(view, { severity: 'warning', status: 'candidate', title: '只读管理接口出现一次服务端错误，需复核', evidence: experiment.evidence,
            reproduction: [`GET /orchestrator/api/${decision.probe_id}`] })
          else if (first.status !== 200 || !first.json) { incompleteReason ||= 'probe_invalid'; this.addFinding(view, { severity: 'warning', status: 'candidate', title: '只读接口返回了不可判定的目标结果', evidence: experiment.evidence,
            reproduction: [`GET /orchestrator/api/${decision.probe_id}`] }) }
        } else {
          if (!request.permissions.browser || !this.host.browser) throw new ReporterAutonomousRunError(503, 'browser_unavailable', '浏览器测试驱动不可用')
          const experiment = await this.runBrowserExperiment(record, decision.hypothesis, request, signal, invoke,
            () => ({ known: tokenKnown, exceeded: tokenBudgetExceeded }), watchdog)
          if (experiment) {
            observations.push(experiment); this.updateExperiment(record, logIndex, experiment)
            if (experiment.incomplete) incompleteReason ||= experiment.error_code ?? 'browser_action_budget'
            if (experiment.error_code === 'browser_no_action') this.addFinding(view, { severity: 'warning', status: 'invalid-test',
              title: '浏览器探索没有执行成功的控件操作', evidence: experiment.evidence.slice(0, 10), reproduction: [] })
          }
        }
      }
      if (observations.some(item => item.kind !== 'simulation') && observations.length) {
        this.update(record, { phase: '独立定性审查' })
        if (!tokenKnown) incompleteReason ||= 'usage_unknown'
        else if (calls >= request.budget.max_model_calls || tokenBudgetExceeded || tokens >= request.budget.max_total_tokens) incompleteReason ||= 'review_budget_exhausted'
        else {
          try {
            const simulationEvidence = scenarios.flatMap(id => {
              const evidence = this.host.reporter.reviewEvidence(id)
              return evidence ? [evidence] : []
            })
            const reviewerInput: ReporterAutonomousReviewInput = { goal: request.goal, experiments: record.view.experiment_log.map(item => ({ kind: item.kind, hypothesis: item.hypothesis,
                observation: item.observation, evidence: item.evidence, ...(item.browser_steps ? { browser_steps: structuredClone(item.browser_steps) } : {}) })), simulations: simulationEvidence,
                instruction: '只归纳可见证据并列候选问题；不要判定或改写确定性结果。' }
            const reviewResponse = await invoke({ role: 'qualitative-reviewer', instructions: REPORTER_REVIEWER_INSTRUCTIONS,
              input: reviewerInput,
              signal, remaining_budget: budgetLeft() })
            const review = parseReporterReviewerOutput(reviewResponse.output)
            if (!review) incompleteReason ||= 'invalid_reviewer_output'
            else {
              finalSummary = review.summary
              for (const item of review.findings) this.addFinding(view, { severity: item.severity, status: 'candidate', title: item.text,
                evidence: item.evidence ?? [], reproduction: observations.map(value => value.observation) })
              this.update(record, { findings: view.findings })
            }
          } catch (error) { incompleteReason ||= safeCode(error); this.addFinding(view, { severity: 'info', status: 'candidate',
            title: '独立定性审查未完成', evidence: [safeCode(error)], reproduction: [] }); this.update(record, { findings: view.findings }) }
        }
      }
      signal.throwIfAborted()
      const validExperiments = observations.length > 0, isIncomplete = !validExperiments || !tokenKnown || tokenBudgetExceeded || !!incompleteReason
      this.update(record, { status: isIncomplete ? 'incomplete' : 'completed', phase: '结束', summary: finalSummary || summaryFrom(observations),
        ...(!tokenKnown ? { error_code: 'usage_unknown' } : tokenBudgetExceeded ? { error_code: 'token_budget_exceeded' } : incompleteReason ? { error_code: incompleteReason } : {}) })
    } catch (error) {
      const cancelled = record.controller.signal.aborted || this.host.lifetime.aborted
      const stalled = watchdog.stalled || error instanceof ReporterProgressStalledError
      const errorCode = stalled ? 'progress_stalled' : safeCode(error)
      this.update(record, { status: cancelled ? 'cancelled' : (stalled || isExpectedIncomplete(error)) ? 'incomplete' : 'failed', phase: '结束',
        error_code: errorCode, summary: finalSummary || summaryFrom(observations) })
      if (!cancelled) { const invalidTest = isInvalidTestCode(errorCode)
        this.addFinding(view, { severity: 'warning', status: invalidTest ? 'invalid-test' : 'candidate',
          title: invalidTest ? '自主测试输出或权限未通过校验' : '自主测试遇到模型、运行环境或目标错误', evidence: [errorCode], reproduction: [] })
        this.update(record, { findings: view.findings }) }
    } finally {
      watchdog.dispose()
      await this.deliverTerminalReport(record)
    }
  }

  private async deliverTerminalReport(record: RunRecord): Promise<void> {
    if (record.view.status === 'running' || record.view.report_delivery.status === 'delivered') return
    if (record.view.report_delivery.status !== 'pending') this.update(record, { report_delivery: { status: 'pending' } })
    if (!record.report) {
      const report: ReporterAutonomousReport = {
        run_id: record.view.id, goal: record.view.goal, project_source_id: record.view.project_source_id, mode: record.view.mode,
        status: record.view.status, summary: record.view.summary ?? summaryFrom(record.view.experiment_log),
        model: structuredClone(record.view.model), model_usage: structuredClone(record.view.model_usage),
        experiments: record.view.experiment_log.map(experiment => {
          if (experiment.kind !== 'simulation' || !experiment.scenario_id) return structuredClone(experiment)
          const scenario = this.host.reporter.scenario(experiment.scenario_id)
          return { ...structuredClone(experiment), ...(experiment.public_transcript ? {} : scenario ? { public_transcript: publicScenarioTranscript(scenario) } : {}),
            oracle_status: !scenario?.snapshot_available ? 'unavailable' as const : scenario.oracle.passed ? 'passed' as const : 'failed' as const }
        }), findings: structuredClone(record.view.findings ?? []),
        ...(record.view.error_code ? { error_code: record.view.error_code } : {}),
      }
      try {
        // 先把不可变的安全 payload 持久化，再调用 DSH；重试与崩溃恢复必须复用同一正文。
        this.append(record.view.id, { type: 'report-prepared', report })
        record.report = report
      } catch {
        this.update(record, { report_delivery: { status: 'failed', error_code: 'report_delivery_prepare_failed' } })
        return
      }
    }
    try {
      const result = await this.host.deliverReport({ runId: record.view.id, report: structuredClone(record.report) })
      if (typeof result.masterSessionId !== 'string' || !result.masterSessionId.trim()) {
        throw new ReporterAutonomousRunError(503, 'report_delivery_session_missing', '主会话未返回有效会话 ID')
      }
      this.update(record, { report_delivery: { status: 'delivered', master_session_id: result.masterSessionId } })
    } catch (error) {
      this.update(record, { report_delivery: { status: 'failed', error_code: safeDeliveryCode(error) } })
    }
  }

  private async runBrowserExperiment(record: RunRecord, hypothesis: string, request: ReporterAutonomousRunRequest, signal: AbortSignal,
    invoke: ReporterModelInvoker, budgetState: () => { known: boolean; exceeded: boolean }, watchdog: ReporterProgressWatchdog)
    : Promise<ReporterAutonomousExperiment & { incomplete?: boolean; error_code?: string } | undefined> {
    const driver = await this.host.browser!.create(signal), evidence: string[] = [], lines: string[] = []
    try {
      let page = await driver.observe(signal)
      this.recordProgress(record, watchdog, 'browser_observation')
      let successfulControlActions = 0
      const browserSteps: ReporterAutonomousBrowserStep[] = []
      const logIndex = record.view.experiment_log.length - 1
      const appendStep = (step: ReporterAutonomousBrowserStep) => {
        browserSteps.push(step)
        evidence.push(`step:${step.index}:${step.result}:${step.error_code ?? step.page.path}`)
        if (step.snapshot) evidence.push(`snapshot:${step.index}:${step.snapshot}`)
        this.updateExperiment(record, logIndex, { browser_steps: [...browserSteps], evidence: [...evidence],
          observation: browserObservationSummary(browserSteps) })
      }
      const pageState = (observation: ReporterBrowserObservation): ReporterAutonomousBrowserStep['page'] => ({
        path: observation.path, title: observation.title.slice(0, 160), page_errors: observation.page_errors,
        console_errors: observation.console_errors, blocked_requests: observation.blocked_requests.slice(0, 20).map(item => ({
          method: item.method.slice(0, 16), pathname: item.pathname.slice(0, 240),
        })), blocked_console_errors: observation.blocked_console_errors,
      })
      const recordObservation = (action: ReporterAutonomousBrowserStep['action'], result: ReporterAutonomousBrowserStep['result'],
        observation: ReporterBrowserObservation, errorCode?: string) => {
        const snapshot = observation.accessibility_snapshot.slice(0, BROWSER_STEP_SNAPSHOT_CHARS)
        const step: ReporterAutonomousBrowserStep = { index: browserSteps.length + 1, action, result, page: pageState(observation),
          ...(errorCode ? { error_code: errorCode } : {}), ...(snapshot ? { snapshot } : {}) }
        appendStep(step)
        lines.push(`step ${step.index}: ${JSON.stringify({ action, result, page: step.page, ...(errorCode ? { error_code: errorCode } : {}), snapshot })}`)
      }
      recordObservation('initial-observation', 'observed', page)
      for (let i = 0; i < request.budget.max_actions; i++) {
        signal.throwIfAborted(); this.update(record, { phase: '真人浏览器操作仿真' })
        const browserInput: ReporterBrowserModelInput = { hypothesis, observation: page, previous: lines,
          permissions: '只读；不得提交、推送、发外部消息或修改文件' }
        const response = await invoke({ role: 'browser-tester', instructions: BROWSER_INSTRUCTIONS,
          input: browserInput,
          signal, remaining_budget: { total_tokens: request.budget.max_total_tokens } })
        const currentBudget = budgetState()
        if (!currentBudget.known || currentBudget.exceeded) return { kind: 'browser', hypothesis,
          observation: browserObservationSummary(browserSteps, !currentBudget.known ? '模型 Token 用量未知，已停止操作。' : '模型 Token 预算已超出，已停止操作。'),
          evidence, browser_steps: browserSteps, incomplete: true, error_code: !currentBudget.known ? 'usage_unknown' : 'token_budget_exceeded' }
        const step = parseBrowserStep(response.output)
        if (!step) throw new ReporterAutonomousRunError(400, 'invalid_browser_action', '浏览器探索动作输出无效')
        if (step.kind === 'finished') {
          if (successfulControlActions > 0) return { kind: 'browser', hypothesis, observation: browserObservationSummary(browserSteps, step.summary), evidence, browser_steps: browserSteps }
          return { kind: 'browser', hypothesis, observation: browserObservationSummary(browserSteps, `${step.summary} 尚未执行成功的控件操作。`), evidence, browser_steps: browserSteps,
            incomplete: true, error_code: 'browser_no_action' }
        }
        if (step.kind === 'act') {
          this.update(record, { turns: record.view.turns + 1 })
          let result: 'completed' | 'failed' | 'observed' = 'completed', errorCode: string | undefined
          try {
            const actionResult = await driver.act(step.action, signal)
            this.recordProgress(record, watchdog, step.action.kind === 'snapshot' ? 'browser_observation' : 'browser_action')
            page = actionResult.observation
            if (step.action.kind === 'snapshot') result = 'observed'
            else successfulControlActions++
          } catch (error) {
            const code = safeCode(error)
            if (!['browser_action_not_unique', 'browser_action_failed'].includes(code)) throw error
            result = 'failed'; errorCode = code
            page = await driver.observe(signal)
            this.recordProgress(record, watchdog, 'browser_observation')
          }
          recordObservation(step.action, result, page, errorCode)
        } else { page = await driver.observe(signal); this.recordProgress(record, watchdog, 'browser_observation') }
        if (step.kind === 'observe') recordObservation({ kind: 'snapshot' }, 'observed', page)
      }
      return { kind: 'browser', hypothesis, observation: browserObservationSummary(browserSteps, '浏览器动作预算已耗尽。'), evidence, browser_steps: browserSteps, incomplete: true,
        error_code: successfulControlActions > 0 ? 'browser_action_budget' : 'browser_no_action' }
    } finally { await driver.close() }
  }

  /** Token 增量只改内存；真实动作边界会由紧随其后的实验/阶段更新持久化。 */
  private recordProgress(record: RunRecord, watchdog: ReporterProgressWatchdog, kind: ReporterProgressKind): void {
    if (record.view.status !== 'running') return
    watchdog.pulse()
    const at = this.now(), progress = { at, kind }
    record.view.progress = progress
    const nowMs = Date.now()
    // 动作/阶段边界紧随其后会持久化完整 RunView；状态流事件单独节流到最多每分钟一次。
    if (kind !== 'model_stream' && kind !== 'target_state') {
      record.progressPersistedAtMs = nowMs
      return
    }
    if (record.progressPersistedAtMs === undefined || nowMs - record.progressPersistedAtMs >= PROGRESS_PERSIST_INTERVAL_MS) {
      record.progressPersistedAtMs = nowMs
      this.update(record, { progress })
    }
  }

  private pushExperiment(record: RunRecord, value: ReporterAutonomousRunView['experiment_log'][number]): void {
    this.update(record, { experiment_log: [...record.view.experiment_log, { ...value, observation: value.observation.slice(0, 8_000), evidence: value.evidence.slice(0, 30) }] })
  }
  private updateExperiment(record: RunRecord, index: number, change: Partial<ReporterAutonomousRunView['experiment_log'][number]>): void {
    const item = record.view.experiment_log[index]
    if (!item) return
    const experiment_log = record.view.experiment_log.map((value, position) => position === index ? { ...value, ...change,
      observation: (change.observation ?? value.observation).slice(0, 8_000), evidence: (change.evidence ?? value.evidence).slice(-30) } : value)
    this.update(record, { experiment_log })
  }
  private updateModelUsage(record: RunRecord, usage: ReturnType<typeof parseUsage>, measuredLatency: number): void {
    const current = record.view.model_usage, first = record.view.model_calls === 1
    const sum = (previous: number | null, next: number | undefined): number | null => {
      if (next === undefined) return null
      if (first) return next
      if (previous === null) return null
      return previous + next
    }
    const prompt_tokens = sum(current.prompt_tokens, usage?.prompt_tokens)
    const completion_tokens = sum(current.completion_tokens, usage?.completion_tokens)
    const cost_usd = sum(current.cost_usd, usage?.cost_usd)
    const latency_ms = sum(current.latency_ms, usage?.latency_ms ?? measuredLatency)
    const retries = sum(current.retries, usage?.retries)
    const tokenComplete = usage?.prompt_tokens !== undefined && usage.completion_tokens !== undefined
    const completeness = !usage ? 'unknown' : !tokenComplete ? 'unknown' : cost_usd === null || retries === null ? 'partial' : 'reported'
    this.update(record, { model_usage: { prompt_tokens, completion_tokens, cost_usd, latency_ms, retries, completeness } })
  }
  private addFinding(view: ReporterAutonomousRunView, finding: ReporterAutonomousRunView['findings'] extends (infer T)[] | undefined ? T : never): void {
    view.findings = [...view.findings ?? [], finding as NonNullable<ReporterAutonomousRunView['findings']>[number]].slice(0, 100)
  }
}

const PRODUCT_CAPABILITIES = [
  '系统可接入多个 GitHub 和 GitLab 项目；每个工单绑定一个项目。',
  '对已授权用户的明确请求进行评估，创建隔离工单并由 Worker 执行；用户可追问或停止工单。',
  'Worker 可读取项目内容和报告结果；本轮 Reporter 只允许只读分析，不应提出提交、推送、真实平台消息或破坏性操作。',
  'Reporter 仿真动作经真实 Runtime/Engine；Agent 的本地回复会返回给模拟器，测试消息不发送到 GitHub/GitLab。',
  '管理服务提供运行状态、来源、工单、线程和决定的只读接口。',
]
const EXPLORER_INSTRUCTIONS = `你是自主测试探索者。根据产品目标、能力清单、只读安全状态和之前的实际观察，自主选择一个最有信息价值且安全的实验；不要复述或索要预设测试步骤。只能输出 JSON：simulation={kind,hypothesis,goal,persona} 让独立模拟用户生成多轮用户动作；real-service={kind,hypothesis,probe_id} 选择一个已列出的 GET 管理接口；browser={kind,hypothesis} 仅在浏览器权限可用时选择；或 finished={kind,summary}。不要直接生成用户动作，也不能看到或指定隐藏 Oracle。模拟目标应是明确、有限的只读仓库分析；用户模拟器的首条动作须明确提出目标并 @agent-bot。不得要求代码修改、commit、push、真实 GitHub/GitLab 消息、密钥或破坏性操作。一个实验结束后依据反馈再决定是否继续。`
const BROWSER_INSTRUCTIONS = `你是受限浏览器测试者。只基于当前 accessibility snapshot 验证可见页面；只能输出 JSON：{"kind":"observe"}、{"kind":"act","action":{"kind":"click","role":"button|tab","name":"控件无障碍名称"}}、{"kind":"act","action":{"kind":"fill","role":"textbox|searchbox|combobox","name":"控件无障碍名称","value":"文本"}}、{"kind":"act","action":{"kind":"press","role":"textbox|searchbox|combobox","name":"控件无障碍名称","key":"Enter|Escape|ArrowDown|ArrowUp|Space"}}、{"kind":"act","action":{"kind":"back"}}、{"kind":"act","action":{"kind":"snapshot"}} 或 {"kind":"finished","summary":"..."}。不得输出 URL、CSS selector、脚本、上传下载、提交、推送、外部消息、表单保存或任何会改变业务状态的动作。`
function makeScenario(request: ReporterAutonomousRunRequest, id: string, actor: string, plan: Extract<z.infer<typeof ExploreDecisionSchema>, { kind: 'simulation' }>): ReporterScenarioDefinition {
  return { id, version: 1, project_source_id: request.project_source_id, thread_id: '1', thread_kind: 'issue', title: plan.hypothesis,
    visible: { persona: plan.persona, goal: plan.goal, instructions: [
      '第一条用户动作必须是 kind 为 message 的动作，并显式设置 addressed: "mention"，同时在消息正文中直接提及 Agent；这只是 Reporter 的本地路由格式要求。只读分析，不修改文件，不提交或推送代码，不发送真实平台消息。',
    ] },
    actors: [{ id: actor, role: 'person' }], oracle: { assertions: [{ kind: 'receive', sequence: 1, result: 'stored' }, { kind: 'decision', decision: 'accept', sequence: 1 }] },
    timeout_ms: request.budget.timeout_ms }
}
function modeAllowed(kind: 'simulation' | 'real-service' | 'browser', request: ReporterAutonomousRunRequest): boolean {
  return kind === 'simulation' ? request.permissions.simulation && ['simulation', 'both'].includes(request.mode)
    : kind === 'real-service' ? request.permissions.read_only_service && ['real-service', 'both'].includes(request.mode)
      : request.permissions.browser && request.mode === 'browser'
}
function safeCode(error: unknown): string {
  if (error instanceof ReporterAutonomousRunError) return error.code
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code.slice(0, 120)
  return 'reporter_run_failed'
}
function safeDeliveryCode(error: unknown): string {
  const code = safeCode(error)
  return /^report_delivery_[a-z0-9_]{1,80}$/.test(code) ? code : 'report_delivery_failed'
}
function isInvalidTestCode(code: string): boolean {
  return ['invalid_browser_action', 'invalid_explorer_output', 'invalid_request', 'invalid_simulator_output', 'no_allowed_actor',
    'oracle_precondition_failed', 'permission_denied', 'project_mismatch', 'simulator_action_out_of_scope', 'simulator_finished_too_early',
    'thread_mismatch', 'version_mismatch', 'actor_not_allowed', 'browser_no_action'].includes(code)
}
function isExpectedIncomplete(error: unknown): boolean { return error instanceof ReporterAutonomousRunError && [409, 503].includes(error.status) }
const ReporterUsageSchema = z.object({ model: z.string().max(200).optional(), prompt_tokens: z.number().int().nonnegative().optional(), completion_tokens: z.number().int().nonnegative().optional(),
  cost_usd: z.number().finite().nonnegative().optional(), latency_ms: z.number().finite().nonnegative().optional(), retries: z.number().int().nonnegative().optional() }).strict()
function parseUsage(value: unknown): z.infer<typeof ReporterUsageSchema> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const parsed = ReporterUsageSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
function parseDecision(value: unknown): z.infer<typeof ExploreDecisionSchema> | undefined {
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch { return undefined } }
  const parsed = ExploreDecisionSchema.safeParse(value); return parsed.success ? parsed.data : undefined
}
function parseBrowserStep(value: unknown): z.infer<typeof BrowserStepSchema> | undefined {
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch { return undefined } }
  const parsed = BrowserStepSchema.safeParse(value); return parsed.success ? parsed.data : undefined
}
function summaryFrom(items: { hypothesis: string; observation: string }[]): string {
  return items.length ? items.map(item => `${item.hypothesis}: ${item.observation.slice(0, 500)}`).join('\n') : '没有完成可判定的测试实验。'
}
function browserObservationSummary(steps: ReporterAutonomousBrowserStep[], note?: string): string {
  const actions = steps.filter(step => step.action !== 'initial-observation' && step.action.kind !== 'snapshot' && step.result === 'completed').length
  const observations = steps.filter(step => step.result === 'observed').length
  const failures = steps.filter(step => step.result === 'failed').length
  const currentPage = steps.at(-1)?.page
  return [
    `浏览器执行 ${steps.length} 步：成功控件操作 ${actions} 次，页面观察 ${observations} 次，动作失败 ${failures} 次。`,
    currentPage ? `当前页面：${currentPage.title}（${currentPage.path}）；页面错误 ${currentPage.page_errors}，控制台错误 ${currentPage.console_errors}。` : '',
    note?.slice(0, 1_000) ?? '',
  ].filter(Boolean).join('\n')
}
function publicScenarioTranscript(report: ReporterScenarioResult): ReporterAutonomousTranscriptMessage[] {
  const actorMessages: ReporterAutonomousTranscriptMessage[] = report.inputs.map(input => ({ sequence: input.envelope.sequence,
    role: 'actor', actor_id: input.envelope.actor_id, at: input.envelope.simulated_at, text: input.trigger.text.slice(0, 1_200) }))
  const superagentMessages: ReporterAutonomousTranscriptMessage[] = report.outputs.map(output => ({ sequence: output.sequence,
    role: 'superagent', kind: output.kind, at: output.at, text: output.text.slice(0, 1_200) }))
  return [...actorMessages, ...superagentMessages].sort((left, right) => left.sequence - right.sequence
    || (left.role === right.role ? left.at.localeCompare(right.at) : left.role === 'actor' ? -1 : 1)).slice(0, 40)
}

