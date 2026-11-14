/** 可选模型协调器：只接收注入的调用函数，不依赖 SDK，也不自行发起任何模型请求。 */
import { z } from 'zod'
import type { LocalReporter, ReporterReviewEvidence, ReporterScenarioResult, ReporterSimulatorFeedback, ReporterUsage } from './local-reporter.ts'
import type { ReporterAction, ReporterOutputKind } from './protocol.ts'
import { ReporterActionSchema } from './protocol.ts'

const SimulatorTurnSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('action'), actor_id: z.string().min(1).max(160), action: ReporterActionSchema,
    after_ms: z.number().int().nonnegative().max(86_400_000).default(0) }).strict(),
  z.object({ kind: z.literal('finished'), summary: z.string().max(1_000).optional() }).strict(),
])
/** 从实际的 Simulator 输出校验器生成，供 Prompt 与回归共用。 */
export const REPORTER_SIMULATOR_OUTPUT_JSON_SCHEMA = z.toJSONSchema(SimulatorTurnSchema, { target: 'draft-07', io: 'input' })
const ReviewerOutputSchema = z.object({ summary: z.string().min(1).max(8_000), findings: z.array(z.object({ severity: z.enum(['info', 'warning', 'error']),
  text: z.string().min(1).max(4_000), evidence: z.array(z.string().max(300)).max(20).optional() }).strict()).max(100) }).strict()
const ModelUsageSchema = z.object({ model: z.string().max(200).optional(), prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(), cost_usd: z.number().nonnegative().optional(), latency_ms: z.number().nonnegative().optional(),
  retries: z.number().int().nonnegative().optional() }).strict()

export type ReporterModelRole = 'autonomous-explorer' | 'user-simulator' | 'browser-tester' | 'qualitative-reviewer'
interface ReporterModelRequestBase {
  instructions: string
  signal: AbortSignal
  /** 尚未计量的最大预算；注入方可将它传给模型服务。 */
  remaining_budget: { cost_usd?: number; total_tokens?: number }
}
export interface ReporterExperimentEvidence { kind: 'simulation' | 'real-service' | 'browser'; hypothesis: string; observation: string; evidence: string[]; scenario_id?: string }
export interface ReporterExplorerInput {
  goal: string; mode: 'simulation' | 'real-service' | 'browser' | 'both'; permissions: { simulation: boolean; read_only_service: boolean; browser: boolean }
  remaining: { experiments: number; actions: number; model_calls: number; tokens: number }; capabilities: string[]
  project: { id: string; provider: string; host: string; project: string } | undefined; safe_state: unknown
  available_read_only_probes: string[]; can_simulate_users: boolean; can_test_browser: boolean; previous_experiments: ReporterExperimentEvidence[]
}
export interface ReporterBrowserModelInput {
  hypothesis: string; observation: import('./browser.ts').ReporterBrowserObservation; previous: string[]
  permissions: '只读；不得提交、推送、发外部消息或修改文件'
}
export interface ReporterAutonomousReviewInput {
  goal: string; experiments: ReporterExperimentEvidence[]; simulations: ReporterReviewEvidence[]
  instruction: '只归纳可见证据并列候选问题；不要判定或改写确定性结果。'
}
export type ReporterModelRequest = ReporterModelRequestBase
  & ({ role: 'autonomous-explorer'; input: ReporterExplorerInput }
    | { role: 'user-simulator'; input: ReporterSimulatorFeedback }
    | { role: 'browser-tester'; input: ReporterBrowserModelInput }
    | { role: 'qualitative-reviewer'; input: ReporterReviewEvidence | ReporterAutonomousReviewInput })
export interface ReporterModelResponse { output: unknown; usage?: unknown }
/** 由调用者提供的模型边界。该函数不会被 createLocalReporter 或 Runtime 自动调用。 */
export type ReporterModelInvoker = (request: ReporterModelRequest) => Promise<ReporterModelResponse>

