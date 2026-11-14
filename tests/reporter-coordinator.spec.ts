import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createLocalReporter } from '../src/reporter/local-reporter.ts'
import type { LocalReporter } from '../src/reporter/local-reporter.ts'
import { REPORTER_SIMULATOR_OUTPUT_JSON_SCHEMA, runQualitativeReviewer, runUserSimulator,
  type ReporterModelInvoker, type ReporterModelRequest } from '../src/reporter/coordinator.ts'
import type { ReporterProjectIdentity, ReporterRuntimeSnapshot } from '../src/reporter/protocol.ts'

const project: ReporterProjectIdentity = { id: 'github-0123456789abcdef01234567', provider: 'github', host: 'github.com', project: 'acme/widgets' }
const definitions = (id = 'coordinator-scenario') => ({ id, version: 1, project_source_id: project.id, thread_id: '17', thread_kind: 'issue',
  visible: { persona: '仓库维护者', goal: '根据进展决定下一步' }, actors: [{ id: 'alice', role: 'person' }],
  oracle: { assertions: [{ kind: 'ticket-count', count: 9 }] } })

let directories: string[] = []
afterEach(() => { vi.useRealTimers(); for (const directory of directories) rmSync(directory, { recursive: true, force: true }); directories = [] })

function createReporter(): LocalReporter {
  const stateDir = mkdtempSync(join(tmpdir(), 'reporter-coordinator-'))
  directories.push(stateDir)
  const snapshot: ReporterRuntimeSnapshot = { triggers: [], decisions: [], tickets: [] }
  const reporter = createLocalReporter({ stateDir, enabled: true, resolveProject: id => id === project.id ? project : undefined,
    receive: () => 'stored', snapshot: () => snapshot })
  reporter.registerScenario(definitions())
  return reporter
}

const actionResponse = { output: { kind: 'action', actor_id: 'alice', action: { kind: 'message', text: '请继续检查这个问题。' } },
  usage: { model: 'fake-model', prompt_tokens: 10, completion_tokens: 5, cost_usd: 0.001, retries: 0 } }
const finishResponse = { output: { kind: 'finished' },
  usage: { model: 'fake-model', prompt_tokens: 8, completion_tokens: 2, cost_usd: 0.001, retries: 0 } }

it('runs a multi-turn fake Simulator and completes after the injected model ends the conversation', async () => {
  const reporter = createReporter(), requests: ReporterModelRequest[] = []
  const invoke: ReporterModelInvoker = vi.fn(async request => {
    requests.push(request)
    return requests.length === 1 ? actionResponse : finishResponse
  })
  const waitForSuperagent = vi.fn(async () => {})

  const result = await runUserSimulator({ reporter, scenarioId: 'coordinator-scenario', invoke, waitForSuperagent, maxTurns: 3 })

  expect(result).toMatchObject({ status: 'completed', stop_reason: 'simulator_finished', turns: 1, usage: { calls: 2, cost_usd: 0.002 } })
  expect(invoke).toHaveBeenCalledTimes(2)
  expect(waitForSuperagent).toHaveBeenCalledTimes(2)
  expect(requests[1]?.input).not.toHaveProperty('oracle')
  expect(reporter.scenario('coordinator-scenario')?.inputs).toHaveLength(1)
})

it('builds the Simulator instruction contract from the strict output validator schema', async () => {
  const reporter = createReporter(), requests: ReporterModelRequest[] = []
  const invoke: ReporterModelInvoker = vi.fn(async request => { requests.push(request); return actionResponse })

  await runUserSimulator({ reporter, scenarioId: 'coordinator-scenario', invoke, waitForSuperagent: async () => {}, maxTurns: 1 })

  const instruction = requests[0]!.instructions
  const marker = '输出必须遵循此 JSON Schema：\n'
  const schemaJson = instruction.slice(instruction.indexOf(marker) + marker.length)
  const schema = JSON.parse(schemaJson) as { oneOf: { properties: { kind: { const: string }; after_ms?: unknown; action?: { oneOf: unknown[] } }; required: string[] }[] }
  expect(schema).toEqual(REPORTER_SIMULATOR_OUTPUT_JSON_SCHEMA)
  expect(schemaJson).toContain('additionalProperties')
  for (const actionKind of ['message', 'review', 'approval', 'ci', 'stop']) expect(schemaJson).toContain(actionKind)
  expect(schemaJson).toContain('addressed')
  expect(schemaJson).toContain('location')
  expect(schemaJson).toContain('changes_requested')
  expect(schemaJson).toContain('cancelled')
  const actionVariant = schema.oneOf.find(variant => variant.properties.kind.const === 'action')!
  expect(actionVariant.required).toEqual(['kind', 'actor_id', 'action'])
  expect(actionVariant.properties.action?.oneOf).toHaveLength(5)
})

