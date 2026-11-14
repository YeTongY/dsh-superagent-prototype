/** 受保护的本地 Reporter 核心：将场景动作送入 Engine，并维护只追加的测试证据。 */
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, truncateSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { DomainEvent, OutboundMessage, ReceiveResult } from '../core/index.ts'
import type { DecisionKind, ReportState, TicketOutcome, Trigger } from '../core/index.ts'
import type { ReporterRuntimeSnapshot, ReporterAck, ReporterAction, ReporterEnvelope, ReporterOutput, ReporterOutputKind,
  ReporterProjectIdentity, ReporterScenarioDefinition, ReporterSimulatorScenario } from './protocol.ts'
import { ReporterEnvelopeSchema, ReporterScenarioSchema, reporterEnvelopeDigest, reporterTrigger, reporterTriggerId, stableJson } from './protocol.ts'

export const REPORTER_ERROR_CODES = ['disabled', 'invalid_request', 'scenario_not_found', 'scenario_conflict', 'version_mismatch', 'project_mismatch',
  'thread_mismatch', 'actor_not_allowed', 'idempotency_conflict', 'sequence_conflict', 'sequence_out_of_order', 'receive_failed', 'trace_corrupt',
  'output_not_local', 'review_invalid', 'limit_exceeded'] as const
export type ReporterErrorCode = typeof REPORTER_ERROR_CODES[number]

const ERROR_STATUS: Record<ReporterErrorCode, number> = { disabled: 404, invalid_request: 400, scenario_not_found: 404, scenario_conflict: 409,
  version_mismatch: 409, project_mismatch: 400, thread_mismatch: 400, actor_not_allowed: 400, idempotency_conflict: 409,
  sequence_conflict: 409, sequence_out_of_order: 409, receive_failed: 500, trace_corrupt: 500, output_not_local: 400, review_invalid: 400, limit_exceeded: 413 }

/** Reporter 接口的结构化错误，供本地 API 映射稳定错误码和 HTTP 状态。 */
export class ReporterError extends Error {
  readonly status: number
  constructor(readonly code: ReporterErrorCode, message: string) { super(message); this.name = 'ReporterError'; this.status = ERROR_STATUS[code] }
}

export interface ReporterCheckpoint {
  id: string
  scenario_id: string
  scenario_version: number
  sequence: number
  cause: 'input' | 'domain-event'
  trigger_ids: string[]
  runtime: ReporterRuntimeSnapshot | null
  snapshot_available: boolean
  output_ids: string[]
  created_at: string
}

export interface ReporterUsage {
  role: 'autonomous-explorer' | 'user-simulator' | 'browser-tester' | 'superagent' | 'qualitative-reviewer'
  model?: string
  prompt_tokens?: number
  completion_tokens?: number
  cost_usd?: number
  latency_ms?: number
  retries?: number
}

export interface ReporterReview {
  summary: string
  findings: { severity: 'info' | 'warning' | 'error'; text: string; evidence?: string[] }[]
  model?: string
  cost_usd?: number
  latency_ms?: number
  retries?: number
}

export interface ReporterOracleCheck { assertion: ReporterScenarioDefinition['oracle']['assertions'][number]; passed: boolean; actual: unknown }
export interface ReporterOracleResult {
  passed: boolean
  behavioral_pass: boolean | null
  delivery_pass: boolean | null
  snapshot_available: boolean
  checks: ReporterOracleCheck[]
}
export interface ReporterTrace { format: 'dsh-superagent-reporter/v1'; scenario_id: string; records: ReporterJournalRecord[]; sha256: string }
export interface ReporterReplay { scenario_id: string; last_sequence: number; trigger_ids: string[]; outputs: ReporterOutput[]; domain_events: DomainEvent[]; checkpoints: ReporterCheckpoint[]; completed: boolean; replayed_without_model_calls: true }
export interface ReporterReviewEvidence {
  simulator: ReporterSimulatorScenario
  inputs: { sequence: number; actor_id: string; action: ReporterAction; text: string; simulated_at: string }[]
  outputs: ReporterOutput[]
  domain_events: DomainEvent[]
  runtime: ReporterRuntimeSnapshot | null
  snapshot_available: boolean
}
export interface ReporterSimulatorFeedback {
  scenario: ReporterSimulatorScenario
  last_sequence: number
  conversation: { role: 'actor' | 'superagent'; actor_id?: string; kind?: ReporterOutputKind; simulated_at: string; text: string }[]
}
export interface ReporterScenarioResult {
  scenario_id: string
  scenario_version: number
  status: 'registered' | 'running' | 'completed'
  behavioral_pass: boolean | null
  /** 本地 Reporter 不验证真实 GitHub/GitLab 网络或 API，因此以 null 表示未运行。 */
  platform_pass: null
  delivery_pass: boolean | null
  coverage: { behavior: 'local-engine'; platform: 'not-run'; delivery: 'local-sink' }
  simulator: ReporterSimulatorScenario
  inputs: { envelope: ReporterEnvelope; trigger: Trigger; ack: ReporterAck; recorded_at: string }[]
  outputs: ReporterOutput[]
  domain_events: DomainEvent[]
  checkpoints: ReporterCheckpoint[]
  runtime: ReporterRuntimeSnapshot | null
  snapshot_available: boolean
  oracle: ReporterOracleResult
  review?: ReporterReview
  usage: ReporterUsage[]
}

