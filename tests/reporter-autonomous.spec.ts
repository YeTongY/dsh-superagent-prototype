import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReporterAutonomousRuns, type ReporterAutonomousHost } from '../src/reporter/autonomous.ts'
import type { ReporterModelInvoker, ReporterModelRequest, ReporterModelResponse } from '../src/reporter/coordinator.ts'
import type { ReporterScenarioDefinition, ReporterEnvelope } from '../src/reporter/protocol.ts'
import { ReporterBrowserError, type ReporterBrowserDriver, type ReporterBrowserObservation } from '../src/reporter/browser.ts'

const directories: string[] = []
afterEach(() => { vi.useRealTimers(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

const request = (overrides: Record<string, unknown> = {}) => ({ idempotency_key: 'autonomous-test-1', goal: '检查产品在只读分析请求下的真实行为',
  project_source_id: 'github', mode: 'simulation', permissions: { simulation: true }, ...overrides })
const usage = { model: 'gpt-6.1-sol', prompt_tokens: 10, completion_tokens: 5 }
const scenarioResult = (id: string, inputs: ReporterEnvelope[], outputs: { kind: string; text: string; id: string; at: string; sequence: number }[], review?: unknown) => ({
  scenario_id: id, scenario_version: 1, status: 'completed', behavioral_pass: true, platform_pass: null, delivery_pass: null,
  coverage: { behavior: 'local-engine', platform: 'not-run', delivery: 'local-sink' }, simulator: {}, inputs: inputs.map((envelope, index) => ({ envelope,
    trigger: { id: `trigger-${index + 1}`, text: (envelope.action as { text?: string }).text ?? '动作' }, ack: { disposition: 'stored' }, recorded_at: '2026-11-14T00:00:00.000Z' })),
  outputs, domain_events: [], checkpoints: [], runtime: { triggers: [], decisions: [{ kind: 'accept', triggerIds: ['trigger-1'] }], tickets: [] }, snapshot_available: true,
  oracle: { passed: true, checks: [{ assertion: { kind: 'receive', sequence: 1 }, passed: true }, { assertion: { kind: 'decision', decision: 'accept' }, passed: true }] },
  ...(review ? { review } : {}), usage: [] })

function fakeHost(directory: string, invoke: ReporterAutonomousHost['resolveModel'] extends () => Promise<infer T> ? T extends { invoke: infer I } ? I : never : never): ReporterAutonomousHost {
  let definition: ReporterScenarioDefinition | undefined
  const inputs: ReporterEnvelope[] = [], outputs: { kind: string; text: string; id: string; at: string; sequence: number }[] = []
  let review: unknown
  const result = (id: string) => scenarioResult(id, inputs, outputs, review) as never
  const client = {
    registerScenario: (value: unknown) => { definition = value as ReporterScenarioDefinition; return { ...definition, oracle: undefined } as never },
    simulatorFeedback: (id: string) => ({ scenario: { ...definition, oracle: undefined }, last_sequence: inputs.length,
      conversation: [...inputs.map((item, index) => ({ role: 'actor' as const, actor_id: item.actor_id, simulated_at: item.simulated_at,
        text: (item.action as { text?: string }).text ?? '动作' })), ...outputs.map(item => ({ role: 'superagent' as const, kind: 'reply' as const,
        simulated_at: item.at, text: item.text }))] }),
    submit: (value: unknown) => { const envelope = value as ReporterEnvelope; inputs.push(envelope); return { scenario_id: envelope.scenario_id,
      scenario_version: envelope.scenario_version, sequence: envelope.sequence, trigger_id: `trigger-${envelope.sequence}`, disposition: 'stored', duplicate: false } },
    recordUsage: vi.fn(), completeScenario: (id: string) => result(id), scenario: (id: string) => result(id),
    reviewEvidence: (id: string) => ({ simulator: { ...definition, oracle: undefined }, inputs: inputs.map((item, index) => ({ sequence: item.sequence,
      actor_id: item.actor_id, action: item.action, text: (item.action as { text?: string }).text ?? '动作', simulated_at: item.simulated_at })), outputs: [...outputs],
      domain_events: [], runtime: { triggers: [], decisions: [], tickets: [] }, snapshot_available: true }),
    recordReview: (id: string, value: unknown) => { review = value; return result(id) },
  }
  return { reporter: client as never, enabled: true, resolveProject: id => id === 'github' ? { id, provider: 'github', host: 'github.com', project: 'acme/widgets' } : undefined,
    allowedActors: () => ['alice'], safeState: () => ({ health: { runtime: 'ready' }, open_tickets: 0 }),
    resolveModel: async () => ({ provider: 'codex-custom', model: 'gpt-6.1-sol', invoke }),
    deliverReport: vi.fn(async () => ({ masterSessionId: 'main-session-from-host' })),
    waitForSuperagent: async (_scenarioId, signal) => { signal.throwIfAborted(); const sequence = inputs.length
      if (!outputs.some(output => output.sequence === sequence)) outputs.push({ id: `reply-${outputs.length + 1}`, kind: 'reply', sequence,
        text: '我已只读检查仓库并整理依据。', at: new Date().toISOString() }) },
    probeReadOnly: async probe_id => ({ probe_id, status: 200, body: '{"ready":true}', json: true }),
    lifetime: new AbortController().signal, stateDir: directory }
}

async function waitTerminal(runs: ReporterAutonomousRuns, id: string) {
  for (let i = 0; i < 100; i++) {
    const current = runs.get(id)!
    if (current.status !== 'running' && current.report_delivery.status !== 'pending') return current
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('Reporter run did not settle')
}
async function waitRunStopped(runs: ReporterAutonomousRuns, id: string) {
  for (let i = 0; i < 100; i++) {
    const current = runs.get(id)!
    if (current.status !== 'running') return current
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('Reporter run did not stop')
}

it('keeps simulation active across multiple inactivity windows while the target reports real state progress', async () => {
  vi.useFakeTimers()
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  let simulatorCalls = 0
  const invoke: ReporterModelInvoker = vi.fn(async (input: ReporterModelRequest): Promise<ReporterModelResponse> => {
    if (input.role === 'autonomous-explorer') return { output: { kind: 'simulation', hypothesis: '验证真实目标反馈等待',
      goal: '只读检查登录入口并说明依据', persona: '仓库维护者，等待逐步检查结果。' }, usage }
    if (input.role === 'user-simulator') {
      simulatorCalls++
      if (simulatorCalls === 3) return { output: { kind: 'finished', summary: '已观察两轮真实目标回复。' }, usage }
      await new Promise<void>(resolve => {
        let ticks = 0
        const timer = setInterval(() => {
          input.onProgress?.()
          if (++ticks === 2) { clearInterval(timer); resolve() }
        }, 90_000)
      })
      return { output: { kind: 'action', actor_id: 'alice', action: { kind: 'message', ...(simulatorCalls === 1 ? { addressed: 'mention' as const } : {}),
        text: simulatorCalls === 1 ? '请只读检查登录入口并说明依据。' : '请补充刚才的具体依据。' } }, usage }
    }
    return { output: { summary: '两轮目标回复均已记录。', findings: [] }, usage }
  })
  const host = fakeHost(directory, invoke)
  const completeTarget = host.waitForSuperagent
  let waits = 0
  host.waitForSuperagent = async (_scenarioId, signal, onProgress) => {
    if (++waits <= 2) {
      await new Promise<void>((resolve, reject) => {
        let ticks = 0
        const timer = setInterval(() => {
          signal.throwIfAborted()
          onProgress?.()
          if (++ticks === 2) { clearInterval(timer); resolve() }
        }, 90_000)
        signal.addEventListener('abort', () => { clearInterval(timer); reject(signal.reason) }, { once: true })
      })
    }
    await completeTarget(_scenarioId, signal)
  }
  const runs = new ReporterAutonomousRuns(host)
  const initial = await runs.start(request({ budget: { max_model_calls: 8, max_actions: 4, max_experiments: 1, max_total_tokens: 20_000, timeout_ms: 120_000 } }))
  await vi.advanceTimersByTimeAsync(750_000)
  const terminal = runs.get(initial.id)!

  expect(Date.now() - Date.parse(initial.started_at)).toBeGreaterThan(600_000)
  expect(terminal).toMatchObject({ status: 'completed', turns: 2, progress: { kind: 'model_call' } })
  expect(simulatorCalls).toBe(3)
  expect(waits).toBe(3)
})

it('marks a silent autonomous run without cancelling it and keeps explicit cancellation distinct', async () => {
  vi.useFakeTimers()
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  const stalledInvoke: ReporterModelInvoker = request => new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
  })
  const stalledHost = fakeHost(directory, stalledInvoke), stalledRuns = new ReporterAutonomousRuns(stalledHost)
  const stalled = await stalledRuns.start(request({ mode: 'real-service', permissions: { read_only_service: true },
    budget: { max_model_calls: 8, max_actions: 4, max_experiments: 1, max_total_tokens: 20_000, timeout_ms: 5_000 } }))
  await vi.advanceTimersByTimeAsync(5_000)
  expect(stalledRuns.get(stalled.id)).toMatchObject({ status: 'running', stalled: true, model_calls: 1, report_delivery: { status: 'pending' } })
  stalledRuns.cancel(stalled.id)
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(stalledRuns.get(stalled.id)).toMatchObject({ status: 'cancelled', report_delivery: { status: 'delivered' } })

  const ignoredAbortInvoke: ReporterModelInvoker = () => new Promise(() => {})
  const cancelHost = fakeHost(directory, ignoredAbortInvoke), cancelRuns = new ReporterAutonomousRuns(cancelHost)
  const cancelled = await cancelRuns.start(request({ idempotency_key: 'autonomous-cancel-now', mode: 'real-service', permissions: { read_only_service: true },
    budget: { max_model_calls: 8, max_actions: 4, max_experiments: 1, max_total_tokens: 20_000, timeout_ms: 5_000 } }))
  cancelRuns.cancel(cancelled.id)
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(cancelRuns.get(cancelled.id)).toMatchObject({ status: 'cancelled', report_delivery: { status: 'delivered' } })
})

it('clears the no-progress warning when a long model inference finally returns', async () => {
  vi.useFakeTimers()
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  let modelSignal: AbortSignal | undefined
  const invoke: ReporterModelInvoker = async request => {
    if (request.role === 'autonomous-explorer') {
      modelSignal = request.signal
      await new Promise(resolve => setTimeout(resolve, 12_000))
      return { output: { kind: 'real-service', hypothesis: '检查运行状态接口', probe_id: 'state' }, usage }
    }
    return { output: { summary: '运行状态接口返回正常。', findings: [] }, usage }
  }
  const runs = new ReporterAutonomousRuns(fakeHost(directory, invoke))
  const initial = await runs.start(request({ mode: 'real-service', permissions: { read_only_service: true },
    budget: { max_model_calls: 8, max_actions: 4, max_experiments: 1, max_total_tokens: 20_000, timeout_ms: 5_000 } }))

  await vi.advanceTimersByTimeAsync(5_000)
  expect(runs.get(initial.id)).toMatchObject({ status: 'running', stalled: true, model_calls: 1 })
  expect(modelSignal?.aborted).toBe(false)

  await vi.advanceTimersByTimeAsync(7_000)
  for (let i = 0; i < 100 && runs.get(initial.id)!.status === 'running'; i++) {
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
  }
  expect(runs.get(initial.id)).toMatchObject({ status: 'completed', stalled: false, model_calls: 2,
    report_delivery: { status: 'delivered' } })
  expect(modelSignal?.aborted).toBe(false)
})

it('autonomously selects a simulation, performs two actions with real feedback, reviews it and keeps completed idempotency', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  const requests: ReporterModelRequest[] = []
  const invoke = vi.fn(async (input: ReporterModelRequest): Promise<ReporterModelResponse> => {
    requests.push(input)
    const call = requests.filter(item => item.role === input.role).length
    const output = input.role === 'autonomous-explorer' ? { kind: 'simulation', hypothesis: '检查只读请求是否被正确接单',
      goal: '只读分析登录验证入口并给出证据，不修改代码', persona: '仓库维护者，希望了解登录验证入口和证据。' }
      : input.role === 'user-simulator' ? call === 3 ? { kind: 'finished', summary: '用户已经收到分析并追问了依据。' }
        : { kind: 'action', actor_id: 'alice', action: { kind: 'message', addressed: call === 1 ? 'mention' : undefined,
          text: call === 1 ? '请只读分析登录验证入口，并说明依据，不改文件。' : '请补充你刚才结论对应的证据。' } }
        : { summary: '两轮对话均有真实目标回复。', findings: [{ severity: 'info', text: '目标返回了分析依据。', evidence: ['trigger-1', 'reply-1'] }] }
    return { output, usage }
  })
  const host = fakeHost(directory, invoke), runs = new ReporterAutonomousRuns(host)
  const initial = await runs.start(request())
  const terminal = await waitTerminal(runs, initial.id)
  expect(terminal).toMatchObject({ status: 'completed', mode: 'simulation', experiments: 1, turns: 2, model_calls: 5,
    model: { provider: 'codex-custom', model: 'gpt-6.1-sol', reasoningEffort: 'medium' },
    model_usage: { prompt_tokens: 50, completion_tokens: 25, cost_usd: null, retries: null, completeness: 'partial' },
    report_delivery: { status: 'delivered', master_session_id: 'main-session-from-host' } })
  expect(terminal.scenario_ids).toEqual([`${initial.id}-e1`])
  expect(terminal.experiment_log[0]).toMatchObject({ kind: 'simulation', hypothesis: '检查只读请求是否被正确接单', evidence: expect.arrayContaining(['sequence:1:target_completed', 'sequence:2:target_completed']) })
  const firstSimulatorRequest = requests.find(item => item.role === 'user-simulator')
  expect(firstSimulatorRequest).toBeDefined()
  expect((firstSimulatorRequest!.input as { scenario: { visible: { instructions: string[] } } }).scenario.visible.instructions.join('\n'))
    .toContain('addressed: "mention"')
  expect(requests.find(item => item.role === 'user-simulator' && (item.input as { conversation: unknown[] }).conversation.length > 0)).toBeDefined()
  expect(JSON.stringify(requests.map(item => item.input))).not.toContain('oracle')
  expect(requests.find(item => item.role === 'qualitative-reviewer')?.input).not.toHaveProperty('oracle')
  expect(host.reporter.recordUsage).toHaveBeenCalledTimes(4)
  expect(host.deliverReport).toHaveBeenCalledOnce()
  const delivery = vi.mocked(host.deliverReport)
  const delivered = delivery.mock.calls[0]![0]
  expect(delivered).toMatchObject({ runId: initial.id, report: { run_id: initial.id, status: 'completed', findings: terminal.findings,
    experiments: [expect.objectContaining({ oracle_status: 'passed', public_transcript: expect.arrayContaining([
      expect.objectContaining({ role: 'actor', sequence: 1 }), expect.objectContaining({ role: 'superagent', sequence: 1 }),
    ]) })] } })
  expect(delivered.report.experiments[0]?.public_transcript?.map(message => message.role)).toEqual(['actor', 'superagent', 'actor', 'superagent'])
  expect(JSON.stringify(delivered.report)).not.toContain('assertion')

  const duplicate = await runs.start(request())
  expect(duplicate).toEqual(terminal)
  expect(invoke).toHaveBeenCalledTimes(5)
  await expect(runs.start(request({ goal: '使用同一个幂等键的不同请求' }))).rejects.toMatchObject({ code: 'idempotency_conflict' })

  const restored = new ReporterAutonomousRuns(fakeHost(directory, invoke))
  expect(restored.get(initial.id)).toEqual(terminal)
  expect(await restored.start(request())).toEqual(terminal)
  expect(invoke).toHaveBeenCalledTimes(5)
})

it('retries a persisted terminal pending report on restart without restarting the test run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  const invoke = vi.fn(async () => ({ output: { kind: 'finished', summary: '只读管理检查已结束。' }, usage }))
  const firstHost = fakeHost(directory, invoke)
  vi.mocked(firstHost.deliverReport).mockImplementation(() => new Promise(() => {}))
  const firstRuns = new ReporterAutonomousRuns(firstHost)
  const initial = await firstRuns.start(request({ mode: 'real-service', permissions: { read_only_service: true } }))
  const pending = await waitRunStopped(firstRuns, initial.id)
  expect(pending).toMatchObject({ status: 'incomplete', report_delivery: { status: 'pending' } })

  const recoveredHost = fakeHost(directory, invoke)
  const recoveredRuns = new ReporterAutonomousRuns(recoveredHost)
  await recoveredRuns.resumePendingDeliveries()
  expect(recoveredRuns.get(initial.id)).toMatchObject({ status: 'incomplete', report_delivery: { status: 'delivered', master_session_id: 'main-session-from-host' } })
  expect(recoveredHost.deliverReport).toHaveBeenCalledOnce()
  expect(vi.mocked(recoveredHost.deliverReport).mock.calls[0]?.[0]).toEqual(vi.mocked(firstHost.deliverReport).mock.calls[0]?.[0])
  expect(invoke).toHaveBeenCalledOnce()
})

it('reuses the frozen terminal report after scenario evidence changes during retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  const requests: ReporterModelRequest[] = []
  const invoke = vi.fn(async (input: ReporterModelRequest): Promise<ReporterModelResponse> => {
    requests.push(input)
    const simulatorCalls = requests.filter(item => item.role === 'user-simulator').length
    if (input.role === 'autonomous-explorer') return { output: { kind: 'simulation', hypothesis: '验证仿真轨迹可回传',
      goal: '只读检查并说明依据', persona: '仓库维护者，需要检查结果。' }, usage }
    if (input.role === 'user-simulator') return { output: simulatorCalls === 3 ? { kind: 'finished', summary: '已经收到目标回复。' }
      : { kind: 'action', actor_id: 'alice', action: { kind: 'message', ...(simulatorCalls === 1 ? { addressed: 'mention' as const } : {}),
        text: simulatorCalls === 1 ? '请只读检查登录入口并说明依据。' : '请补充刚才结论的证据。' } }, usage }
    return { output: { summary: '轨迹已审查。', findings: [] }, usage }
  })
  const host = fakeHost(directory, invoke)
  let scenarioPassed = true
  const scenario = host.reporter.scenario
  host.reporter.scenario = id => {
    const value = scenario(id)
    return value ? { ...value, oracle: { ...value.oracle, passed: scenarioPassed } } as never : undefined
  }
  vi.mocked(host.deliverReport).mockRejectedValueOnce(Object.assign(new Error('暂时不可用'), { code: 'report_delivery_unavailable' }))
  const runs = new ReporterAutonomousRuns(host)
  const initial = await runs.start(request())
  const failed = await waitTerminal(runs, initial.id)
  expect(failed.report_delivery).toMatchObject({ status: 'failed' })
  const originalCall = vi.mocked(host.deliverReport).mock.calls[0]![0]
  expect(originalCall.report.experiments[0]).toMatchObject({ oracle_status: 'passed', public_transcript: expect.any(Array) })

  scenarioPassed = false
  const retried = await runs.retryReport(initial.id)
  const retryCall = vi.mocked(host.deliverReport).mock.calls[1]![0]
  expect(retried.report_delivery).toMatchObject({ status: 'delivered' })
  expect(retryCall).toEqual(originalCall)
  expect(invoke).toHaveBeenCalledTimes(5)
})