export interface ReporterModelBudget {
  max_calls?: number
  max_cost_usd?: number
  max_total_tokens?: number
  timeout_ms?: number
}
export interface ReporterModelUsageSummary {
  calls: number
  cost_usd: number | null
  prompt_tokens: number | null
  completion_tokens: number | null
  latency_ms: number | null
  retries: number | null
  completeness: 'reported' | 'partial' | 'unknown'
}
export interface ReporterSimulatorRunResult {
  scenario_id: string
  status: 'completed' | 'incomplete' | 'invalid_output' | 'input_rejected'
  stop_reason: 'simulator_finished' | 'max_calls' | 'budget_exhausted' | 'usage_unknown' | 'timeout' | 'aborted' | 'invalid_output' | 'input_rejected'
  turns: number
  acknowledgements: ReturnType<LocalReporter['submit']>[]
  usage: ReporterModelUsageSummary
  report?: ReporterScenarioResult
  error_code?: string
  validation_issues?: ReporterSimulatorValidationIssue[]
}
export interface ReporterSimulatorValidationIssue { path: string; code: string }
export interface ReporterReviewerRunResult {
  scenario_id: string
  status: 'recorded' | 'invalid_output' | 'incomplete'
  stop_reason: 'review_recorded' | 'budget_exhausted' | 'usage_unknown' | 'timeout' | 'aborted' | 'invalid_output'
  usage: ReporterModelUsageSummary
  report?: ReporterScenarioResult
}

