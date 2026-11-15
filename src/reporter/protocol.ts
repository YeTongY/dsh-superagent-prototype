/** 本地 Reporter 的输入、场景和领域快照协议。 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { DecisionKind, ReportState, TicketOutcome, Trigger, TriggerDisposition } from '../core/index.ts'
import type { ProjectProvider } from '../project-source.ts'

const identifier = (max = 160) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f]/.test(value), '不能包含控制字符')
const scenarioId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).refine(value => value !== '.' && value !== '..' && !value.includes('..'))
const projectId = z.string().regex(/^[a-z][a-z0-9-]{0,99}$/)
const body = z.string().max(20_000)

/** Reporter 只有在证据充分后才能提交的确认问题；不提供不确定置信度。 */
export const ReporterFindingSchema = z.object({
  finding_id: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20_000),
  evidence: z.string().trim().min(1).max(20_000),
}).strict()
export type ReporterFinding = z.infer<typeof ReporterFindingSchema>

/** Reporter 可模拟的用户动作；平台专属动作通过结构化元数据保留，不调用真实 Provider。 */
export const ReporterActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), text: z.string().min(1).max(20_000), addressed: z.enum(['mention', 'direct']).optional(),
    location: z.enum(['issue', 'pull', 'conversation', 'inline']).optional() }).strict(),
  z.object({ kind: z.literal('review'), state: z.enum(['approved', 'changes_requested', 'commented']), body: body.optional() }).strict(),
  z.object({ kind: z.literal('approval'), state: z.enum(['approved', 'rejected']), body: body.optional() }).strict(),
  z.object({ kind: z.literal('ci'), name: identifier(120), state: z.enum(['queued', 'running', 'success', 'failure', 'cancelled']), summary: body.optional() }).strict(),
  z.object({ kind: z.literal('stop'), text: z.string().min(1).max(20_000) }).strict(),
])
export type ReporterAction = z.infer<typeof ReporterActionSchema>

/** 发给 Reporter 的一个带序号场景动作。 */
export const ReporterEnvelopeSchema = z.object({
  scenario_id: scenarioId,
  scenario_version: z.number().int().positive(),
  sequence: z.number().int().positive(),
  idempotency_key: identifier(200),
  simulated_at: z.string().datetime({ offset: true }),
  actor_id: identifier(160),
  project_source_id: projectId,
  thread_id: identifier(256),
  action: ReporterActionSchema,
}).strict()
export type ReporterEnvelope = z.infer<typeof ReporterEnvelopeSchema>

export const REPORTER_OUTPUT_KINDS = ['acknowledgement', 'reply', 'notice'] as const
export type ReporterOutputKind = typeof REPORTER_OUTPUT_KINDS[number]
export interface ReporterOutput {
  id: string
  scenario_id: string
  scenario_version: number
  sequence: number
  trigger_id: string
  project_source_id: string
  thread_id: string
  ticket_id?: string
  kind: ReporterOutputKind
  text: string
  at: string
}

/** 确定性 Oracle 可检查的运行时证据；不含任何目标模型不可见的预期结果。 */
export interface ReporterRuntimeSnapshot {
  triggers: { id: string; disposition?: TriggerDisposition }[]
  decisions: { id: string; kind: DecisionKind; triggerIds: string[]; ticketId?: string }[]
  tickets: { id: string; originTriggerIds: string[]; state: 'open' | 'ended'; outcome?: TicketOutcome;
    reportState?: ReportState; attention?: { question: string; triggerId?: string } }[]
}

export type ReporterOracleAssertion =
  | { kind: 'receive'; sequence: number; result: 'stored' | 'duplicate' | 'filtered' }
  | { kind: 'decision'; decision: DecisionKind; sequence?: number }
  | { kind: 'ticket-count'; count: number }
  | { kind: 'ticket-outcome'; outcomes: TicketOutcome[] }
  | { kind: 'report-state'; states: ReportState[] }
  | { kind: 'output-count'; output?: ReporterOutputKind; count: number }
  | { kind: 'forbid-output'; output: ReporterOutputKind }
  | { kind: 'forbid-ticket' }