export type ReporterJournalRecord =
  | { type: 'scenario.registered'; definition: ReporterScenarioDefinition; at: string }
  | { type: 'input.pending'; envelope: ReporterEnvelope; digest: string; trigger: Trigger; at: string }
  | { type: 'input.accepted'; envelope: ReporterEnvelope; digest: string; trigger: Trigger; ack: ReporterAck; at: string }
  | { type: 'input.failed'; envelope: ReporterEnvelope; digest: string; code: string; at: string }
  | { type: 'output.captured'; output: ReporterOutput }
  | { type: 'domain.observed'; event: DomainEvent }
  | { type: 'checkpoint.created'; checkpoint: ReporterCheckpoint }
  | { type: 'scenario.completed'; at: string }
  | { type: 'review.recorded'; review: ReporterReview }
  | { type: 'usage.recorded'; usage: ReporterUsage; at: string }

export interface LocalReporterOptions {
  stateDir: string
  enabled: boolean
  resolveProject(id: string): ReporterProjectIdentity | undefined
  receive(trigger: Trigger): ReceiveResult
  lookup?(triggerId: string): ReceiveResult | undefined
  snapshot(scenarioId: string, triggerIds: string[]): ReporterRuntimeSnapshot
  now?: () => string
}

interface InputRecord { envelope: ReporterEnvelope; digest: string; trigger: Trigger; ack: ReporterAck; at: string }
interface PendingInput { envelope: ReporterEnvelope; digest: string; trigger: Trigger; at: string }
interface ReporterState {
  definition?: ReporterScenarioDefinition
  records: ReporterJournalRecord[]
  inputs: InputRecord[]
  pending: PendingInput[]
  outputs: ReporterOutput[]
  domainEvents: DomainEvent[]
  checkpoints: ReporterCheckpoint[]
  review?: ReporterReview
  usage: ReporterUsage[]
  completed: boolean
}

const emptySnapshot = (): ReporterRuntimeSnapshot => ({ triggers: [], decisions: [], tickets: [] })
export const REPORTER_LIMITS = { scenarios: 100, eventsPerScenario: 10_000, outputsPerScenario: 2_000, domainEventsPerScenario: 8_000,
  checkpointsPerScenario: 2_000, scenarioBytes: 64 * 1024, traceBytes: 16 * 1024 * 1024, totalBytes: 128 * 1024 * 1024,
  inputTextChars: 20_000, outputTextChars: 20_000 } as const
const safeId = (id: string): string => createHash('sha256').update(id).digest('hex')
const clone = <T>(value: T): T => structuredClone(value)
const nowIso = (): string => new Date().toISOString()
const validString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const jsonObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

const UsageSchema = z.object({ role: z.enum(['autonomous-explorer', 'user-simulator', 'browser-tester', 'superagent', 'qualitative-reviewer']), model: z.string().max(200).optional(),
  prompt_tokens: z.number().int().nonnegative().optional(), completion_tokens: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(), latency_ms: z.number().nonnegative().optional(), retries: z.number().int().nonnegative().optional() }).strict()
const ReviewSchema = z.object({ summary: z.string().min(1).max(8_000), findings: z.array(z.object({ severity: z.enum(['info', 'warning', 'error']),
  text: z.string().min(1).max(4_000), evidence: z.array(z.string().max(300)).max(20).optional() }).strict()).max(100), model: z.string().max(200).optional(),
  cost_usd: z.number().nonnegative().optional(), latency_ms: z.number().nonnegative().optional(), retries: z.number().int().nonnegative().optional() }).strict()

/** 本地 Reporter 的最小公开接口；HTTP 层负责 capability token 校验。 */
export interface LocalReporter {
  registerScenario(input: unknown): ReporterSimulatorScenario
  simulatorScenario(id: string): ReporterSimulatorScenario | undefined
  simulatorFeedback(id: string): ReporterSimulatorFeedback | undefined
  submit(input: unknown): ReporterAck
  capture(message: OutboundMessage): boolean
  observe(event: DomainEvent): void
  completeScenario(id: string): ReporterScenarioResult
  recordUsage(id: string, usage: unknown): void
  recordReview(id: string, review: unknown): ReporterScenarioResult
  scenario(id: string): ReporterScenarioResult | undefined
  reviewEvidence(id: string): ReporterReviewEvidence | undefined
  exportScenario(id: string): ReporterTrace | undefined
  replayScenario(id: string): ReporterReplay | undefined
}

/** Creates a local, durable Reporter; its event path never writes directly to the business Store. */
export function createLocalReporter(options: LocalReporterOptions): LocalReporter {
  return new Reporter(options)
}