it('retains failed report delivery and supports explicit idempotent retry without rerunning the Reporter', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  const invoke = vi.fn(async () => ({ output: { kind: 'finished', summary: '只读管理检查已结束。' }, usage }))
  const host = fakeHost(directory, invoke)
  vi.mocked(host.deliverReport).mockRejectedValueOnce(Object.assign(new Error('private details'), { code: 'report_delivery_flush_failed' }))
  const runs = new ReporterAutonomousRuns(host)
  const initial = await runs.start(request({ mode: 'real-service', permissions: { read_only_service: true } }))
  const failed = await waitTerminal(runs, initial.id)

  expect(failed).toMatchObject({ status: 'incomplete', report_delivery: { status: 'failed', error_code: 'report_delivery_flush_failed' } })
  expect(JSON.stringify(failed.report_delivery)).not.toContain('private details')
  expect(host.deliverReport).toHaveBeenCalledOnce()
  const retried = await runs.retryReport(initial.id)
  expect(retried).toMatchObject({ report_delivery: { status: 'delivered', master_session_id: 'main-session-from-host' } })
  expect(await runs.retryReport(initial.id)).toEqual(retried)
  expect(host.deliverReport).toHaveBeenCalledTimes(2)
  expect(invoke).toHaveBeenCalledOnce()
  expect(vi.mocked(host.deliverReport).mock.calls.map(([input]) => input.runId)).toEqual([initial.id, initial.id])
})