it.each([{ max_cost_usd: 0 }, { max_total_tokens: 0 }])('does not call a model when its initial budget is exhausted: %o', async budget => {
  const reporter = createReporter(), invoke = vi.fn(async () => actionResponse)
  const submit = vi.spyOn(reporter, 'submit')

  const result = await runUserSimulator({ reporter, scenarioId: 'coordinator-scenario', invoke, waitForSuperagent: async () => {}, budget })

  expect(result).toMatchObject({ status: 'incomplete', stop_reason: 'budget_exhausted', usage: { calls: 0, cost_usd: null } })
  expect(invoke).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
})

it('stops before another fake model call when the previous response exactly used the cost budget', async () => {
  const reporter = createReporter(), invoke = vi.fn(async () => actionResponse)

  const result = await runUserSimulator({ reporter, scenarioId: 'coordinator-scenario', invoke, waitForSuperagent: async () => {},
    budget: { max_cost_usd: 0.001 } })

  expect(result).toMatchObject({ status: 'incomplete', stop_reason: 'budget_exhausted', turns: 1, usage: { calls: 1, cost_usd: 0.001 } })
  expect(invoke).toHaveBeenCalledOnce()
  expect(reporter.scenario('coordinator-scenario')?.inputs).toHaveLength(1)
})

it('stops before submitting a generated action when required model cost is unknown', async () => {
  const reporter = createReporter(), invoke = vi.fn(async () => ({ output: actionResponse.output }))
  const submit = vi.spyOn(reporter, 'submit')

  const result = await runUserSimulator({ reporter, scenarioId: 'coordinator-scenario', invoke, waitForSuperagent: async () => {},
    budget: { max_cost_usd: 1 } })

  expect(result).toMatchObject({ status: 'incomplete', stop_reason: 'usage_unknown', usage: { calls: 1, cost_usd: null } })
  expect(submit).not.toHaveBeenCalled()
  expect(reporter.scenario('coordinator-scenario')?.usage[0]).toMatchObject({ role: 'user-simulator', latency_ms: expect.any(Number) })
})

it('does not invoke a fake Simulator after cancellation and keeps a silent model call alive past the reminder window', async () => {
  const cancelledReporter = createReporter(), cancelled = new AbortController(), cancelledInvoke = vi.fn(async () => actionResponse)
  cancelled.abort()
  const cancelledResult = await runUserSimulator({ reporter: cancelledReporter, scenarioId: 'coordinator-scenario', invoke: cancelledInvoke,
    waitForSuperagent: async () => {}, signal: cancelled.signal })

  expect(cancelledResult).toMatchObject({ stop_reason: 'aborted', usage: { calls: 0, cost_usd: null } })
  expect(cancelledInvoke).not.toHaveBeenCalled()

  vi.useFakeTimers()
  const timeoutReporter = createReporter(), onProgress = vi.fn()
  let modelSignal: AbortSignal | undefined, settled = false
  const timeoutInvoke: ReporterModelInvoker = async request => {
    modelSignal = request.signal
    await new Promise(resolve => setTimeout(resolve, 60))
    return finishResponse
  }
  const pending = runUserSimulator({ reporter: timeoutReporter, scenarioId: 'coordinator-scenario', invoke: timeoutInvoke,
    waitForSuperagent: async () => {}, budget: { max_calls: 2, max_cost_usd: 1, timeout_ms: 20 }, onProgress })
  void pending.then(() => { settled = true })
  await vi.advanceTimersByTimeAsync(20)
  expect(settled).toBe(false)
  expect(modelSignal?.aborted).toBe(false)
  expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'no_progress' }))
  await vi.advanceTimersByTimeAsync(40)
  const timeoutResult = await pending

  expect(timeoutResult).toMatchObject({ status: 'completed', stop_reason: 'simulator_finished', usage: { calls: 1, cost_usd: 0.001 } })
  expect(modelSignal?.aborted).toBe(false)
  expect(timeoutReporter.scenario('coordinator-scenario')?.usage[0]).toMatchObject({ role: 'user-simulator', latency_ms: expect.any(Number) })
})