/** 将 Reporter 场景和轨迹持久化到本地 JSONL，并复用 Runtime 作为唯一业务事件入口。 */
class Reporter implements LocalReporter {
  private readonly directory: string
  private readonly states = new Map<string, ReporterState>()
  private readonly now: () => string
  private totalBytes = 0

  constructor(private readonly options: LocalReporterOptions) {
    this.directory = join(resolve(options.stateDir), 'reporter')
    this.now = options.now ?? nowIso
    if (options.enabled) {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      chmodSync(this.directory, 0o700)
      this.loadExisting()
    }
  }

  registerScenario(input: unknown): ReporterSimulatorScenario {
    this.requireEnabled()
    const definition = this.parseDefinition(input)
    const identity = this.options.resolveProject(definition.project_source_id)
    if (!identity || identity.id !== definition.project_source_id) throw new ReporterError('project_mismatch', '场景绑定的项目不存在或未启用')
    if (Buffer.byteLength(stableJson(definition)) > REPORTER_LIMITS.scenarioBytes) throw new ReporterError('limit_exceeded', '场景定义超过 64 KiB 限制')
    const existing = this.state(definition.id)
    if (existing) {
      if (!existing.definition || stableJson(existing.definition) !== stableJson(definition)) throw new ReporterError('scenario_conflict', '场景 ID 已注册为不同定义')
      return simulatorView(existing.definition)
    }
    if (this.states.size >= REPORTER_LIMITS.scenarios) throw new ReporterError('limit_exceeded', 'Reporter 最多保存 100 个场景')
    const record: ReporterJournalRecord = { type: 'scenario.registered', definition, at: this.now() }
    this.append(definition.id, record)
    this.apply(definition.id, record)
    return simulatorView(definition)
  }

  simulatorScenario(id: string): ReporterSimulatorScenario | undefined {
    const state = this.state(id)
    return state?.definition ? simulatorView(state.definition) : undefined
  }

  simulatorFeedback(id: string): ReporterSimulatorFeedback | undefined {
    const state = this.state(id)
    if (!state?.definition) return undefined
    const conversation = [
      ...state.inputs.map(item => ({ role: 'actor' as const, actor_id: item.envelope.actor_id, simulated_at: item.envelope.simulated_at, text: item.trigger.text })),
      ...state.outputs.map(item => ({ role: 'superagent' as const, kind: item.kind, simulated_at: item.at, text: item.text })),
    ].sort((left, right) => left.simulated_at.localeCompare(right.simulated_at))
      .slice(-100).map(item => ({ ...item, text: item.text.slice(-4_000) }))
    return { scenario: simulatorView(state.definition), last_sequence: state.inputs.at(-1)?.envelope.sequence ?? 0, conversation }
  }

  reviewEvidence(id: string): ReporterReviewEvidence | undefined {
    const state = this.state(id)
    if (!state?.definition) return undefined
    let runtime: ReporterRuntimeSnapshot | null = null
    try { runtime = clone(this.options.snapshot(id, state.inputs.map(item => item.trigger.id))) } catch { /* 证据不全时明示，不以空状态误导 Reviewer。 */ }
    return { simulator: simulatorView(state.definition), inputs: state.inputs.map(item => ({ sequence: item.envelope.sequence,
      actor_id: item.envelope.actor_id, action: clone(item.envelope.action), text: item.trigger.text, simulated_at: item.envelope.simulated_at })),
      outputs: clone(state.outputs), domain_events: clone(state.domainEvents), runtime, snapshot_available: runtime !== null }
  }