it('persists safe Simulator schema paths when the model output is invalid', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  const invoke = vi.fn(async (input: ReporterModelRequest): Promise<ReporterModelResponse> => input.role === 'autonomous-explorer'
    ? { output: { kind: 'simulation', hypothesis: '检查用户请求处理', goal: '只读分析入口并说明依据', persona: '仓库维护者' }, usage }
    : input.role === 'user-simulator' ? { output: { kind: 'action', actor_id: 'alice', action: { kind: 'message', text: 'PRIVATE ACTION BODY', addressed: 'not-an-address' },
      credential: 'PRIVATE CREDENTIAL' }, usage }
      : { output: { summary: '审查完成。', findings: [] }, usage })
  const host = fakeHost(directory, invoke), submit = vi.spyOn(host.reporter, 'submit')
  const runs = new ReporterAutonomousRuns(host)
  const initial = await runs.start(request())
  const terminal = await waitTerminal(runs, initial.id)

  expect(terminal).toMatchObject({ status: 'incomplete', error_code: 'invalid_simulator_output', turns: 0 })
  const evidence = JSON.stringify(terminal.findings)
  expect(evidence).toContain('schema:action.addressed:invalid_value')
  expect(evidence).toContain('schema:$:unrecognized_keys')
  expect(evidence).not.toMatch(/PRIVATE ACTION BODY|not-an-address|PRIVATE CREDENTIAL/)
  expect(submit).not.toHaveBeenCalled()
})