const SIMULATOR_INSTRUCTIONS = `你扮演场景中可见的用户或协作角色，遵守 Persona 和目标，根据最近可见对话逐步决定下一条用户动作；每次只输出一个对象，不要把后续动作一次性列出。结束时输出 kind 为 finished，可附简短 summary。动作 kind 的具体字段、必填字段、可选字段、取值范围和禁止额外字段均由下面的 JSON Schema 定义，请严格遵守，不要自行添加或改名字段。不要猜测或要求查看隐藏 Oracle、内部 Ticket 状态、运行时评分或未来测试步骤。若当前对话尚未满足目标，请继续作为真实用户自然追问。输出必须遵循此 JSON Schema：\n${JSON.stringify(REPORTER_SIMULATOR_OUTPUT_JSON_SCHEMA)}`
const REVIEWER_INSTRUCTIONS = `你是定性沟通审查者。只根据提供的轨迹、输出和结构化状态总结沟通质量、异常和证据。不要判定 behavioral_pass、delivery_pass 或 platform_pass，不要更改任何确定性结果。只输出 JSON：{"summary":"...","findings":[{"severity":"info|warning|error","text":"...","evidence":["轨迹序号或可见事件标识"]}]}。`
export const REPORTER_REVIEWER_INSTRUCTIONS = REVIEWER_INSTRUCTIONS
export function parseReporterReviewerOutput(value: unknown): z.infer<typeof ReviewerOutputSchema> | undefined {
  const parsed = ReviewerOutputSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

type Metric = number | null
interface Accumulator {
  calls: number; cost: Metric; prompt: Metric; completion: Metric; latency: Metric; retries: Metric
  sawUsage: boolean
}
const accumulator = (): Accumulator => ({ calls: 0, cost: 0, prompt: 0, completion: 0, latency: 0, retries: 0,
  sawUsage: false })

function summary(value: Accumulator): ReporterModelUsageSummary {
  const metrics = [value.cost, value.prompt, value.completion, value.retries]
  const completeness = value.calls === 0 ? 'unknown' : value.sawUsage && metrics.every(item => item !== null) ? 'reported' : 'partial'
  return { calls: value.calls, cost_usd: value.calls === 0 ? null : value.cost,
    prompt_tokens: value.calls === 0 ? null : value.prompt,
    completion_tokens: value.calls === 0 ? null : value.completion,
    latency_ms: value.calls === 0 ? null : value.latency,
    retries: value.calls === 0 ? null : value.retries, completeness }
}

function applyUsage(acc: Accumulator, role: ReporterUsage['role'], parsed: z.infer<typeof ModelUsageSchema> | undefined,
  measuredLatency: number, reporter: Pick<LocalReporter, 'recordUsage'>, scenarioId: string): void {
  acc.calls++
  const row: ReporterUsage = { role, ...(parsed?.model ? { model: parsed.model } : {}),
    ...(parsed?.prompt_tokens !== undefined ? { prompt_tokens: parsed.prompt_tokens } : {}),
    ...(parsed?.completion_tokens !== undefined ? { completion_tokens: parsed.completion_tokens } : {}),
    ...(parsed?.cost_usd !== undefined ? { cost_usd: parsed.cost_usd } : {}),
    latency_ms: parsed?.latency_ms ?? measuredLatency, ...(parsed?.retries !== undefined ? { retries: parsed.retries } : {}) }
  const metrics: { field: 'cost' | 'prompt' | 'completion' | 'latency' | 'retries'; value: number | undefined }[] = [
    { field: 'cost', value: parsed?.cost_usd }, { field: 'prompt', value: parsed?.prompt_tokens },
    { field: 'completion', value: parsed?.completion_tokens }, { field: 'latency', value: parsed?.latency_ms ?? measuredLatency },
    { field: 'retries', value: parsed?.retries },
  ]
  metrics.forEach(({ field, value }) => {
    const item = value
    if (item === undefined) acc[field] = null
    else if (typeof acc[field] === 'number') acc[field] = (acc[field] as number) + item
  })
  if (!parsed) acc.sawUsage = false
  else acc.sawUsage = true
  reporter.recordUsage(scenarioId, row)
}

function requiredBudgetUnknown(acc: Accumulator, budget: ReporterModelBudget): boolean {
  return (budget.max_cost_usd !== undefined && acc.cost === null) || (budget.max_total_tokens !== undefined && (acc.prompt === null || acc.completion === null))
}
function budgetExceeded(acc: Accumulator, budget: ReporterModelBudget): boolean {
  return (budget.max_cost_usd !== undefined && (acc.cost ?? Infinity) > budget.max_cost_usd)
    || (budget.max_total_tokens !== undefined && ((acc.prompt ?? Infinity) + (acc.completion ?? Infinity) > budget.max_total_tokens))
}
function budgetDepleted(acc: Accumulator, budget: ReporterModelBudget): boolean {
  return (budget.max_cost_usd !== undefined && budget.max_cost_usd - (acc.cost ?? 0) <= 0)
    || (budget.max_total_tokens !== undefined && budget.max_total_tokens - (acc.prompt ?? 0) - (acc.completion ?? 0) <= 0)
}
function remainingBudget(acc: Accumulator, budget: ReporterModelBudget) {
  return { ...(budget.max_cost_usd === undefined ? {} : { cost_usd: Math.max(0, budget.max_cost_usd - (acc.cost ?? 0)) }),
    ...(budget.max_total_tokens === undefined ? {} : { total_tokens: Math.max(0, budget.max_total_tokens - (acc.prompt ?? 0) - (acc.completion ?? 0)) }) }
}

const MAX_CALLS = 200
const MAX_TOTAL_TOKENS = 10_000_000
const MAX_COST_USD = 1_000_000
const MAX_TIMEOUT_MS = 86_400_000
function checkedBudget(input: ReporterModelBudget | undefined): ReporterModelBudget {
  const budget = input ?? {}
  const allowed = new Set(['max_calls', 'max_cost_usd', 'max_total_tokens', 'timeout_ms'])
  if (typeof budget !== 'object' || Array.isArray(budget) || Object.keys(budget).some(key => !allowed.has(key))) {
    throw new TypeError('Reporter 模型预算必须是仅包含已知字段的对象')
  }
  if (budget.max_calls !== undefined && (!Number.isSafeInteger(budget.max_calls) || budget.max_calls < 0 || budget.max_calls > MAX_CALLS)) {
    throw new RangeError(`max_calls 必须是 0 到 ${MAX_CALLS} 之间的整数`)
  }
  if (budget.max_cost_usd !== undefined && (!Number.isFinite(budget.max_cost_usd) || budget.max_cost_usd < 0 || budget.max_cost_usd > MAX_COST_USD)) {
    throw new RangeError(`max_cost_usd 必须是 0 到 ${MAX_COST_USD} 之间的有限数值`)
  }
  if (budget.max_total_tokens !== undefined && (!Number.isSafeInteger(budget.max_total_tokens) || budget.max_total_tokens < 0 || budget.max_total_tokens > MAX_TOTAL_TOKENS)) {
    throw new RangeError(`max_total_tokens 必须是 0 到 ${MAX_TOTAL_TOKENS} 之间的整数`)
  }
  if (budget.timeout_ms !== undefined && (!Number.isSafeInteger(budget.timeout_ms) || budget.timeout_ms < 1 || budget.timeout_ms > MAX_TIMEOUT_MS)) {
    throw new RangeError(`timeout_ms 必须是 1 到 ${MAX_TIMEOUT_MS} 之间的整数`)
  }
  return budget
}
function checkedMaxTurns(input: number | undefined): number {
  const maxTurns = input ?? 12
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > MAX_CALLS) {
    throw new RangeError(`maxTurns 必须是 1 到 ${MAX_CALLS} 之间的整数`)
  }
  return maxTurns
}