export const ReporterScenarioSchema = z.object({
  id: scenarioId,
  version: z.number().int().positive(),
  project_source_id: projectId,
  thread_id: identifier(256),
  thread_kind: z.enum(['issue', 'pull', 'conversation', 'inline', 'review', 'ci']),
  title: z.string().min(1).max(200).optional(),
  /** 只向 User Simulator 暴露的角色、目标和对话风格指导。 */
  visible: z.object({ persona: z.string().min(1).max(4_000), goal: z.string().min(1).max(4_000), instructions: z.array(z.string().min(1).max(2_000)).max(40).default([]) }).strict(),
  actors: z.array(z.object({ id: identifier(160), role: z.enum(['person', 'bot', 'ci']) }).strict()).min(1).max(32),
  /** 仅由 Oracle 读取，绝不能写入目标 Trigger、Prompt 或 User Simulator 视图。 */
  oracle: z.object({ assertions: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('receive'), sequence: z.number().int().positive(), result: z.enum(['stored', 'duplicate', 'filtered']) }).strict(),
    z.object({ kind: z.literal('decision'), decision: z.enum(['ignore', 'accept', 'reopen', 'stop', 'unavailable']), sequence: z.number().int().positive().optional() }).strict(),
    z.object({ kind: z.literal('ticket-count'), count: z.number().int().nonnegative() }).strict(),
    z.object({ kind: z.literal('ticket-outcome'), outcomes: z.array(z.enum(['completed', 'merged', 'closed', 'dropped', 'stopped'])) }).strict(),
    z.object({ kind: z.literal('report-state'), states: z.array(z.enum(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'])) }).strict(),
    z.object({ kind: z.literal('output-count'), output: z.enum(REPORTER_OUTPUT_KINDS).optional(), count: z.number().int().nonnegative() }).strict(),
    z.object({ kind: z.literal('forbid-output'), output: z.enum(REPORTER_OUTPUT_KINDS) }).strict(),
    z.object({ kind: z.literal('forbid-ticket') }).strict(),
  ])).min(1).max(100) }).strict(),
}).strict()
export type ReporterScenarioDefinition = z.infer<typeof ReporterScenarioSchema>

/** Simulator 可见的场景投影；类型上不含 oracle 字段。 */
export type ReporterSimulatorScenario = Pick<ReporterScenarioDefinition, 'id' | 'version' | 'project_source_id' | 'thread_id' | 'thread_kind' | 'title' | 'visible' | 'actors'>
export interface ReporterProjectIdentity { id: string; provider: ProjectProvider; host: string; project: string }
export interface ReporterAck {
  scenario_id: string
  scenario_version: number
  sequence: number
  trigger_id: string
  disposition: 'stored' | 'duplicate' | 'filtered'
  duplicate: boolean
}