  submit(input: unknown): ReporterAck {
    this.requireEnabled()
    const envelope = this.parseEnvelope(input)
    const state = this.requireScenario(envelope.scenario_id)
    const definition = state.definition!
    if (envelope.scenario_version !== definition.version) throw new ReporterError('version_mismatch', '场景版本与已注册版本不一致')
    if (envelope.project_source_id !== definition.project_source_id) throw new ReporterError('project_mismatch', '动作项目必须与场景项目一致')
    if (envelope.thread_id !== definition.thread_id) throw new ReporterError('thread_mismatch', '动作 Thread 必须与场景目标一致')
    if (!definition.actors.some(actor => actor.id === envelope.actor_id)) throw new ReporterError('actor_not_allowed', '动作 Actor 未在场景中登记')
    const project = this.options.resolveProject(envelope.project_source_id)
    if (!project || project.id !== envelope.project_source_id) throw new ReporterError('project_mismatch', '目标项目当前不可用')
    const digest = reporterEnvelopeDigest(envelope)
    const prior = state.inputs.find(item => item.envelope.idempotency_key === envelope.idempotency_key)
    if (prior) {
      if (prior.digest !== digest) throw new ReporterError('idempotency_conflict', '幂等键已绑定到不同 Reporter 动作')
      return { ...clone(prior.ack), duplicate: true }
    }
    const pendingByKey = state.pending.find(item => item.envelope.idempotency_key === envelope.idempotency_key)
    if (pendingByKey && pendingByKey.digest !== digest) throw new ReporterError('idempotency_conflict', '幂等键已预留给不同 Reporter 动作')
    const expected = (state.inputs.at(-1)?.envelope.sequence ?? 0) + 1
    if (envelope.sequence < expected) throw new ReporterError('sequence_conflict', '场景序号已被另一个动作占用')
    if (envelope.sequence > expected) throw new ReporterError('sequence_out_of_order', `场景要求下一个序号为 ${expected}`)
    if (state.completed) throw new ReporterError('sequence_conflict', '已完成的场景不能继续接收动作')
    const pendingBySequence = state.pending.find(item => item.envelope.sequence === envelope.sequence)
    if (pendingBySequence && pendingBySequence.envelope.idempotency_key !== envelope.idempotency_key) throw new ReporterError('sequence_conflict', '场景序号已被未完成动作预留')
    if (state.inputs.length >= REPORTER_LIMITS.eventsPerScenario) throw new ReporterError('limit_exceeded', '场景事件数已达到 10,000 条上限')

    const trigger = pendingByKey?.trigger ?? reporterTrigger(definition, envelope, project)
    if (!pendingByKey) {
      const pending: ReporterJournalRecord = { type: 'input.pending', envelope, digest, trigger, at: this.now() }
      this.append(definition.id, pending)
      this.apply(definition.id, pending)
    }
    let disposition: ReceiveResult
    try { disposition = this.options.lookup?.(trigger.id) ?? this.options.receive(trigger) }
    catch {
      const failed: ReporterJournalRecord = { type: 'input.failed', envelope, digest, code: 'receive_failed', at: this.now() }
      this.append(definition.id, failed)
      this.apply(definition.id, failed)
      throw new ReporterError('receive_failed', 'Runtime 未能接收 Reporter Trigger')
    }
    const ack: ReporterAck = { scenario_id: envelope.scenario_id, scenario_version: envelope.scenario_version,
      sequence: envelope.sequence, trigger_id: trigger.id, disposition, duplicate: false }
    const accepted: ReporterJournalRecord = { type: 'input.accepted', envelope, digest, trigger, ack, at: this.now() }
    this.append(definition.id, accepted)
    this.apply(definition.id, accepted)
    this.checkpoint(definition.id, 'input')
    return ack
  }

  /** 只捕获地址完整且已经登记的 local-reporter 消息；未知地址交给调用方按失败处理。 */
  capture(message: OutboundMessage): boolean {
    if (message.channel.source !== 'local-reporter') return false
    const address = message.channel.address
    const scenarioId = address.scenario_id, version = Number(address.scenario_version), sequence = Number(address.sequence)
    const triggerId = address.trigger_id, projectSourceId = address.project_source_id, threadId = address.thread_id
    if (!validString(scenarioId) || !Number.isInteger(version) || !Number.isInteger(sequence) || !validString(triggerId)
      || !validString(projectSourceId) || !validString(threadId)) return false
    const state = this.state(scenarioId)
    const input = state?.inputs.find(item => item.trigger.id === triggerId && item.envelope.sequence === sequence)
    if (!state?.definition || !input || input.envelope.project_source_id !== projectSourceId || input.envelope.thread_id !== threadId
      || input.envelope.scenario_version !== version) return false
    const prior = state.outputs.find(item => item.id === message.id)
    const output: ReporterOutput = { id: message.id, scenario_id: scenarioId, scenario_version: version, sequence, trigger_id: triggerId,
      project_source_id: projectSourceId, thread_id: threadId, ...(message.ticketId ? { ticket_id: message.ticketId } : {}),
      kind: message.kind as ReporterOutputKind, text: message.text, at: this.now() }
    if (prior) return stableJson({ ...prior, at: '' }) === stableJson({ ...output, at: '' })
    if (message.text.length > REPORTER_LIMITS.outputTextChars || state.outputs.length >= REPORTER_LIMITS.outputsPerScenario) {
      throw new ReporterError('limit_exceeded', 'Reporter 本地输出超过场景容量限制')
    }
    this.append(scenarioId, { type: 'output.captured', output })
    this.apply(scenarioId, { type: 'output.captured', output })
    return true
  }

  /** Runtime 在事务提交后调用；仅记录可关联到已登记场景的结构化领域事件。 */
  observe(event: DomainEvent): void {
    if (!this.options.enabled) return
    for (const [id, state] of this.states) {
      if (!state.definition || !this.related(state, event)) continue
      if (state.domainEvents.length >= REPORTER_LIMITS.domainEventsPerScenario) continue
      const duplicate = state.domainEvents.some(item => item.type === event.type && item.at === event.at && stableJson(item.data) === stableJson(event.data))
      if (duplicate) continue
      const record: ReporterJournalRecord = { type: 'domain.observed', event: clone(event) }
      this.append(id, record)
      this.apply(id, record)
      this.checkpoint(id, 'domain-event')
    }
  }

  completeScenario(id: string): ReporterScenarioResult {
    this.requireEnabled()
    const state = this.requireScenario(id)
    if (!state.completed) {
      const record: ReporterJournalRecord = { type: 'scenario.completed', at: this.now() }
      this.append(id, record)
      this.apply(id, record)
      this.checkpoint(id, 'domain-event')
    }
    return this.result(id, state)
  }