it('shows the explorer only capabilities allowed by the selected mode', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  const requests: ReporterModelRequest[] = []
  const invoke = vi.fn(async (input: ReporterModelRequest): Promise<ReporterModelResponse> => {
    requests.push(input)
    return { output: input.role === 'autonomous-explorer'
      ? { kind: 'real-service', hypothesis: '检查管理概览是否可读', probe_id: 'overview' }
      : { summary: '管理概览可读。', findings: [] }, usage }
  })
  const host = fakeHost(directory, invoke)
  const runs = new ReporterAutonomousRuns(host)
  const initial = await runs.start(request({ mode: 'real-service', permissions: { simulation: true, read_only_service: true, browser: true } }))
  const terminal = await waitTerminal(runs, initial.id)
  const explorer = requests.find(item => item.role === 'autonomous-explorer')

  expect(terminal.status).toBe('completed')
  expect(explorer).toMatchObject({ input: { permissions: { simulation: false, read_only_service: true, browser: false },
    available_read_only_probes: ['state', 'overview', 'sources', 'tickets', 'threads', 'decisions'],
    can_simulate_users: false, can_test_browser: false } })
})

it('keeps a failed authorization oracle as a candidate and marks the run incomplete', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  let simulatorCalls = 0
  const invoke = vi.fn(async (input: ReporterModelRequest): Promise<ReporterModelResponse> => {
    if (input.role === 'autonomous-explorer') return { output: { kind: 'simulation', hypothesis: '验证授权请求是否被接单',
      goal: '只读分析入口并提供证据', persona: '仓库维护者，希望了解登录验证入口。' }, usage }
    if (input.role === 'user-simulator') {
      simulatorCalls++
      if (simulatorCalls === 3) return { output: { kind: 'finished', summary: '收到目标回复和追问结果。' }, usage }
      return { output: { kind: 'action', actor_id: 'alice', action: { kind: 'message',
        ...(simulatorCalls === 1 ? { addressed: 'mention' as const } : {}),
        text: simulatorCalls === 1 ? '请只读分析登录验证入口并提供证据。' : '请补充你刚才结论的依据。' } }, usage }
    }
    return { output: { summary: '根据公开轨迹完成独立审查。', findings: [] }, usage }
  })
  const host = fakeHost(directory, invoke)
  const completeScenario = host.reporter.completeScenario
  host.reporter.completeScenario = id => {
    const report = completeScenario(id)
    const checks = report.oracle.checks.map(check => check.assertion.kind === 'decision'
      ? { ...check, passed: false }
      : check)
    const failed = { ...report, behavioral_pass: false, oracle: { ...report.oracle, passed: false, checks } }
    host.reporter.scenario = scenarioId => scenarioId === id ? failed : host.reporter.scenario(scenarioId)
    return failed
  }
  const runs = new ReporterAutonomousRuns(host)
  const initial = await runs.start(request())
  const terminal = await waitTerminal(runs, initial.id)

  expect(terminal).toMatchObject({ status: 'incomplete', error_code: 'oracle_failed', turns: 2 })
  expect(terminal.findings).toContainEqual(expect.objectContaining({ status: 'candidate', title: '明确授权请求未得到预期接单决定' }))
  expect(terminal.findings?.some(item => item.status === 'invalid-test' && item.title === '明确授权请求未得到预期接单决定')).toBe(false)
  expect(terminal.model_calls).toBeGreaterThan(3)
  expect(JSON.stringify(terminal.findings)).not.toContain('assertion')
  const delivered = vi.mocked(host.deliverReport).mock.calls[0]![0].report
  expect(delivered.experiments[0]).toMatchObject({ oracle_status: 'failed' })
  expect(JSON.stringify(delivered)).not.toContain('assertion')
})