function runSignal(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  return AbortSignal.any([...(external ? [external] : []), AbortSignal.timeout(timeoutMs)])
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
function stopReason(signal: AbortSignal): 'timeout' | 'aborted' {
  return signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'timeout' : 'aborted'
}
function usageFrom(response: ReporterModelResponse): z.infer<typeof ModelUsageSchema> | undefined {
  if (response.usage === undefined) return undefined
  const parsed = ModelUsageSchema.safeParse(response.usage)
  return parsed.success ? parsed.data : undefined
}

const simulatorOutputFields = new Set(['kind', 'actor_id', 'action', 'text', 'addressed', 'location', 'state', 'body', 'name', 'summary', 'after_ms'])
function simulatorValidationIssues(error: z.ZodError): ReporterSimulatorValidationIssue[] {
  return error.issues.slice(0, 8).map(issue => ({
    path: issue.path.length ? issue.path.map(part => typeof part === 'number' ? `[${part}]`
      : typeof part === 'string' && simulatorOutputFields.has(part) ? part : '[字段]').join('.').slice(0, 160) : '$',
    code: issue.code.slice(0, 40),
  }))
}

async function invokeAndRecord(options: { invoke: ReporterModelInvoker; request: ReporterModelRequest; reporter: Pick<LocalReporter, 'recordUsage'>;
  scenarioId: string; usage: Accumulator }): Promise<ReporterModelResponse> {
  const { signal } = options.request
  signal.throwIfAborted()
  const started = Date.now()
  let response: ReporterModelResponse
  try {
    response = await abortable(options.invoke(options.request), signal)
  } catch (error) {
    // 已进入注入的模型调用边界；异常或超时时费用和 Token 数未知，不能记作零。
    applyUsage(options.usage, options.request.role, undefined, Date.now() - started, options.reporter, options.scenarioId)
    throw error
  }
  applyUsage(options.usage, options.request.role, usageFrom(response), Date.now() - started, options.reporter, options.scenarioId)
  return response
}

/**
 * 逐轮生成真实用户动作。被测 Agent 先处理完每个动作，Simulator 才收到仅包含 Actor 发言和公开输出的下一轮反馈。
 * `invoke` 必须由调用者显式注入；预算要求的计量缺失时，会在提交新动作前停止。
 */
export async function runUserSimulator(options: {
  reporter: Pick<LocalReporter, 'simulatorFeedback' | 'submit' | 'recordUsage' | 'completeScenario' | 'scenario'>
  scenarioId: string
  invoke: ReporterModelInvoker
  waitForSuperagent(signal: AbortSignal): Promise<void>
  maxTurns?: number
  minTurns?: number
  validateAction?(action: ReporterAction, turn: number): boolean
  onProgress?(progress: { phase: 'action_submitted' | 'target_waiting' | 'target_completed'; turns: number; sequence: number }): void
  budget?: ReporterModelBudget
  signal?: AbortSignal
  now?: () => string
}): Promise<ReporterSimulatorRunResult> {
  const maxTurns = checkedMaxTurns(options.maxTurns)
  const minTurns = options.minTurns ?? 0
  if (!Number.isSafeInteger(minTurns) || minTurns < 0 || minTurns > maxTurns) throw new RangeError(`minTurns 必须是 0 到 ${maxTurns} 之间的整数`)
  const budget = checkedBudget(options.budget)
  const signal = runSignal(options.signal, budget.timeout_ms ?? 120_000)
  const usage = accumulator(), acknowledgements: ReturnType<LocalReporter['submit']>[] = []
  const now = options.now ?? (() => new Date().toISOString())
  let turns = 0, offset = 0
  const finish = (status: ReporterSimulatorRunResult['status'], stop_reason: ReporterSimulatorRunResult['stop_reason'], report?: ReporterScenarioResult,
    error_code?: string): ReporterSimulatorRunResult => ({ scenario_id: options.scenarioId, status, stop_reason, turns, acknowledgements,
      usage: summary(usage), ...(report ? { report } : {}), ...(error_code ? { error_code } : {}) })
  try {
    let feedback = options.reporter.simulatorFeedback(options.scenarioId)
    if (!feedback) return finish('incomplete', 'input_rejected', undefined, 'scenario_not_found')
    while (turns < maxTurns) {
      if (requiredBudgetUnknown(usage, budget)) return finish('incomplete', 'usage_unknown', options.reporter.scenario(options.scenarioId))
      if (budgetDepleted(usage, budget)) return finish('incomplete', 'budget_exhausted', options.reporter.scenario(options.scenarioId))
      if (budget.max_calls !== undefined && usage.calls >= budget.max_calls) {
        return finish('incomplete', 'max_calls', options.reporter.scenario(options.scenarioId))
      }
      const response = await invokeAndRecord({ invoke: options.invoke, reporter: options.reporter, scenarioId: options.scenarioId, usage,
        request: { role: 'user-simulator', instructions: SIMULATOR_INSTRUCTIONS + (turns < minTurns
          ? ` 当前已完成 ${turns} 次用户动作；在达到至少 ${minTurns} 次真实用户动作并观察目标回复前，不得结束。` : ''),
          input: feedback, signal, remaining_budget: remainingBudget(usage, budget) } })
      if (requiredBudgetUnknown(usage, budget)) return finish('incomplete', 'usage_unknown', options.reporter.scenario(options.scenarioId))
      if (budgetExceeded(usage, budget)) { return finish('incomplete', 'budget_exhausted', options.reporter.scenario(options.scenarioId)) }

      const parsed = SimulatorTurnSchema.safeParse(response.output)
      if (!parsed.success) return { ...finish('invalid_output', 'invalid_output', options.reporter.scenario(options.scenarioId), 'invalid_simulator_output'),
        validation_issues: simulatorValidationIssues(parsed.error) }
      if (parsed.data.kind === 'finished') {
        if (turns < minTurns) return finish('invalid_output', 'invalid_output', options.reporter.scenario(options.scenarioId), 'simulator_finished_too_early')
        await abortable(options.waitForSuperagent(signal), signal)
        return finish('completed', 'simulator_finished', options.reporter.completeScenario(options.scenarioId))
      }
      if (options.validateAction && !options.validateAction(parsed.data.action, turns)) {
        return finish('input_rejected', 'input_rejected', options.reporter.scenario(options.scenarioId), 'simulator_action_out_of_scope')
      }
      offset += parsed.data.after_ms
      const envelope = { scenario_id: feedback.scenario.id, scenario_version: feedback.scenario.version, sequence: feedback.last_sequence + 1,
        idempotency_key: `${options.scenarioId}:user-simulator:${feedback.last_sequence + 1}`,
        simulated_at: new Date(Date.parse(now()) + offset).toISOString(), actor_id: parsed.data.actor_id,
        project_source_id: feedback.scenario.project_source_id, thread_id: feedback.scenario.thread_id, action: parsed.data.action }
      try { acknowledgements.push(options.reporter.submit(envelope)) }
      catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'receive_failed'
        return finish('input_rejected', 'input_rejected', options.reporter.scenario(options.scenarioId), code)
      }
      turns++
      options.onProgress?.({ phase: 'action_submitted', turns, sequence: envelope.sequence })
      options.onProgress?.({ phase: 'target_waiting', turns, sequence: envelope.sequence })
      await abortable(options.waitForSuperagent(signal), signal)
      options.onProgress?.({ phase: 'target_completed', turns, sequence: envelope.sequence })
      const nextFeedback = options.reporter.simulatorFeedback(options.scenarioId)
      if (!nextFeedback) return finish('incomplete', 'input_rejected', options.reporter.scenario(options.scenarioId), 'scenario_not_found')
      feedback = nextFeedback
    }
    return finish('incomplete', 'max_calls', options.reporter.scenario(options.scenarioId))
  } catch (error) {
    if (signal.aborted) return finish('incomplete', stopReason(signal), options.reporter.scenario(options.scenarioId))
    if (error instanceof z.ZodError) return { ...finish('invalid_output', 'invalid_output', options.reporter.scenario(options.scenarioId), 'invalid_model_response'),
      validation_issues: simulatorValidationIssues(error) }
    const errorCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code
      : error instanceof Error && error.message === 'model_call_failed' ? 'model_call_failed' : 'target_wait_failed'
    return finish('incomplete', 'input_rejected', options.reporter.scenario(options.scenarioId), errorCode)
  }
}