  recordUsage(id: string, input: unknown): void {
    this.requireEnabled()
    this.requireScenario(id)
    const parsed = UsageSchema.safeParse(input)
    if (!parsed.success) throw new ReporterError('invalid_request', '模型成本与时延记录格式无效')
    const record: ReporterJournalRecord = { type: 'usage.recorded', usage: parsed.data, at: this.now() }
    this.append(id, record)
    this.apply(id, record)
  }

  recordReview(id: string, input: unknown): ReporterScenarioResult {
    this.requireEnabled()
    const state = this.requireScenario(id)
    const parsed = ReviewSchema.safeParse(input)
    if (!parsed.success) throw new ReporterError('review_invalid', '定性 Reviewer 结果格式无效')
    const review = clone(parsed.data)
    const record: ReporterJournalRecord = { type: 'review.recorded', review }
    this.append(id, record)
    this.apply(id, record)
    if (review.model || review.cost_usd !== undefined || review.latency_ms !== undefined || review.retries !== undefined) {
      const usage: ReporterUsage = { role: 'qualitative-reviewer', ...(review.model ? { model: review.model } : {}),
        ...(review.cost_usd !== undefined ? { cost_usd: review.cost_usd } : {}), ...(review.latency_ms !== undefined ? { latency_ms: review.latency_ms } : {}),
        ...(review.retries !== undefined ? { retries: review.retries } : {}) }
      const usageRecord: ReporterJournalRecord = { type: 'usage.recorded', usage, at: this.now() }
      this.append(id, usageRecord)
      this.apply(id, usageRecord)
    }
    return this.result(id, state)
  }

  scenario(id: string): ReporterScenarioResult | undefined {
    const state = this.state(id)
    return state?.definition ? this.result(id, state) : undefined
  }

  exportScenario(id: string): ReporterTrace | undefined {
    const state = this.state(id)
    if (!state?.definition) return undefined
    const records = clone(state.records)
    if (Buffer.byteLength(stableJson(records)) > REPORTER_LIMITS.traceBytes) throw new ReporterError('limit_exceeded', '场景轨迹超过 16 MiB 导出限制')
    return { format: 'dsh-superagent-reporter/v1', scenario_id: id, records, sha256: createHash('sha256').update(stableJson(records)).digest('hex') }
  }

  replayScenario(id: string): ReporterReplay | undefined {
    const state = this.state(id)
    if (!state?.definition) return undefined
    // 纯 reducer 重建轨迹状态；不调用 Runtime、Simulator、Evaluator 或 Reviewer。
    const rebuilt = newState()
    for (const record of state.records) applyRecord(rebuilt, record)
    return { scenario_id: id, last_sequence: rebuilt.inputs.at(-1)?.envelope.sequence ?? 0,
      trigger_ids: rebuilt.inputs.map(item => item.trigger.id), outputs: clone(rebuilt.outputs), domain_events: clone(rebuilt.domainEvents),
      checkpoints: clone(rebuilt.checkpoints), completed: rebuilt.completed, replayed_without_model_calls: true }
  }

  private requireEnabled(): void { if (!this.options.enabled) throw new ReporterError('disabled', '本地 Reporter 未启用') }
  private parseEnvelope(input: unknown): ReporterEnvelope {
    const parsed = ReporterEnvelopeSchema.safeParse(input)
    if (!parsed.success) throw new ReporterError('invalid_request', 'Reporter 动作格式无效或超出大小限制')
    return parsed.data
  }
  private parseDefinition(input: unknown): ReporterScenarioDefinition {
    const parsed = ReporterScenarioSchema.safeParse(input)
    if (!parsed.success) throw new ReporterError('invalid_request', 'Reporter 场景定义格式无效')
    return parsed.data
  }
  private requireScenario(id: string): ReporterState {
    const state = this.state(id)
    if (!state?.definition) throw new ReporterError('scenario_not_found', 'Reporter 场景不存在')
    return state
  }
  private file(id: string): string { return join(this.directory, `${safeId(id)}.jsonl`) }

  private state(id: string): ReporterState | undefined {
    if (this.states.has(id)) return this.states.get(id)
    if (!this.options.enabled) return undefined
    const file = this.file(id)
    if (!existsSync(file)) return undefined
    const records = this.read(file)
    const state = newState()
    for (const record of records) applyRecord(state, record)
    if (state.definition?.id !== id) throw new ReporterError('trace_corrupt', 'Reporter 轨迹与文件身份不匹配')
    this.states.set(id, state)
    return state
  }