it('keeps a Reporter model transport failure as a candidate diagnostic', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  const failure = Object.assign(new Error('provider unavailable'), { code: 'reporter_model_failed' })
  const invoke = vi.fn(async (): Promise<ReporterModelResponse> => { throw failure })
  const host = fakeHost(directory, invoke), runs = new ReporterAutonomousRuns(host)
  const initial = await runs.start(request({ mode: 'real-service', permissions: { read_only_service: true } }))
  const terminal = await waitTerminal(runs, initial.id)

  expect(terminal).toMatchObject({ status: 'failed', error_code: 'reporter_model_failed' })
  expect(terminal.findings).toContainEqual(expect.objectContaining({ status: 'candidate', evidence: ['reporter_model_failed'] }))
  expect(terminal.findings?.some(item => item.status === 'invalid-test')).toBe(false)
})

it('keeps a browser runtime failure as a candidate diagnostic', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  const invoke = vi.fn(async (): Promise<ReporterModelResponse> => ({ output: { kind: 'browser', hypothesis: '检查概览页交互' }, usage }))
  const host = fakeHost(directory, invoke)
  host.browser = { create: async () => { throw new ReporterBrowserError('browser_unavailable') } }
  const runs = new ReporterAutonomousRuns(host)
  const initial = await runs.start(request({ mode: 'browser', permissions: { browser: true } }))
  const terminal = await waitTerminal(runs, initial.id)

  expect(terminal).toMatchObject({ status: 'failed', error_code: 'browser_unavailable' })
  expect(terminal.findings).toContainEqual(expect.objectContaining({ status: 'candidate', evidence: ['browser_unavailable'] }))
  expect(terminal.findings?.some(item => item.status === 'invalid-test')).toBe(false)
})

it('keeps a target Agent failure as a candidate instead of blaming the simulated test input', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  const invoke = vi.fn(async (input: ReporterModelRequest): Promise<ReporterModelResponse> => input.role === 'autonomous-explorer'
    ? { output: { kind: 'simulation', hypothesis: '检查目标回复', goal: '只读分析入口并提供依据', persona: '仓库维护者' }, usage }
    : { output: { kind: 'action', actor_id: 'alice', action: { kind: 'message', addressed: 'mention', text: '请只读分析入口并提供依据。' } }, usage })
  const host = fakeHost(directory, invoke)
  host.waitForSuperagent = async () => { throw Object.assign(new Error('target failed'), { code: 'target_agent_error' }) }
  const runs = new ReporterAutonomousRuns(host)
  const initial = await runs.start(request())
  const terminal = await waitTerminal(runs, initial.id)

  expect(terminal).toMatchObject({ status: 'incomplete', error_code: 'target_agent_error', turns: 1 })
  expect(terminal.findings).toContainEqual(expect.objectContaining({ status: 'candidate', evidence: expect.arrayContaining(['target_agent_error']) }))
  expect(terminal.findings?.some(item => item.status === 'invalid-test')).toBe(false)
})