/** Reviewer 只收到安全 reviewEvidence，并只返回定性文字；严格 schema 不接受任何 Oracle/pass 覆盖字段。 */
export async function runQualitativeReviewer(options: {
  reporter: Pick<LocalReporter, 'reviewEvidence' | 'recordReview' | 'recordUsage' | 'scenario'>
  scenarioId: string
  invoke: ReporterModelInvoker
  budget?: ReporterModelBudget
  signal?: AbortSignal
}): Promise<ReporterReviewerRunResult> {
  const budget = checkedBudget(options.budget)
  const signal = runSignal(options.signal, budget.timeout_ms ?? 120_000)
  const usage = accumulator()
  const finish = (status: ReporterReviewerRunResult['status'], stop_reason: ReporterReviewerRunResult['stop_reason'], report?: ReporterScenarioResult): ReporterReviewerRunResult =>
    ({ scenario_id: options.scenarioId, status, stop_reason, usage: summary(usage), ...(report ? { report } : {}) })
  const evidence = options.reporter.reviewEvidence(options.scenarioId)
  if (!evidence) return finish('incomplete', 'invalid_output')
  if (budget.max_calls === 0) return finish('incomplete', 'budget_exhausted', options.reporter.scenario(options.scenarioId))
  if (budgetDepleted(usage, budget)) return finish('incomplete', 'budget_exhausted', options.reporter.scenario(options.scenarioId))
  try {
    const response = await invokeAndRecord({ invoke: options.invoke, reporter: options.reporter, scenarioId: options.scenarioId, usage,
      request: { role: 'qualitative-reviewer', instructions: REVIEWER_INSTRUCTIONS, input: evidence, signal, remaining_budget: remainingBudget(usage, budget) } })
    if (requiredBudgetUnknown(usage, budget)) return finish('incomplete', 'usage_unknown', options.reporter.scenario(options.scenarioId))
    if (budgetExceeded(usage, budget)) return finish('incomplete', 'budget_exhausted', options.reporter.scenario(options.scenarioId))
    const parsed = ReviewerOutputSchema.safeParse(response.output)
    if (!parsed.success) return finish('invalid_output', 'invalid_output', options.reporter.scenario(options.scenarioId))
    return finish('recorded', 'review_recorded', options.reporter.recordReview(options.scenarioId, parsed.data))
  } catch (error) {
    if (signal.aborted) return finish('incomplete', stopReason(signal), options.reporter.scenario(options.scenarioId))
    return finish('invalid_output', 'invalid_output', options.reporter.scenario(options.scenarioId))
  }
}

export type { ReporterAction, ReporterOutputKind }