  private loadExisting(): void {
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const records = this.read(join(this.directory, entry.name))
      this.totalBytes += statSync(join(this.directory, entry.name)).size
      if (this.totalBytes > REPORTER_LIMITS.totalBytes) throw new ReporterError('limit_exceeded', 'Reporter 轨迹总量超过 128 MiB 限制')
      const first = records[0]
      if (first?.type !== 'scenario.registered') throw new ReporterError('trace_corrupt', 'Reporter 轨迹缺少场景登记记录')
      const state = newState()
      for (const record of records) applyRecord(state, record)
      if (this.file(state.definition!.id) !== join(this.directory, entry.name)) throw new ReporterError('trace_corrupt', 'Reporter 轨迹文件名无效')
      this.states.set(state.definition!.id, state)
    }
  }

  private read(file: string): ReporterJournalRecord[] {
    const bytes = readFileSync(file)
    const lastNewline = bytes.lastIndexOf(0x0a)
    if (lastNewline !== bytes.length - 1) truncateSync(file, lastNewline + 1)
    const text = bytes.subarray(0, Math.max(lastNewline + 1, 0)).toString('utf8')
    const lines = text.split('\n')
    if (lines.at(-1) === '') lines.pop()
    try { return lines.filter(Boolean).map(line => parseRecord(JSON.parse(line))) }
    catch { throw new ReporterError('trace_corrupt', 'Reporter JSONL 轨迹包含损坏记录') }
  }

  private append(id: string, record: ReporterJournalRecord): void {
    const state = this.states.get(id)
    if (state && state.records.length >= REPORTER_LIMITS.eventsPerScenario) throw new ReporterError('limit_exceeded', '场景轨迹事件数已达到上限')
    if (this.totalBytes > REPORTER_LIMITS.totalBytes) throw new ReporterError('limit_exceeded', 'Reporter 轨迹总量超过 128 MiB 限制')
    const line = `${stableJson(record)}\n`
    const size = Buffer.byteLength(line)
    if (size > REPORTER_LIMITS.outputTextChars + 64 * 1024 || this.totalBytes + size > REPORTER_LIMITS.totalBytes) {
      throw new ReporterError('limit_exceeded', 'Reporter 单条轨迹或轨迹总量超过限制')
    }
    const file = this.file(id)
    if (existsSync(file) && statSync(file).size + size > REPORTER_LIMITS.traceBytes) throw new ReporterError('limit_exceeded', '单个场景轨迹超过 16 MiB 限制')
    const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600)
    try { fchmodSync(fd, 0o600); writeSync(fd, line); fsyncSync(fd); this.totalBytes += size } finally { closeSync(fd) }
  }

  private apply(id: string, record: ReporterJournalRecord): void {
    const state = this.states.get(id) ?? newState()
    applyRecord(state, record)
    this.states.set(id, state)
  }

  private checkpoint(id: string, cause: ReporterCheckpoint['cause']): void {
    const state = this.states.get(id)
    if (!state?.definition) return
    const triggerIds = state.inputs.map(item => item.trigger.id)
    let runtime: ReporterRuntimeSnapshot | null = null
    try { runtime = clone(this.options.snapshot(id, triggerIds)) } catch { /* Store 切换或读取失败时 checkpoint 明示不可用。 */ }
    const latest = state.checkpoints.at(-1)
    if (latest && stableJson(latest.runtime) === stableJson(runtime) && latest.output_ids.join('\0') === state.outputs.map(item => item.id).join('\0')) return
    if (state.checkpoints.length >= REPORTER_LIMITS.checkpointsPerScenario) return
    const checkpoint: ReporterCheckpoint = { id: `${id}:${state.inputs.at(-1)?.envelope.sequence ?? 0}:${state.checkpoints.length + 1}`,
      scenario_id: id, scenario_version: state.definition.version, sequence: state.inputs.at(-1)?.envelope.sequence ?? 0, cause,
      trigger_ids: triggerIds, runtime, snapshot_available: runtime !== null, output_ids: state.outputs.map(item => item.id), created_at: this.now() }
    const record: ReporterJournalRecord = { type: 'checkpoint.created', checkpoint }
    this.append(id, record)
    this.apply(id, record)
  }

  private related(state: ReporterState, event: DomainEvent): boolean {
    const definition = state.definition!
    const triggerIds = new Set(state.inputs.map(item => item.trigger.id))
    const threadKey = `${definition.project_source_id}:reporter:${definition.id}:${definition.thread_id}`
    if (event.type === 'trigger.received') return triggerIds.has(event.data.triggerId)
      || event.data.triggerId === reporterTriggerId(definition.id, (state.inputs.at(-1)?.envelope.sequence ?? 0) + 1)
    if (event.type === 'eval.started') return event.data.threadKey === threadKey || event.data.triggerIds.some(id => triggerIds.has(id))
    if (event.type === 'decision.recorded') return event.data.threadKey === threadKey
      || state.domainEvents.some(item => item.type === 'eval.started' && item.data.threadKey === event.data.threadKey)
    if (event.type === 'ticket.created') return state.domainEvents.some(item => item.type === 'decision.recorded' && item.data.decisionId === event.data.decisionId)
    if (event.type === 'ticket.resumed') return triggerIds.has(event.data.triggerId) || this.snapshotTickets(state).has(event.data.ticketId)
    if (event.type === 'ticket.ended' || event.type === 'assignment.started' || event.type === 'assignment.ended'
      || event.type === 'thread.subscribed' || event.type === 'thread.unsubscribed') {
      return this.snapshotTickets(state).has(event.data.ticketId)
        || ('threadKey' in event.data && event.data.threadKey === threadKey)
    }
    if (event.type === 'trigger.requeued' || event.type === 'trigger.followup') return triggerIds.has(event.data.triggerId)
    return false
  }

  private snapshotTickets(state: ReporterState): Set<string> {
    const definition = state.definition!
    try { return new Set(this.options.snapshot(definition.id, state.inputs.map(item => item.trigger.id)).tickets.map(item => item.id)) }
    catch { return new Set() }
  }

  private result(id: string, state: ReporterState): ReporterScenarioResult {
    const definition = state.definition!
    const triggerIds = state.inputs.map(item => item.trigger.id)
    let runtime: ReporterRuntimeSnapshot | null = null
    try { runtime = clone(this.options.snapshot(id, triggerIds)) } catch { /* 查询状态失败时不以空状态替代。 */ }
    const oracle = evaluateOracle(definition, state.inputs, runtime, state.outputs)
    return { scenario_id: id, scenario_version: definition.version, status: state.completed ? 'completed' : state.inputs.length ? 'running' : 'registered',
      behavioral_pass: state.completed ? oracle.behavioral_pass : null, platform_pass: null, delivery_pass: state.completed ? oracle.delivery_pass : null,
      coverage: { behavior: 'local-engine', platform: 'not-run', delivery: 'local-sink' }, simulator: simulatorView(definition),
      inputs: clone(state.inputs.map(item => ({ envelope: item.envelope, trigger: item.trigger, ack: item.ack, recorded_at: item.at }))),
      outputs: clone(state.outputs), domain_events: clone(state.domainEvents), checkpoints: clone(state.checkpoints), runtime, snapshot_available: runtime !== null,
      oracle, ...(state.review ? { review: clone(state.review) } : {}), usage: clone(state.usage) }
  }
}