it('stops before submitting an action when native model usage is missing and persists unknown cost/tokens', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  const invoke = vi.fn(async (input: ReporterModelRequest) => input.role === 'autonomous-explorer'
    ? { output: { kind: 'simulation', hypothesis: '检查接单', goal: '只读分析入口', persona: '维护者' }, usage }
    : { output: { kind: 'action', actor_id: 'alice', action: { kind: 'message', addressed: 'mention', text: '请只读分析入口。' } } })
  const host = fakeHost(directory, invoke), submit = vi.spyOn(host.reporter, 'submit'), runs = new ReporterAutonomousRuns(host)
  const initial = await runs.start(request())
  const terminal = await waitTerminal(runs, initial.id)
  expect(terminal).toMatchObject({ status: 'incomplete', error_code: 'usage_unknown', turns: 0,
    model_usage: { prompt_tokens: null, completion_tokens: null, cost_usd: null, completeness: 'unknown' } })
  expect(submit).not.toHaveBeenCalled()
  expect(invoke).toHaveBeenCalledTimes(2)
})

it('persists a running run as incomplete after restart and does not resume paid calls', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  let neverComplete!: (value: { output: unknown; usage: unknown }) => void
  const invoke = vi.fn(() => new Promise<{ output: unknown; usage: unknown }>(resolve => { neverComplete = resolve }))
  const host = fakeHost(directory, invoke as never), runs = new ReporterAutonomousRuns(host)
  const initial = await runs.start(request({ mode: 'real-service', permissions: { read_only_service: true } }))
  for (let i = 0; i < 100 && runs.get(initial.id)?.model_calls === 0; i++) await new Promise(resolve => setTimeout(resolve, 0))
  expect(runs.get(initial.id)?.status).toBe('running')
  const restored = new ReporterAutonomousRuns(fakeHost(directory, invoke as never))
  expect(restored.get(initial.id)).toMatchObject({ status: 'incomplete', error_code: 'runtime_restarted' })
  expect(await restored.start(request({ mode: 'real-service', permissions: { read_only_service: true } }))).toMatchObject({ status: 'incomplete' })
  expect(invoke).toHaveBeenCalledTimes(1)
  runs.cancel(initial.id)
  neverComplete?.({ output: { kind: 'finished', summary: 'late' }, usage })
})

it('coalesces concurrent identical starts while the medium model route is resolving', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  const invoke = vi.fn(async () => ({ output: { kind: 'finished', summary: '探测完成' }, usage }))
  const host = fakeHost(directory, invoke)
  let resolveRoute!: (route: { provider: string; model: string; invoke: ReporterAutonomousHost['resolveModel'] extends () => Promise<infer T> ? T extends { invoke: infer I } ? I : never : never }) => void
  const route = new Promise<Awaited<ReturnType<ReporterAutonomousHost['resolveModel']>>>(resolve => { resolveRoute = resolve })
  const resolver = vi.fn(() => route)
  host.resolveModel = resolver
  const runs = new ReporterAutonomousRuns(host)
  const first = runs.start(request({ mode: 'real-service', permissions: { read_only_service: true } }))
  const same = runs.start(request({ mode: 'real-service', permissions: { read_only_service: true } }))
  await expect(runs.start(request({ mode: 'real-service', permissions: { read_only_service: true }, goal: '不同目标' })))
    .rejects.toMatchObject({ code: 'idempotency_conflict' })
  expect(resolver).toHaveBeenCalledOnce()
  resolveRoute({ provider: 'codex-custom', model: 'gpt-6.1-sol', invoke })
  const [a, b] = await Promise.all([first, same])
  expect(a.id).toBe(b.id)
  expect(a.id).toMatch(/^auto-[a-f0-9]{32}$/)
})

it('confirms a service failure only after the same read-only request repeats it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  const invoke = vi.fn(async () => ({ output: { kind: 'real-service', hypothesis: '检查管理 API 是否可读', probe_id: 'state' }, usage }))
  const host = fakeHost(directory, invoke)
  host.probeReadOnly = vi.fn(async probe_id => ({ probe_id, status: 503, body: '{"error":"unavailable"}', json: true }))
  const runs = new ReporterAutonomousRuns(host)
  const initial = await runs.start(request({ mode: 'real-service', permissions: { read_only_service: true } }))
  const terminal = await waitTerminal(runs, initial.id)
  expect(host.probeReadOnly).toHaveBeenCalledTimes(2)
  expect(terminal.findings).toContainEqual(expect.objectContaining({ status: 'confirmed', title: '只读管理接口重复返回服务端错误' }))
  expect(terminal.experiment_log[0]?.evidence).toContain('重复 GET HTTP 503')
})