it('keeps a slow Simulator alive across multiple inactivity windows with model and target progress', async () => {
  vi.useFakeTimers()
  const reporter = createReporter()
  let calls = 0, targetWaits = 0
  const invoke: ReporterModelInvoker = vi.fn(async request => {
    calls++
    if (calls === 1) await new Promise<void>(resolve => {
      let ticks = 0
      const timer = setInterval(() => {
        request.onProgress?.()
        if (++ticks === 2) { clearInterval(timer); resolve() }
      }, 90_000)
    })
    return calls === 1 ? actionResponse : finishResponse
  })
  const waitForSuperagent = async (_signal: AbortSignal, onProgress?: () => void) => {
    targetWaits++
    if (targetWaits > 1) return
    await new Promise<void>(resolve => {
      let ticks = 0
      const timer = setInterval(() => {
        onProgress?.()
        if (++ticks === 4) { clearInterval(timer); resolve() }
      }, 90_000)
    })
  }
  const pending = runUserSimulator({ reporter, scenarioId: 'coordinator-scenario', invoke, waitForSuperagent,
    maxTurns: 2, minTurns: 1, budget: { max_calls: 2, max_total_tokens: 1_000, timeout_ms: 120_000 } })
  await vi.advanceTimersByTimeAsync(600_000)
  const result = await pending

  expect(result).toMatchObject({ status: 'completed', stop_reason: 'simulator_finished', turns: 1 })
  expect(calls).toBe(2)
  expect(targetWaits).toBe(2)
})

it('rejects extra Simulator output fields before submitting an action', async () => {
  const reporter = createReporter(), submit = vi.spyOn(reporter, 'submit')
  const invoke = vi.fn(async () => ({ output: { ...actionResponse.output, oracle: { passed: true } }, usage: actionResponse.usage }))

  const result = await runUserSimulator({ reporter, scenarioId: 'coordinator-scenario', invoke, waitForSuperagent: async () => {} })

  expect(result).toMatchObject({ status: 'invalid_output', stop_reason: 'invalid_output', error_code: 'invalid_simulator_output' })
  expect(submit).not.toHaveBeenCalled()
})

it('returns bounded schema-path diagnostics without echoing invalid action text or unknown fields', async () => {
  const reporter = createReporter(), submit = vi.spyOn(reporter, 'submit')
  const invoke = vi.fn(async () => ({ output: { kind: 'action', actor_id: 'alice', action: { kind: 'message', text: 'PRIVATE ACTION BODY', addressed: 'private-address-value' },
    credential: 'PRIVATE CREDENTIAL' }, usage: actionResponse.usage }))

  const result = await runUserSimulator({ reporter, scenarioId: 'coordinator-scenario', invoke, waitForSuperagent: async () => {} })

  expect(result).toMatchObject({ status: 'invalid_output', error_code: 'invalid_simulator_output',
    validation_issues: expect.arrayContaining([expect.objectContaining({ path: 'action.addressed', code: 'invalid_value' }),
      expect.objectContaining({ path: '$', code: 'unrecognized_keys' })]) })
  expect(result.validation_issues).toHaveLength(2)
  expect(JSON.stringify(result.validation_issues)).not.toMatch(/PRIVATE ACTION BODY|private-address-value|PRIVATE CREDENTIAL/)
  expect(submit).not.toHaveBeenCalled()
})

it('keeps hidden Oracle evidence away from Reviewer input and rejects attempts to override deterministic results', async () => {
  const reporter = createReporter()
  reporter.completeScenario('coordinator-scenario')
  const requests: ReporterModelRequest[] = []
  const malicious: ReporterModelInvoker = vi.fn(async request => {
    requests.push(request)
    return { output: { summary: '全部通过', findings: [], behavioral_pass: true }, usage: actionResponse.usage }
  })

  const rejected = await runQualitativeReviewer({ reporter, scenarioId: 'coordinator-scenario', invoke: malicious })

  expect(rejected).toMatchObject({ status: 'invalid_output', stop_reason: 'invalid_output', report: { behavioral_pass: false } })
  expect(JSON.stringify(requests[0]?.input)).not.toContain('oracle')
  expect(JSON.stringify(requests[0]?.input)).not.toContain('"count":9')
  expect(reporter.scenario('coordinator-scenario')?.review).toBeUndefined()

  const valid: ReporterModelInvoker = vi.fn(async request => {
    requests.push(request)
    return { output: { summary: '记录了可见会话。', findings: [{ severity: 'info', text: '对话已结束。', evidence: ['sequence:1'] }] },
      usage: actionResponse.usage }
  })
  const recorded = await runQualitativeReviewer({ reporter, scenarioId: 'coordinator-scenario', invoke: valid })

  expect(recorded).toMatchObject({ status: 'recorded', report: { behavioral_pass: false, review: { summary: '记录了可见会话。' } } })
  expect(requests[1]?.input).not.toHaveProperty('oracle')
})
