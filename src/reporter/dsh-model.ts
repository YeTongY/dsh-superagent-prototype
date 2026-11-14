/** DSH 原生 Reporter 模型绑定，可为每次调用单独覆盖推理等级。 */
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, ReasoningEffortId, type RequestMessage } from '@deepseek-ai/dsh-llm'
import type { ReporterModelInvoker, ReporterModelResponse } from './coordinator.ts'
import type {} from '@deepseek-ai/dsh-api-session-controller'

/** Reporter 使用的模型路由，并显式固定为 medium 推理等级。 */
export interface ReporterModelRoute {
  provider: string
  model: string
  reasoningEffort: 'medium'
}

/** Reporter 模型调用失败时对外公开的稳定错误码。 */
export type ReporterModelErrorCode = 'reporter_model_unavailable' | 'reporter_model_aborted' | 'reporter_model_failed'

/** 安全且稳定的错误类型；Provider 原始消息可能包含接口地址或请求细节。 */
export class ReporterModelError extends Error {
  constructor(readonly code: ReporterModelErrorCode) {
    super(code === 'reporter_model_unavailable' ? 'Reporter 默认模型未就绪或不支持 medium 推理等级'
      : code === 'reporter_model_aborted' ? 'Reporter 模型调用已取消' : 'Reporter 模型调用失败')
    this.name = 'ReporterModelError'
  }
}

/** 解析 DSH 当前默认模型路由，并验证该模型确实支持 medium 推理等级。 */
export async function resolveReporterModel(ctx: Context): Promise<ReporterModelRoute> {
  try {
    const selected = (await ctx.sessionController.modelCatalog()).default
    if (!selected.provider || !selected.model) throw new ReporterModelError('reporter_model_unavailable')
    const resolved = await ctx.llm.resolveCallConfig({ provider: selected.provider, model: selected.model,
      reasoningEffort: ReasoningEffortId('medium') })
    if (resolved.provider !== selected.provider || resolved.model !== selected.model || resolved.reasoningEffort !== ReasoningEffortId('medium')) {
      throw new ReporterModelError('reporter_model_unavailable')
    }
    return { provider: selected.provider, model: selected.model, reasoningEffort: 'medium' }
  } catch (error) {
    if (error instanceof ReporterModelError) throw error
    throw new ReporterModelError('reporter_model_unavailable')
  }
}

const MAX_OUTPUT_TOKENS = 4_096
const callLimit = (remaining: number | undefined): number => {
  if (remaining === undefined) return MAX_OUTPUT_TOKENS
  if (!Number.isSafeInteger(remaining) || remaining < 1) throw new ReporterModelError('reporter_model_failed')
  return Math.min(MAX_OUTPUT_TOKENS, remaining)
}

/**
 * 使用 DSH 模型路由创建单次 JSON 调用器；不另建 HTTP 客户端、不复制凭据，也不更改目标 Agent 的模型选择。
 */
export function createReporterModelInvoker(ctx: Context, route: ReporterModelRoute): ReporterModelInvoker {
  return async request => {
    request.signal.throwIfAborted()
    const maxTokens = callLimit(request.remaining_budget.total_tokens)
    const input = `${request.instructions}\n\n${JSON.stringify(request.input)}`
    const messages: RequestMessage[] = [{ role: 'user', content: [{ type: 'text', text: input }] }]
    const assembler = new BlockAssembler()
    try {
      const stream = ctx.llm.stream({ provider: route.provider, model: route.model,
        reasoningEffort: ReasoningEffortId('medium'), messages, maxTokens, signal: request.signal })
      for await (const chunk of stream) {
        assembler.push(chunk)
        if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text.trim().length > 0) request.onProgress?.()
      }
    } catch {
      throw new ReporterModelError(request.signal.aborted ? 'reporter_model_aborted' : 'reporter_model_failed')
    }

    const finish = assembler.finish
    if (finish.kind === 'aborted') throw new ReporterModelError('reporter_model_aborted')
    if (finish.kind !== 'stop') throw new ReporterModelError('reporter_model_failed')

    let output = ''
    try {
      output = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
    } catch {
      throw new ReporterModelError('reporter_model_failed')
    }
    let parsed: unknown
    try { parsed = JSON.parse(output) } catch { throw new ReporterModelError('reporter_model_failed') }

    const usage = assembler.usage
    const response: ReporterModelResponse = { output: parsed }
    if (usage) {
      // DSH 的 inputTokens 不含缓存输入，因此单独累加缓存 Token；outputTokens 已包含推理 Token。
      response.usage = { model: route.model,
        prompt_tokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
        completion_tokens: usage.outputTokens }
    }
    return response
  }
}