it('accumulates reported model retries and keeps missing retry counts unknown', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  const invoke = vi.fn(async (input: ReporterModelRequest): Promise<ReporterModelResponse> => ({ output: input.role === 'autonomous-explorer'
    ? { kind: 'real-service', hypothesis: '检查管理概览是否可读', probe_id: 'overview' }
    : { summary: '管理概览可读。', findings: [] }, usage: { ...usage, retries: 2 } }))
  const host = fakeHost(directory, invoke)
  const runs = new ReporterAutonomousRuns(host)
  const initial = await runs.start(request({ mode: 'real-service', permissions: { read_only_service: true } }))
  const terminal = await waitTerminal(runs, initial.id)
  expect(terminal).toMatchObject({ status: 'completed', model_calls: 2, model_usage: { retries: 4 } })

  const missingDirectory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(missingDirectory)
  const missingInvoke = vi.fn(async (input: ReporterModelRequest): Promise<ReporterModelResponse> => ({ output: input.role === 'autonomous-explorer'
    ? { kind: 'real-service', hypothesis: '检查管理概览是否可读', probe_id: 'overview' }
    : { summary: '管理概览可读。', findings: [] }, usage }))
  const missingHost = fakeHost(missingDirectory, missingInvoke)
  const missingRuns = new ReporterAutonomousRuns(missingHost)
  const missingInitial = await missingRuns.start(request({ idempotency_key: 'missing-retries', mode: 'real-service', permissions: { read_only_service: true } }))
  expect(await waitTerminal(missingRuns, missingInitial.id)).toMatchObject({ model_usage: { retries: null } })
})

it('recovers from an ambiguous browser action by exposing its stable error and fresh snapshot to the next model turn', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  const observation: ReporterBrowserObservation = { path: '/settings', title: '设置', accessibility_snapshot: 'tab "来源"; button "刷新"',
    snapshot_truncated: false, page_errors: 0, console_errors: 0, blocked_requests: [], blocked_console_errors: 0 }
  const actionInputs: unknown[] = [], requests: ReporterModelRequest[] = []
  const invoke = vi.fn(async (input: ReporterModelRequest): Promise<ReporterModelResponse> => {
    requests.push(input)
    if (input.role === 'browser-tester') {
      actionInputs.push(input.input)
      const call = actionInputs.length
      if (call === 1) return { output: { kind: 'act', action: { kind: 'click', role: 'button', name: '来源' } }, usage }
      if (call === 2) return { output: { kind: 'act', action: { kind: 'snapshot' } }, usage }
      if (call === 3) return { output: { kind: 'act', action: { kind: 'click', role: 'button', name: '刷新' } }, usage }
      return { output: { kind: 'finished', summary: '检查了来源页可见状态。' }, usage }
    }
    if (input.role === 'qualitative-reviewer') return { output: { summary: '只读观察完成。', findings: [] }, usage }
    return { output: { kind: 'browser', hypothesis: '检查设置页导航与可访问名称' }, usage }
  })
  const host = fakeHost(directory, invoke)
  const driver = { observe: vi.fn(async () => observation), act: vi.fn(async () => { if (driver.act.mock.calls.length === 1) throw new ReporterBrowserError('browser_action_not_unique')
    return { result: 'completed' as const, observation } }), close: vi.fn(async () => {}) } satisfies ReporterBrowserDriver
  host.browser = { create: async () => driver }
  const runs = new ReporterAutonomousRuns(host)
  const initial = await runs.start(request({ mode: 'browser', permissions: { browser: true } }))
  const terminal = await waitTerminal(runs, initial.id)
  expect(terminal).toMatchObject({ status: 'completed', mode: 'browser', turns: 3, model_calls: 6,
    experiment_log: [{ kind: 'browser', hypothesis: '检查设置页导航与可访问名称', browser_steps: [
      { index: 1, action: 'initial-observation', result: 'observed', page: { path: '/settings', title: '设置' }, snapshot: 'tab "来源"; button "刷新"' },
      { index: 2, action: { kind: 'click', role: 'button', name: '来源' }, result: 'failed', error_code: 'browser_action_not_unique' },
      { index: 3, action: { kind: 'snapshot' }, result: 'observed' },
      { index: 4, action: { kind: 'click', role: 'button', name: '刷新' }, result: 'completed' },
    ] }] })
  expect(terminal.experiment_log[0]?.observation).not.toContain('accessibility_snapshot')
  expect(terminal.experiment_log[0]?.observation.startsWith('{')).toBe(false)
  expect(JSON.stringify(actionInputs[1])).toContain('browser_action_not_unique')
  expect(JSON.stringify(actionInputs[1])).toContain('刷新')
  const reviewer = requests.find(item => item.role === 'qualitative-reviewer')?.input as { experiments: { browser_steps?: unknown[] }[] } | undefined
  expect(reviewer?.experiments[0]?.browser_steps).toHaveLength(4)
  expect(JSON.stringify(reviewer?.experiments[0]?.browser_steps)).not.toContain('auth')
  expect(driver.close).toHaveBeenCalledOnce()
})

it('keeps the initial page evidence but does not complete browser testing without a successful control action', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  const observation: ReporterBrowserObservation = { path: '/overview', title: '概览', accessibility_snapshot: 'heading "概览"; link "工单"',
    snapshot_truncated: false, page_errors: 0, console_errors: 0, blocked_requests: [], blocked_console_errors: 0 }
  const invoke = vi.fn(async (input: ReporterModelRequest): Promise<ReporterModelResponse> => input.role === 'browser-tester'
    ? { output: { kind: 'finished', summary: '已观察概览页面。' }, usage }
    : input.role === 'qualitative-reviewer' ? { output: { summary: '目前只有初始页面观察。', findings: [] }, usage }
      : { output: { kind: 'browser', hypothesis: '检查概览页面是否可交互' }, usage })
  const host = fakeHost(directory, invoke)
  const driver: ReporterBrowserDriver = { observe: vi.fn(async () => observation), act: vi.fn(async () => ({ result: 'completed' as const, observation })), close: vi.fn(async () => {}) }
  host.browser = { create: async () => driver }
  const runs = new ReporterAutonomousRuns(host)
  const initial = await runs.start(request({ mode: 'browser', permissions: { browser: true } }))
  const terminal = await waitTerminal(runs, initial.id)

  expect(terminal).toMatchObject({ status: 'incomplete', error_code: 'browser_no_action', turns: 0 })
  expect(terminal.experiment_log[0]?.browser_steps).toMatchObject([{ action: 'initial-observation', result: 'observed',
    page: { path: '/overview', title: '概览' }, snapshot: 'heading "概览"; link "工单"' }])
  expect(terminal.experiment_log[0]?.observation).not.toContain('{"path"')
  expect(terminal.findings).toContainEqual(expect.objectContaining({ status: 'invalid-test', title: '浏览器探索没有执行成功的控件操作' }))
  expect(driver.act).not.toHaveBeenCalled()
  expect(driver.close).toHaveBeenCalledOnce()
})

