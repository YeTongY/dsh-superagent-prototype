import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { createReporterModelInvoker, ReporterModelError, resolveReporterModel } from '../src/reporter/dsh-model.ts'
import type { ReporterExplorerInput, ReporterModelRequest } from '../src/reporter/coordinator.ts'

const selected = { provider: 'codex-custom', model: 'gpt-6.1-sol', reasoningEffort: 'high' }
const textStream = (text: string, usage?: StreamChunk): AsyncIterable<StreamChunk> => ({
  async *[Symbol.asyncIterator]() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    if (usage) yield usage
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
})
function host(stream: AsyncIterable<StreamChunk> = textStream('{"ok":true}')) {
  const llm = {
    resolveCallConfig: vi.fn(async (config: Record<string, unknown>) => config),
    stream: vi.fn(() => stream),
  }
  const sessionController = { modelCatalog: vi.fn(async () => ({ default: selected })) }
  return { context: { llm, sessionController } as unknown as Context, llm, sessionController }
}
const request = (signal = new AbortController().signal): ReporterModelRequest => {
  const input: ReporterExplorerInput = { goal: '检查自主测试接口', mode: 'simulation', permissions: { simulation: true, read_only_service: false, browser: false },
    remaining: { experiments: 1, actions: 2, model_calls: 3, tokens: 1200 }, capabilities: [], project: undefined, safe_state: {},
    available_read_only_probes: [], can_simulate_users: true, can_test_browser: false, previous_experiments: [] }
  return { role: 'autonomous-explorer', instructions: 'return JSON', input, signal, remaining_budget: { total_tokens: 1200 } }
}

describe('DSH Reporter model binding', () => {
  it('validates and routes each Reporter call at medium without inheriting the target high effort', async () => {
    const fixture = host()
    const model = await resolveReporterModel(fixture.context)
    expect(model).toEqual({ provider: 'codex-custom', model: 'gpt-6.1-sol', reasoningEffort: 'medium' })
    expect(fixture.llm.resolveCallConfig).toHaveBeenCalledWith(expect.objectContaining({ provider: selected.provider,
      model: selected.model, reasoningEffort: 'medium' }))

    const invoke = createReporterModelInvoker(fixture.context, model)
    const input = request()
    await expect(invoke(input)).resolves.toMatchObject({ output: { ok: true } })
    expect(fixture.llm.stream).toHaveBeenCalledWith(expect.objectContaining({ provider: selected.provider, model: selected.model,
      reasoningEffort: 'medium', maxTokens: 1200, signal: input.signal }))
  })

  it('includes cached prompt tokens and leaves unreported price and retry counts unknown', async () => {
    const fixture = host(textStream('{"next":"action"}', { type: 'usage', usage: {
      inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 40, reasoningTokens: 10,
    } }))
    const invoke = createReporterModelInvoker(fixture.context, { provider: selected.provider, model: selected.model, reasoningEffort: 'medium' })
    const result = await invoke(request())
    expect(result.usage).toEqual({ model: selected.model, prompt_tokens: 1050, completion_tokens: 40 })
    expect(result.usage).not.toHaveProperty('cost_usd')
    expect(result.usage).not.toHaveProperty('retries')
  })

  it('does not call the provider when already cancelled', async () => {
    const fixture = host()
    const controller = new AbortController()
    controller.abort()
    const invoke = createReporterModelInvoker(fixture.context, { provider: selected.provider, model: selected.model, reasoningEffort: 'medium' })
    await expect(invoke(request(controller.signal))).rejects.toMatchObject({ name: 'AbortError' })
    expect(fixture.llm.stream).not.toHaveBeenCalled()
  })

  it('rejects non-stop finishes and sanitizes provider failure details', async () => {
    const broken: AsyncIterable<StreamChunk> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UPSTREAM', message: 'secret endpoint and credential' } } } as StreamChunk
      },
    }
    const fixture = host(broken)
    const invoke = createReporterModelInvoker(fixture.context, { provider: selected.provider, model: selected.model, reasoningEffort: 'medium' })
    const error = await invoke(request()).catch(value => value)
    expect(error).toMatchObject({ code: 'reporter_model_failed' })
    expect((error as Error).message).not.toMatch(/secret endpoint|credential/)
  })

  it('fails closed if the exact model route rejects medium', async () => {
    const fixture = host()
    fixture.llm.resolveCallConfig.mockRejectedValueOnce(new Error('secret endpoint'))
    await expect(resolveReporterModel(fixture.context)).rejects.toMatchObject({
      code: 'reporter_model_unavailable', message: 'Reporter 默认模型未就绪或不支持 medium 推理等级',
    })
    expect(fixture.llm.stream).not.toHaveBeenCalled()
  })

  it('does not let output exceed the remaining total-token budget and rejects empty budget', async () => {
    const fixture = host()
    const invoke = createReporterModelInvoker(fixture.context, { provider: selected.provider, model: selected.model, reasoningEffort: 'medium' })
    await invoke({ ...request(), remaining_budget: { total_tokens: 30 } })
    expect(fixture.llm.stream).toHaveBeenLastCalledWith(expect.objectContaining({ maxTokens: 30 }))
    await expect(invoke({ ...request(), remaining_budget: { total_tokens: 0 } }))
      .rejects.toMatchObject({ code: 'reporter_model_failed' })
    expect(fixture.llm.stream).toHaveBeenCalledTimes(1)
  })
})