/** 转成从目标 Source 看见的普通 Trigger，同时把本地输出 Channel 指向 Reporter Sink。 */
export function reporterTrigger(definition: ReporterScenarioDefinition, envelope: ReporterEnvelope, project: ReporterProjectIdentity): Trigger {
  const triggerId = reporterTriggerId(envelope.scenario_id, envelope.sequence)
  const role = definition.actors.find(actor => actor.id === envelope.actor_id)!.role
  const text = actionText(envelope.action)
  const channel = { source: 'local-reporter', thread: `scenario:${envelope.scenario_id}:${envelope.thread_id}`,
    address: { scenario_id: envelope.scenario_id, scenario_version: String(envelope.scenario_version), sequence: String(envelope.sequence),
      trigger_id: triggerId, project_source_id: envelope.project_source_id, thread_id: envelope.thread_id } }
  const location = envelope.action.kind === 'message' ? envelope.action.location ?? definition.thread_kind : definition.thread_kind
  const numericThread = /^\d+$/.test(envelope.thread_id) ? Number(envelope.thread_id) : undefined
  const mergeRequest = ['pull', 'inline', 'review'].includes(location)
  const projectMeta = project.provider === 'github'
    ? envelope.action.kind === 'ci' || location === 'ci'
      ? { ci: true, status: envelope.action.kind === 'ci' ? envelope.action.state : undefined,
        ...(location === 'ci' ? { branch: envelope.thread_id.replace(/^ci:/, '') } : { number: numericThread, isPr: true }) }
      : { kind: envelope.action.kind === 'review' || envelope.action.kind === 'approval' ? 'review' : location,
        ...(numericThread === undefined ? {} : { number: numericThread }), isPr: mergeRequest }
    : envelope.action.kind === 'ci'
      ? { kind: 'pipeline', ci: true, status: envelope.action.state,
        ...(location === 'ci' ? { branch: envelope.thread_id.replace(/^ci:/, ''), projectPipeline: true }
          : { ...(numericThread === undefined ? {} : { iid: numericThread, number: numericThread }), isMr: true, isPr: true, projectPipeline: false }) }
      : envelope.action.kind === 'review' || envelope.action.kind === 'approval'
        ? { kind: 'approval', ...(numericThread === undefined ? {} : { iid: numericThread, number: numericThread }), isMr: mergeRequest, isPr: mergeRequest,
          approved: envelope.action.state === 'approved', revision: envelope.sequence }
        : { kind: location === 'pull' ? 'merge_request' : location, ...(numericThread === undefined ? {} : { iid: numericThread, number: numericThread }),
          isMr: mergeRequest, isPr: mergeRequest }
  return { id: triggerId, source: envelope.project_source_id,
    // 场景 ID 隔离同一项目中的测试会话，原生 thread_id 仍放在 meta 和 Channel address 中供 Reporter 查验。
    threads: [{ source: envelope.project_source_id, id: `reporter:${envelope.scenario_id}:${envelope.thread_id}` }],
    actor: { source: envelope.project_source_id, id: envelope.actor_id }, human: role === 'person',
    ...envelope.action.kind === 'message' && envelope.action.addressed ? { addressed: envelope.action.addressed } : {},
    at: new Date(envelope.simulated_at).toISOString(), text, channel,
    meta: { ...projectMeta, projectSourceId: envelope.project_source_id, provider: project.provider,
      reporter: { scenarioId: envelope.scenario_id, scenarioVersion: envelope.scenario_version,
        sequence: envelope.sequence, idempotencyKey: envelope.idempotency_key, actorRole: role, action: envelope.action } } }
}

export function reporterTriggerId(scenario: string, sequence: number): string {
  const opaque = createHash('sha256').update(`${scenario}\0${sequence}`).digest('hex').slice(0, 32)
  return `reporter:${opaque}`
}

/** 确认 finding 的稳定 Trigger ID；同一运行和 finding 重试时必须复用它。 */
export function reporterFindingTriggerId(runId: string, findingId: string): string {
  const opaque = createHash('sha256').update(`${runId}\0${findingId}`).digest('hex').slice(0, 32)
  return `reporter:finding:${opaque}`
}

/** 把确认 finding 送入目标 ProjectSource 的正常 Engine/Intake 链路。 */
export function reporterFindingTrigger(runId: string, finding: ReporterFinding, project: ReporterProjectIdentity, at: string): Trigger {
  if (project.id !== project.id.trim() || !project.id) throw new Error('Reporter finding 项目身份无效')
  const triggerId = reporterFindingTriggerId(runId, finding.finding_id)
  const threadId = `reporter:finding:${runId}:${finding.finding_id}`
  const channel = { source: 'local-reporter', thread: `finding:${runId}:${finding.finding_id}`,
    address: { run_id: runId, finding_id: finding.finding_id, trigger_id: triggerId, project_source_id: project.id } }
  return { id: triggerId, source: project.id,
    threads: [{ source: project.id, id: threadId }], actor: { source: project.id, id: '' }, human: false,
    at: new Date(at).toISOString(), text: `${finding.title}\n\n${finding.body}\n\n证据：\n${finding.evidence}`, channel,
    meta: { kind: 'conversation', projectSourceId: project.id, provider: project.provider,
      reporter: { kind: 'finding', confidence: 'confirmed', runId, findingId: finding.finding_id } } }
}

export function actionText(action: ReporterAction): string {
  switch (action.kind) {
    case 'message': return action.text
    case 'review': return `Review ${action.state}${action.body ? `: ${action.body}` : ''}`
    case 'approval': return `Approval ${action.state}${action.body ? `: ${action.body}` : ''}`
    case 'ci': return `CI ${action.name} ${action.state}${action.summary ? `: ${action.summary}` : ''}`
    case 'stop': return action.text
  }
}

/** 将对象键排序，保证相同请求在重启前后得到相同摘要。 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function reporterEnvelopeDigest(envelope: ReporterEnvelope): string {
  return createHash('sha256').update(stableJson(envelope)).digest('hex')
}
