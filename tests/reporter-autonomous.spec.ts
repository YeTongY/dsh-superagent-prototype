import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { ReporterAutonomousRunError, ReporterAutonomousRuns, type ReporterAutonomousHost, type ReporterAutonomousRunRecord } from '../src/reporter/autonomous.ts'

function harness() {
  const saved = new Map<string, ReporterAutonomousRunRecord>()
  const store = {
    get: (key: string) => saved.get(key),
    set: (key: string, value: ReporterAutonomousRunRecord) => { saved.set(key, structuredClone(value)) },
    keys: (family: { prefix: string }) => [...saved.keys()].filter(key => key.startsWith(family.prefix)),
    atomic: <T>(run: () => T) => run(),
  } as unknown as ReporterAutonomousHost['store']
  const scenario = { id: '', version: 1, project_source_id: 'github', thread_id: '', thread_kind: 'conversation',
    visible: { persona: 'tester', goal: 'test', instructions: [] }, actors: [{ id: 'alice', role: 'person' }], oracle: { assertions: [] } }
  const reporter = {
    registerScenario: vi.fn((input: typeof scenario) => input),
    simulatorFeedback: vi.fn(() => ({ scenario, last_sequence: 0, conversation: [] })),
    submit: vi.fn(() => ({ disposition: 'stored', duplicate: false, trigger_id: 'trigger-1' })),
    completeScenario: vi.fn(),
    scenario: vi.fn(),
  } as unknown as ReporterAutonomousHost['reporter']
  const sessionStates = new Map<string, 'running' | 'idle' | 'missing'>()
  const host: ReporterAutonomousHost = {
    store, reporter, enabled: true, stateDir: '/state',
    resolveProject: id => id === 'github' ? { id, provider: 'github', host: 'github.com', project: 'acme/widgets' } : undefined,
    allowedActors: () => ['alice'],
    resolveTicket: id => id === 'ticket-1' ? { id, projectSourceId: 'github', directory: '/work/ticket-1' }
      : id === 'ended-ticket' ? { id, projectSourceId: 'github', directory: '/work/ended' } : undefined,
    ensureSession: vi.fn(async () => ({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })),
    promptSession: vi.fn(async () => {}),
    cancelSession: vi.fn(async sessionId => { sessionStates.set(sessionId, 'idle') }),
    sessionStatus: sessionId => sessionStates.get(sessionId) ?? 'idle',
    relay: vi.fn(), lifetime: new AbortController().signal,
  }
  return { host, saved, sessionStates, reporter }
}

const request = (overrides: Record<string, unknown> = {}) => ({ idempotency_key: 'test-run-1', goal: '确认产品行为',
  project_source_id: 'github', mode: 'simulation', permissions: { simulation: true }, ...overrides })

