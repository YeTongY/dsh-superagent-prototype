/** 低成本、确定性的 Reporter 用户模拟器；脚本运行时不调用模型。 */
import { z } from 'zod'
import { REPORTER_ERROR_CODES, type ReporterErrorCode, type ReporterUsage } from './local-reporter.ts'
import type { LocalReporter } from './local-reporter.ts'
import type { ReporterAck, ReporterAction, ReporterSimulatorScenario } from './protocol.ts'
import { ReporterActionSchema } from './protocol.ts'

export const ReporterScriptStepSchema = z.object({
  actor_id: z.string().min(1).max(160),
  action: z.unknown(),
  /** 只推进场景模拟时间，不触发真实等待。需要延迟轮询时由外层 coordinator 调度下一次 run。 */
  after_ms: z.number().int().nonnegative().max(86_400_000).default(0),
  /** 显式序号可构造乱序、缺号和旧消息场景；不指定时使用下一个成功序号。 */
  sequence: z.number().int().positive().optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
  repeat: z.number().int().positive().max(3).default(1),
  expect_error: z.enum(REPORTER_ERROR_CODES).optional(),
}).strict()
export type ReporterScriptStep = z.infer<typeof ReporterScriptStepSchema>

export interface ReporterScriptResult {
  scenario_id: string
  accepted: number
  duplicate_responses: number
  rejected: number
  acks: ReporterAck[]
  errors: { step: number; code: string }[]
  simulator_cost_usd: 0
  model_calls: 0
}

const StepsSchema = z.array(ReporterScriptStepSchema).max(2_000)

/**
 * 执行一组可重放的用户动作。Simulator 只接收安全投影，没有 Oracle 预期结果；脚本可混合普通用户、Bot 和 CI Actor。
 * 可用 `expect_error` 覆盖越界 Actor、乱序事件和无效交付请求，已接受事件的序号仍严格递增。
 */
export function runReporterScript(options: {
  reporter: Pick<LocalReporter, 'submit' | 'recordUsage'>
  scenario: ReporterSimulatorScenario
  steps: unknown
  simulatedStart?: string
}): ReporterScriptResult {
  const parsed = StepsSchema.safeParse(options.steps)
  if (!parsed.success) throw new Error('Reporter 脚本必须是最多 2,000 个有效动作的数组')
  const start = Date.parse(options.simulatedStart ?? new Date().toISOString())
  if (!Number.isFinite(start)) throw new Error('Reporter 脚本的 simulatedStart 必须是有效时间')
  let offset = 0, nextSequence = 1, accepted = 0, duplicates = 0, rejected = 0
  const acks: ReporterAck[] = [], errors: { step: number; code: string }[] = []
  for (const [index, raw] of parsed.data.entries()) {
    offset += raw.after_ms
    const action = ReporterActionSchema.parse(raw.action)
    const sequence = raw.sequence ?? nextSequence
    const envelope = { scenario_id: options.scenario.id, scenario_version: options.scenario.version, sequence,
      idempotency_key: raw.idempotency_key ?? `${options.scenario.id}:step:${sequence}`, simulated_at: new Date(start + offset).toISOString(),
      actor_id: raw.actor_id, project_source_id: options.scenario.project_source_id, thread_id: options.scenario.thread_id, action }
    let errorCode: string | undefined
    for (let repeat = 0; repeat < raw.repeat; repeat++) {
      try {
        const ack = options.reporter.submit(envelope)
        acks.push(ack)
        accepted += repeat === 0 && !ack.duplicate ? 1 : 0
        if (ack.duplicate) duplicates++
        if (repeat === 0 && ack.sequence === sequence) nextSequence = sequence + 1
      } catch (error) {
        errorCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown'
        break
      }
    }
    if (errorCode) {
      rejected++
      errors.push({ step: index + 1, code: errorCode })
      if (!raw.expect_error || raw.expect_error !== errorCode) throw new Error(`Reporter 脚本第 ${index + 1} 步失败：${errorCode}`)
    } else if (raw.expect_error) {
      throw new Error(`Reporter 脚本第 ${index + 1} 步预期 ${raw.expect_error}，但动作已被接受`)
    }
  }
  const usage: ReporterUsage = { role: 'user-simulator', model: 'deterministic-script', prompt_tokens: 0, completion_tokens: 0,
    cost_usd: 0, latency_ms: 0, retries: 0 }
  options.reporter.recordUsage(options.scenario.id, usage)
  return { scenario_id: options.scenario.id, accepted, duplicate_responses: duplicates, rejected, acks, errors, simulator_cost_usd: 0, model_calls: 0 }
}

/** 为场景 fixture 声明经过校验的 typed action；Actor 是否属于场景由 Reporter 在提交时再次验证。 */
export const reporterAction = (action: ReporterAction): ReporterAction => ReporterActionSchema.parse(action)

// Keep this import used as a closed public error vocabulary for scenario fixture authors.
export type { ReporterErrorCode }