function newState(): ReporterState { return { records: [], inputs: [], pending: [], outputs: [], domainEvents: [], checkpoints: [], usage: [], completed: false } }
function applyRecord(state: ReporterState, record: ReporterJournalRecord): void {
  state.records.push(clone(record))
  switch (record.type) {
    case 'scenario.registered': state.definition = clone(record.definition); break
    case 'input.pending': state.pending = state.pending.filter(item => item.envelope.idempotency_key !== record.envelope.idempotency_key)
      .concat({ envelope: clone(record.envelope), digest: record.digest, trigger: clone(record.trigger), at: record.at }); break
    case 'input.accepted':
      state.pending = state.pending.filter(item => item.envelope.idempotency_key !== record.envelope.idempotency_key)
      if (!state.inputs.some(item => item.envelope.idempotency_key === record.envelope.idempotency_key)) {
        state.inputs.push({ envelope: clone(record.envelope), digest: record.digest, trigger: clone(record.trigger), ack: clone(record.ack), at: record.at })
      }
      break
    case 'input.failed': state.pending = state.pending.filter(item => item.envelope.idempotency_key !== record.envelope.idempotency_key); break
    case 'output.captured': if (!state.outputs.some(item => item.id === record.output.id)) state.outputs.push(clone(record.output)); break
    case 'domain.observed': state.domainEvents.push(clone(record.event)); break
    case 'checkpoint.created': state.checkpoints.push(clone(record.checkpoint)); break
    case 'scenario.completed': state.completed = true; break
    case 'review.recorded': state.review = clone(record.review); break
    case 'usage.recorded': state.usage.push(clone(record.usage)); break
  }
}

function parseRecord(value: unknown): ReporterJournalRecord {
  if (!jsonObject(value) || typeof value.type !== 'string') throw new Error('invalid journal record')
  switch (value.type) {
    case 'scenario.registered': {
      const definition = ReporterScenarioSchema.parse(value.definition)
      if (!validString(value.at)) throw new Error('invalid timestamp')
      return { type: value.type, definition, at: value.at }
    }
    case 'input.pending': {
      const envelope = ReporterEnvelopeSchema.parse(value.envelope)
      if (!validString(value.digest) || !jsonObject(value.trigger) || !validString(value.at)) throw new Error('invalid pending input')
      return { type: value.type, envelope, digest: value.digest, trigger: value.trigger as unknown as Trigger, at: value.at }
    }
    case 'input.accepted': {
      const envelope = ReporterEnvelopeSchema.parse(value.envelope)
      if (!validString(value.digest) || !jsonObject(value.ack) || !jsonObject(value.trigger) || !validString(value.at)) throw new Error('invalid input')
      return { type: value.type, envelope, digest: value.digest, trigger: value.trigger as unknown as Trigger,
        ack: value.ack as unknown as ReporterAck, at: value.at }
    }
    case 'input.failed': {
      const envelope = ReporterEnvelopeSchema.parse(value.envelope)
      if (!validString(value.digest) || !validString(value.code) || !validString(value.at)) throw new Error('invalid failed input')
      return { type: value.type, envelope, digest: value.digest, code: value.code, at: value.at }
    }
    case 'output.captured': {
      if (!jsonObject(value.output) || !validString(value.output.id) || !validString(value.output.scenario_id) || !validString(value.output.trigger_id)
        || !validString(value.output.text) || !validString(value.output.at)) throw new Error('invalid output')
      return { type: value.type, output: value.output as unknown as ReporterOutput }
    }
    case 'domain.observed': {
      if (!jsonObject(value.event) || !validString(value.event.type) || !validString(value.event.at) || !jsonObject(value.event.data)) throw new Error('invalid domain event')
      return { type: value.type, event: value.event as unknown as DomainEvent }
    }
    case 'checkpoint.created': {
      if (!jsonObject(value.checkpoint) || !validString(value.checkpoint.id) || !validString(value.checkpoint.scenario_id)) throw new Error('invalid checkpoint')
      return { type: value.type, checkpoint: value.checkpoint as unknown as ReporterCheckpoint }
    }
    case 'scenario.completed': if (!validString(value.at)) throw new Error('invalid completion'); return { type: value.type, at: value.at }
    case 'review.recorded': {
      const parsed = ReviewSchema.parse(value.review)
      return { type: value.type, review: parsed }
    }
    case 'usage.recorded': {
      const parsed = UsageSchema.parse(value.usage)
      if (!validString(value.at)) throw new Error('invalid usage timestamp')
      return { type: value.type, usage: parsed, at: value.at }
    }
    default: throw new Error('unknown journal record')
  }
}