it.each([
  { name: 'unknown usage', modelUsage: undefined, budget: 20_000, expected: { error_code: 'usage_unknown', prompt_tokens: null, completion_tokens: null } },
  { name: 'known token overage', modelUsage: { ...usage, prompt_tokens: 80, completion_tokens: 30 }, budget: 100,
    expected: { error_code: 'token_budget_exceeded', prompt_tokens: 90, completion_tokens: 35 } },
])('does not execute browser controls after $name', async ({ modelUsage, budget, expected }) => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  const observation: ReporterBrowserObservation = { path: '/tickets', title: '工单', accessibility_snapshot: 'button "工单"',
    snapshot_truncated: false, page_errors: 0, console_errors: 0, blocked_requests: [], blocked_console_errors: 0 }
  const invoke = vi.fn(async (input: ReporterModelRequest): Promise<ReporterModelResponse> => input.role === 'autonomous-explorer'
    ? { output: { kind: 'browser', hypothesis: '检查工单列表控件' }, usage }
    : { output: { kind: 'act', action: { kind: 'click', role: 'button', name: '工单' } }, usage: modelUsage })
  const host = fakeHost(directory, invoke)
  const driver: ReporterBrowserDriver = { observe: vi.fn(async () => observation), act: vi.fn(async () => ({ result: 'completed' as const, observation })), close: vi.fn(async () => {}) }
  host.browser = { create: async () => driver }
  const runs = new ReporterAutonomousRuns(host)
  const initial = await runs.start(request({ mode: 'browser', permissions: { browser: true }, budget: { max_model_calls: 8, max_actions: 3,
    max_experiments: 1, max_total_tokens: budget, timeout_ms: 30_000 } }))
  const terminal = await waitTerminal(runs, initial.id)

  expect(terminal).toMatchObject({ status: 'incomplete', error_code: expected.error_code, turns: 0,
    model_calls: 2, model_usage: { prompt_tokens: expected.prompt_tokens, completion_tokens: expected.completion_tokens } })
  expect(driver.act).not.toHaveBeenCalled()
  expect(terminal.experiment_log[0]?.browser_steps).toMatchObject([{ action: 'initial-observation', page: { title: '工单' }, snapshot: 'button "工单"' }])
})

it('marks an unfinished browser exploration incomplete when its action budget is exhausted', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  const observation: ReporterBrowserObservation = { path: '/settings', title: '设置', accessibility_snapshot: 'button "刷新"', snapshot_truncated: false,
    page_errors: 0, console_errors: 0, blocked_requests: [], blocked_console_errors: 0 }
  const invoke = vi.fn(async (input: ReporterModelRequest): Promise<ReporterModelResponse> => input.role === 'browser-tester'
    ? { output: { kind: 'act', action: { kind: 'click', role: 'button', name: '刷新' } }, usage }
    : input.role === 'qualitative-reviewer' ? { output: { summary: '只读动作已到上限。', findings: [] }, usage }
      : { output: { kind: 'browser', hypothesis: '检查刷新行为' }, usage })
  const host = fakeHost(directory, invoke)
  const driver: ReporterBrowserDriver = { observe: async () => observation, act: async () => ({ result: 'completed', observation }), close: async () => {} }
  host.browser = { create: async () => driver }
  const runs = new ReporterAutonomousRuns(host)
  const initial = await runs.start(request({ mode: 'browser', permissions: { browser: true }, budget: { max_model_calls: 8, max_actions: 2,
    max_experiments: 1, max_total_tokens: 20_000, timeout_ms: 30_000 } }))
  const terminal = await waitTerminal(runs, initial.id)
  expect(terminal).toMatchObject({ status: 'incomplete', error_code: 'browser_action_budget', turns: 2 })
  expect(terminal.experiment_log[0]?.browser_steps?.filter(step => step.action !== 'initial-observation' && step.action.kind === 'click'
    && step.result === 'completed')).toHaveLength(2)
})

it('retains known over-budget token usage and refuses the generated simulation action', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reporter-autonomous-')); directories.push(directory)
  const submit = vi.fn()
  const invoke = vi.fn(async (input: ReporterModelRequest): Promise<ReporterModelResponse> => ({ output: { kind: 'simulation', hypothesis: '检查接单',
    goal: '只读分析入口', persona: '维护者' }, usage: { ...usage, prompt_tokens: 80, completion_tokens: 30 } }))
  const host = fakeHost(directory, invoke)
  const original = host.reporter.submit
  host.reporter.submit = ((...args: Parameters<typeof original>) => { submit(); return original(...args) }) as typeof original
  const runs = new ReporterAutonomousRuns(host)
  const initial = await runs.start(request({ budget: { max_model_calls: 8, max_actions: 4, max_experiments: 1, max_total_tokens: 100, timeout_ms: 30_000 } }))
  const terminal = await waitTerminal(runs, initial.id)
  expect(terminal).toMatchObject({ status: 'incomplete', error_code: 'token_budget_exceeded', turns: 0,
    model_usage: { prompt_tokens: 80, completion_tokens: 30, completeness: 'partial' } })
  expect(submit).not.toHaveBeenCalled()
  expect(invoke).toHaveBeenCalledOnce()
})