describe('Reporter DSH Session projection', () => {
  let h: ReturnType<typeof harness>
  beforeEach(() => { h = harness() })

  it('creates one native DSH Session, preserves its identity on retry, and uses the worker workspace when bound', async () => {
    const runs = new ReporterAutonomousRuns(h.host)
    const first = await runs.start(request({ ticket_id: 'ticket-1' }))
    expect(first).toMatchObject({ session_id: `reporter-${first.id}`, status: 'waiting', model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } })
    expect(h.host.ensureSession).toHaveBeenCalledWith(first.session_id, '/work/ticket-1', expect.stringContaining('Reporter：'))
    expect(h.host.promptSession).toHaveBeenCalledWith(first.session_id, `reporter-start:${first.id}`, expect.stringContaining('自由文本完整报告'), 'queue')
    const initialPrompt = vi.mocked(h.host.promptSession).mock.calls[0]![2]
    expect(initialPrompt).toContain('先用 DSH 原生只读文件工具检查项目入口')
    expect(initialPrompt).toContain('在完整报告中列出实际查看的文件')
    expect(initialPrompt).toContain('真实用户可观察行为')
    expect(runs.contextForSession(first.session_id)).toMatchObject({ request: { ticket_id: 'ticket-1' }, scenario_id: expect.stringMatching(/^scenario-/) })

    const retried = await runs.start(request({ ticket_id: 'ticket-1' }))
    expect(retried.id).toBe(first.id)
    expect(h.host.ensureSession).toHaveBeenCalledTimes(1)
    expect(h.host.promptSession).toHaveBeenCalledTimes(1)
    await expect(runs.start(request({ goal: 'different goal' }))).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('rejects an unknown project, missing simulation actor, and a ticket from another project', async () => {
    const runs = new ReporterAutonomousRuns(h.host)
    await expect(runs.start(request({ project_source_id: 'unknown' }))).rejects.toMatchObject({ code: 'project_not_found' })
    const noActors = new ReporterAutonomousRuns({ ...h.host, allowedActors: () => [] })
    await expect(noActors.start(request())).rejects.toMatchObject({ code: 'no_allowed_actor' })
    const wrongProject = new ReporterAutonomousRuns({ ...h.host, resolveTicket: id => ({ id, projectSourceId: 'other', directory: '/work/other' }) })
    await expect(wrongProject.start(request({ ticket_id: 'ticket-2' }))).rejects.toMatchObject({ code: 'ticket_project_mismatch' })
    const completedTicket = new ReporterAutonomousRuns(h.host)
    const run = await completedTicket.start(request({ ticket_id: 'ended-ticket' }))
    expect(h.host.ensureSession).toHaveBeenLastCalledWith(run.session_id, '/work/ended', expect.stringContaining('Reporter：'))
  })

  it('delivers candidate and free-text report through the existing ordered relay and stores both page fields', async () => {
    const runs = new ReporterAutonomousRuns(h.host)
    const started = await runs.start(request())
    const context = runs.contextForSession(started.session_id)!
    runs.candidate(started.session_id, '候选：需要进一步确认')
    expect(h.host.relay).toHaveBeenLastCalledWith(expect.stringMatching(/^reporter-candidate:/), expect.stringContaining('不是用户消息'))

    const result = await runs.submitReport(started.session_id, '发现登录后页面返回异常。', '复现步骤：\n1. 使用测试账号登录。\n2. 打开设置页。')
    expect(result).toMatchObject({ status: 'completed', summary: '发现登录后页面返回异常。', full_report: expect.stringContaining('复现步骤') })
    expect(h.host.relay).toHaveBeenLastCalledWith(expect.stringMatching(/^reporter-report:/), expect.stringContaining('复现步骤'))
    expect(runs.contextForSession(started.session_id)).toMatchObject({ view: { summary: '发现登录后页面返回异常。' } })
    expect(context.request.idempotency_key).toBe('test-run-1')
    const reportRelayCount = vi.mocked(h.host.relay).mock.calls.length
    await expect(runs.submitReport(started.session_id, '不同摘要', '不同正文')).rejects.toMatchObject({ code: 'report_already_submitted' })
    expect(await runs.submitReport(started.session_id, '发现登录后页面返回异常。', '复现步骤：\n1. 使用测试账号登录。\n2. 打开设置页。'))
      .toMatchObject({ status: 'completed' })
    expect(vi.mocked(h.host.relay).mock.calls).toHaveLength(reportRelayCount)
    expect(() => runs.candidate(started.session_id, '完成后不能再追加候选')).toThrowError(ReporterAutonomousRunError)
    await expect(runs.reply(started.id, 'too-late', '完成后不能再追问')).rejects.toMatchObject({ code: 'reporter_session_ended' })
  })

  it('routes orchestrator replies to the same DSH Session with an idempotent delivery id', async () => {
    const runs = new ReporterAutonomousRuns(h.host)
    const started = await runs.start(request())
    await runs.reply(started.id, 'ask-for-evidence-1', '请确认是否只发生在 GitLab 项目。')
    const [sessionId, requestId, text, mode, authorize] = vi.mocked(h.host.promptSession).mock.lastCall!
    expect([sessionId, requestId, text, mode]).toEqual([started.session_id, `reporter-reply:${started.id}:ask-for-evidence-1`,
      expect.stringContaining('不是用户新授权'), 'queue'])
    expect(authorize).toEqual(expect.any(Function))
    expect(runs.get(started.id)?.status).toBe('waiting')
    await expect(runs.reply(started.id, 'bad id with spaces', '继续')).rejects.toMatchObject({ code: 'invalid_reply_id' })
  })

  it('does not mark silence as failure, but records actual DSH errors and explicit cancellation', async () => {
    const runs = new ReporterAutonomousRuns(h.host)
    const started = await runs.start(request())
    expect(runs.get(started.id)?.status).toBe('waiting')
    runs.sessionFailed(started.session_id, Object.assign(new Error('DSH model request failed'), { code: 'model_unavailable' }))
    expect(runs.get(started.id)).toMatchObject({ status: 'failed', error_code: 'model_unavailable' })
    expect(await runs.cancel(started.id)).toMatchObject({ status: 'failed', error_code: 'model_unavailable' })
    expect(h.host.cancelSession).not.toHaveBeenCalledWith(started.session_id)
    await expect(runs.reply(started.id, 'too-late', '失败后不应继续')).rejects.toMatchObject({ code: 'reporter_session_ended' })

    const second = await runs.start(request({ idempotency_key: 'test-run-2' }))
    const cancelled = await runs.cancel(second.id)
    expect(h.host.cancelSession).toHaveBeenCalledWith(second.session_id)
    expect(cancelled.status).toBe('cancelled')
  })

  it('does not project a model selection when native DSH initialization fails before selecting one', async () => {
    h.host.ensureSession = vi.fn(async () => { throw new Error('model route rejected the requested reasoning effort') })
    const runs = new ReporterAutonomousRuns(h.host)
    await expect(runs.start(request())).rejects.toMatchObject({ code: 'reporter_session_unavailable' })
    expect(runs.list()[0]).not.toHaveProperty('model')
  })

  it('removes the legacy placeholder model from restored run projections', async () => {
    const first = new ReporterAutonomousRuns(h.host)
    const run = await first.start(request())
    const key = KV.reporter.runs(run.id)
    const legacy = h.saved.get(key)!
    legacy.view.model = { provider: 'dsh-default', model: 'dsh-default', reasoningEffort: 'xhigh' }
    h.saved.set(key, legacy)

    const restored = new ReporterAutonomousRuns(h.host)

    expect(restored.get(run.id)).not.toHaveProperty('model')
    expect(h.saved.get(key)?.view).not.toHaveProperty('model')
    expect(restored.get(run.id)?.status).toBe('waiting')
  })

  it('preserves a report committed while native DSH cancellation is draining', async () => {
    let finishCancellation!: () => void
    let cancellationStarted!: () => void
    const draining = new Promise<void>(resolve => { finishCancellation = resolve })
    const started = new Promise<void>(resolve => { cancellationStarted = resolve })
    h.host.cancelSession = vi.fn(async () => { cancellationStarted(); await draining })
    const runs = new ReporterAutonomousRuns(h.host)
    const run = await runs.start(request())

    const cancelling = runs.cancel(run.id)
    await started
    await runs.submitReport(run.session_id, '摘要', '完整报告')
    finishCancellation()

    await expect(cancelling).resolves.toMatchObject({ status: 'completed', summary: '摘要', full_report: '完整报告' })
    expect(runs.get(run.id)).toMatchObject({ status: 'completed', summary: '摘要', full_report: '完整报告' })
  })

  it('does not deliver a delayed orchestrator reply after the Reporter was cancelled', async () => {
    let finishDelivery!: () => void
    let deliveryStarted!: () => void
    const delivering = new Promise<void>(resolve => { finishDelivery = resolve })
    const started = new Promise<void>(resolve => { deliveryStarted = resolve })
    const runs = new ReporterAutonomousRuns(h.host)
    const run = await runs.start(request())
    h.host.promptSession = vi.fn(async (_sessionId, _requestId, _text, _mode, authorize) => {
      deliveryStarted()
      await delivering
      authorize?.()
    })

    const replying = runs.reply(run.id, 'late-reply', '继续核查')
    await started
    await runs.cancel(run.id)
    finishDelivery()

    await expect(replying).rejects.toMatchObject({ code: 'reporter_session_ended' })
    expect(runs.get(run.id)?.status).toBe('cancelled')
  })

  it('restores the same run projection and does not restart completed sessions', async () => {
    const first = new ReporterAutonomousRuns(h.host)
    const active = await first.start(request())
    await first.submitReport(active.session_id, '摘要', '完整报告')
    const restoredHost = { ...h.host, ensureSession: vi.fn(async () => ({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })),
      promptSession: vi.fn(async () => {}) }
    const restored = new ReporterAutonomousRuns(restoredHost)
    await restored.resume()
    expect(restored.get(active.id)).toMatchObject({ status: 'completed', session_id: active.session_id, summary: '摘要', full_report: '完整报告' })
    expect(restoredHost.ensureSession).not.toHaveBeenCalled()
    expect(restoredHost.promptSession).not.toHaveBeenCalled()
    expect(h.saved.has(KV.reporter.runs(active.id))).toBe(true)
  })

  it('keeps report orchestration in the DSH Session projection', async () => {
    const runs = new ReporterAutonomousRuns(h.host)
    const started = await runs.start(request())
    expect(runs.contextForSession(started.session_id)).toMatchObject({
      view: { session_id: started.session_id }, request: { project_source_id: 'github' },
    })
    expect(h.host.ensureSession).toHaveBeenCalledWith(started.session_id, '/state', expect.stringContaining('Reporter：'))
  })
})