function simulatorView(definition: ReporterScenarioDefinition): ReporterSimulatorScenario {
  return clone({ id: definition.id, version: definition.version, project_source_id: definition.project_source_id, thread_id: definition.thread_id,
    thread_kind: definition.thread_kind, ...(definition.title ? { title: definition.title } : {}), visible: definition.visible, actors: definition.actors,
    ...(definition.timeout_ms ? { timeout_ms: definition.timeout_ms } : {}) })
}

function evaluateOracle(definition: ReporterScenarioDefinition, inputs: InputRecord[], runtime: ReporterRuntimeSnapshot | null, outputs: ReporterOutput[]): ReporterOracleResult {
  const triggerIdsBySequence = new Map(inputs.map(item => [item.envelope.sequence, item.trigger.id]))
  const checks: ReporterOracleCheck[] = definition.oracle.assertions.map(assertion => {
    let actual: unknown
    let passed = false
    const requiresRuntime = ['decision', 'ticket-count', 'ticket-outcome', 'report-state', 'forbid-ticket'].includes(assertion.kind)
    if (requiresRuntime && !runtime) return { assertion: clone(assertion), passed: false, actual: { unavailable: 'snapshot_unavailable' } }
    switch (assertion.kind) {
      case 'receive': {
        actual = inputs.find(item => item.envelope.sequence === assertion.sequence)?.ack.disposition
        passed = actual === assertion.result
        break
      }
      case 'decision': {
        const triggerId = assertion.sequence === undefined ? undefined : triggerIdsBySequence.get(assertion.sequence)
        const found = runtime!.decisions.filter(item => assertion.sequence === undefined || item.triggerIds.includes(triggerId ?? ''))
        actual = found.map(item => item.kind)
        passed = found.some(item => item.kind === assertion.decision)
        break
      }
      case 'ticket-count': actual = runtime!.tickets.length; passed = actual === assertion.count; break
      case 'ticket-outcome': {
        actual = runtime!.tickets.map(item => item.outcome).filter((item): item is TicketOutcome => item !== undefined).sort()
        passed = stableJson(actual) === stableJson([...assertion.outcomes].sort())
        break
      }
      case 'report-state': {
        actual = runtime!.tickets.map(item => item.reportState).filter((item): item is ReportState => item !== undefined).sort()
        passed = stableJson(actual) === stableJson([...assertion.states].sort())
        break
      }
      case 'output-count': {
        const matches = assertion.output ? outputs.filter(item => item.kind === assertion.output) : outputs
        actual = matches.length; passed = actual === assertion.count
        break
      }
      case 'forbid-output': actual = outputs.filter(item => item.kind === assertion.output).length; passed = actual === 0; break
      case 'forbid-ticket': actual = runtime!.tickets.length; passed = runtime!.tickets.length === 0; break
    }
    return { assertion: clone(assertion), passed, actual }
  })
  const delivery = checks.filter(item => ['output-count', 'forbid-output'].includes(item.assertion.kind))
  const behavior = checks.filter(item => !['output-count', 'forbid-output'].includes(item.assertion.kind))
  const stateDependent = behavior.some(item => ['decision', 'ticket-count', 'ticket-outcome', 'report-state', 'forbid-ticket'].includes(item.assertion.kind))
  const behavioralPass = behavior.length ? runtime === null && stateDependent ? false : behavior.every(item => item.passed) : null
  const deliveryPass = delivery.length ? delivery.every(item => item.passed) : null
  return { passed: checks.every(item => item.passed), behavioral_pass: behavioralPass, delivery_pass: deliveryPass, snapshot_available: runtime !== null, checks }
}
