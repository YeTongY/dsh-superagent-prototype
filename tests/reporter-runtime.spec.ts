/** 真实 Runtime/Engine 的本地 Reporter 闭环；不调用平台消息 API 或模型。 */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Commands } from '../src/infra/commands.ts'
import { projectSourceId } from '../src/project-source.ts'
import { gitlabKind } from '../src/sources/gitlab.ts'
import { feishu, github, startRuntime, type Host } from './fixtures/host.ts'
import { createRuntimeReporterBrowserFactory, reporterScreenshotAttacher } from '../src/app/runtime.ts'
import { reporterTools } from '../src/app/tools/reporter.ts'
import { inject as runtimeInject } from '../src/index.ts'
import { UserError, type Trigger } from '../src/core/index.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined; vi.unstubAllEnvs() })

it('attaches screenshots only for the Reporter Session’s exact DSH model route', async () => {
  const ctx = new Context()
  const image = { attachmentId: 'reporter-image', mediaType: 'image/png', bytes: 4, width: 1, height: 1 }
  const saveImage = vi.fn(async () => image)
  const resolveModelInfo = vi.fn(async (): Promise<{ inputModalities?: string[] }> => ({ inputModalities: ['text', 'image'] }))
  ctx.reflect.provide('attachments', { saveImage, imageLimits: { maxImageBytes: 100, maxMessageImageBytes: 80 } })
  ctx.reflect.provide('llm', { resolveModelInfo })
  const agent = { ctx, session: { requestHeader: () => ({ config: { provider: 'codex-custom', model: 'gpt-6.1-sol' } }) },
    options: { provider: 'fallback-provider', model: 'fallback-model' } } as unknown as Agent
  const signal = new AbortController().signal

  expect(await reporterScreenshotAttacher(agent)(Buffer.from('png'), signal)).toEqual({ status: 'attached', image })
  expect(resolveModelInfo).toHaveBeenCalledWith('codex-custom', 'gpt-6.1-sol', signal)
  expect(saveImage).toHaveBeenCalledWith({ data: Buffer.from('png'), mediaType: 'image/png', name: expect.stringMatching(/^reporter-.*\.png$/) })

  resolveModelInfo.mockResolvedValueOnce({ inputModalities: ['text'] })
  expect(await reporterScreenshotAttacher(agent)(Buffer.from('png'), signal)).toMatchObject({ status: 'unsupported', reason: 'model_does_not_accept_images' })
  resolveModelInfo.mockResolvedValueOnce({ inputModalities: undefined })
  expect(await reporterScreenshotAttacher(agent)(Buffer.from('png'), signal)).toMatchObject({ status: 'unknown', reason: 'model_image_capability_unknown' })
  expect(await reporterScreenshotAttacher(agent)(Buffer.alloc(81), signal)).toMatchObject({ status: 'too_large', reason: 'screenshot_exceeds_attachment_limit' })
  expect(saveImage).toHaveBeenCalledOnce()
})

it('keeps DSH Connection optional until browser mode requests its authenticated URL', async () => {
  expect(runtimeInject).not.toContain('connection')
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_ENABLED', '1')
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_TOKEN', 'a-test-capability-with-more-than-32-characters')
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_BROWSER', '1')
  host = await startRuntime()
  expect(host.runtime.reporterRuns).toBeDefined()

  const factory = createRuntimeReporterBrowserFactory({ host: '127.0.0.1', port: 3082, protocol: 'http:' }, () => undefined)
  await expect(factory.create('reporter-test', new AbortController().signal)).rejects.toMatchObject({ code: 'browser_unavailable' })
})

it('runs a request and worker report through Engine while capturing replies locally', async () => {
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_ENABLED', '1')
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_TOKEN', 'a-test-capability-with-more-than-32-characters')
  host = await startRuntime()
  const runtime = host.runtime, reporter = runtime.reporter!
  expect(reporter).toBeDefined()
  const visible = reporter.registerScenario({ id: 'runtime-request', version: 1, project_source_id: 'github', thread_id: '12', thread_kind: 'issue',
    visible: { persona: '仓库维护者', goal: '修复登录失败' }, actors: [{ id: 'alice', role: 'person' }],
    oracle: { assertions: [{ kind: 'ticket-count', count: 1 }, { kind: 'report-state', states: ['ready'] },
      { kind: 'output-count', output: 'acknowledgement', count: 1 }] } })
  expect(visible).not.toHaveProperty('oracle')
  const input = { scenario_id: 'runtime-request', scenario_version: 1, sequence: 1, idempotency_key: 'request-1',
    project_source_id: 'github', thread_id: '12', actor_id: 'alice', simulated_at: '2026-11-14T00:00:00Z',
    action: { kind: 'message', text: '@agent-bot 请修复登录失败', addressed: 'mention' } }
  const ack = reporter.submit(input)
  expect(ack.disposition).toBe('stored')
  expect(reporter.submit(input)).toMatchObject({ duplicate: true, trigger_id: ack.trigger_id })
  await runtime.idle()
  const routed = await host.route({ kind: 'accept', trigger_id: ack.trigger_id, title: '修复登录失败', worktree_name: 'fix-login', acknowledgement: '收到，修复登录失败。' })
  await runtime.idle()
  const ticketId = (routed.ticket as { ticket_id: string }).ticket_id
  const callsBefore = vi.mocked(Commands.prototype.run).mock.calls.length
  await host.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'ready', summary: '已修复登录失败并通过本地验证。' })
  await runtime.pump(); await runtime.sendReplies()
  const report = reporter.completeScenario('runtime-request')
  expect(report.behavioral_pass).toBe(true)
  expect(report.delivery_pass).toBe(true)
  expect(report.platform_pass).toBeNull()
  expect(report.outputs.filter(output => output.kind === 'acknowledgement')).toHaveLength(1)
  expect(report.domain_events.some(event => event.type === 'ticket.created')).toBe(true)
  expect(report.checkpoints.length).toBeGreaterThan(0)
  expect(runtime.store.threads.get('github:12')).toBeUndefined()
  expect(vi.mocked(Commands.prototype.run).mock.calls.length).toBe(callsBefore)
  const replay = reporter.replayScenario('runtime-request')!
  expect(replay.replayed_without_model_calls).toBe(true)
  expect(replay.outputs).toEqual(report.outputs)
  expect(replay.trigger_ids).toEqual([ack.trigger_id])
})

it('keeps Reporter off in ordinary runtime configuration', async () => {
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_ENABLED', '')
  host = await startRuntime()
  expect(host.runtime.reporter).toBeUndefined()
  expect(host.tools.get(host.runtime.masterId)?.has('orchestrator_reporter_start')).toBe(true)
  await expect(host.runTool(host.runtime.masterId, 'orchestrator_reporter_start', { trigger_id: 'not-available', goal: '审查代码',
    mode: 'real-service', permissions: { read_only_service: true } })).rejects.toMatchObject({ code: 'reporter_disabled' })
})

it('routes an open-ended Feishu review to Reporter first and returns a real Worker result through existing Sessions', async () => {
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_ENABLED', '1')
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_TOKEN', 'a-test-capability-with-more-than-32-characters')
  host = await startRuntime()
  const { runtime } = host
  const trigger = feishu('reporter-review-route', '@agent-bot 审查当前项目代码，发现问题后修复。')
  runtime.receive(trigger)
  await runtime.idle()
  expect(runtime.engine.candidate(trigger.id)).toMatchObject({ strength: 'explicit' })

  const startTool = host.tools.get(runtime.masterId)!.get('orchestrator_reporter_start')!
  expect(startTool.description).toContain('即使要求发现后修复')
  const startReporter = vi.spyOn(runtime.reporterRuns!, 'start')
  await expect(host.runTool(runtime.masterId, 'orchestrator_reporter_start', { trigger_id: trigger.id, goal: trigger.text,
    mode: 'both', permissions: { browser: true } })).rejects.toThrow()
  expect(startReporter).not.toHaveBeenCalled()
  const started = await host.runTool(runtime.masterId, 'orchestrator_reporter_start', { trigger_id: trigger.id, goal: trigger.text,
    mode: 'real-service', permissions: { read_only_service: true } }) as { run_id: string; session_id: string; project_source_id: string }
  expect(started).toMatchObject({ run_id: expect.stringMatching(/^auto-/), session_id: expect.stringMatching(/^reporter-auto-/), project_source_id: 'github' })
  expect(runtime.reporterRuns!.get(started.run_id)).toMatchObject({ goal: trigger.text, project_source_id: 'github' })
  expect(host.restrictions.get(started.session_id)).toEqual([{ allow: [] }])
  expect(runtime.store.tickets.list()).toEqual([])
  expect(runtime.engine.candidate(trigger.id)).toMatchObject({ strength: 'explicit' })

  const triggerCount = Number(runtime.store.db.prepare('SELECT COUNT(*) AS count FROM trigger').get()?.count)
  await host.runTool(started.session_id, 'reporter_candidate', { text: '我没有同项目源码目录。请判断是否需要一个具体执行依赖；若需要，请通过原人类请求创建 Worker 任务，为本项目准备 checkout 并运行仓库已有测试命令，返回目录、revision、实际命令、退出码和失败摘要，不修改代码。' })
  await runtime.effects.idle('relay')
  const candidateRelay = host.deliveries.mock.calls.map(([delivery]) => delivery).find(delivery =>
    delivery.sessionId === runtime.masterId && delivery.text.includes('准备 checkout 并运行仓库已有测试命令'))
  expect(candidateRelay?.text).toContain('不是 Trigger、用户授权、已确认问题或工单')
  expect(runtime.store.tickets.list()).toEqual([])
  expect(Number(runtime.store.db.prepare('SELECT COUNT(*) AS count FROM trigger').get()?.count)).toBe(triggerCount)

  // The original explicit human request is still routeable because Reporter start/relay did not answer or clarify it.
  const accepted = await host.route({ kind: 'accept', trigger_id: trigger.id, title: '准备源码 checkout 并执行现有测试',
    worktree_name: 'reporter-source-evidence', acknowledgement: '收到，将准备源码并运行现有测试。' })
  const ticketId = (accepted.ticket as { ticket_id: string }).ticket_id
  expect(runtime.store.tickets.get(ticketId)?.origin.triggerId).toBe(trigger.id)
  await runtime.idle()
  await host.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'ready', summary: 'Worker 已为 Reporter 准备同项目 checkout，并运行仓库已有测试，返回目录、revision、实际命令和退出码；未修改代码。' })
  await host.runTool(runtime.masterId, 'orchestrator_reporter_reply', { run_id: started.run_id, reply_id: 'worker-evidence-1',
    text: 'Worker 的实际报告：已准备同项目 checkout，并运行仓库已有测试，返回了目录、revision、命令和退出码；没有修改代码。请基于这些结果继续自主审查。' })
  const returned = host.deliveries.mock.calls.map(([delivery]) => delivery).find(delivery =>
    delivery.sessionId === started.session_id && delivery.text.includes('Worker 的实际报告'))
  expect(returned).toMatchObject({ mode: 'steer' })
  expect(returned?.text).toContain('Worker 的实际报告')
  expect(host.agents.has(started.session_id)).toBe(true)
})

it('answers and closes a completed Feishu review when no Worker task is needed', async () => {
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_ENABLED', '1')
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_TOKEN', 'a-test-capability-with-more-than-32-characters')
  host = await startRuntime()
  const { runtime } = host
  const trigger = feishu('reporter-review-no-worker', '@agent-bot 审查这个项目并告诉我有没有确认的问题。')
  runtime.receive(trigger)
  await runtime.idle()
  const started = await host.runTool(runtime.masterId, 'orchestrator_reporter_start', { trigger_id: trigger.id, goal: trigger.text,
    mode: 'real-service', permissions: { read_only_service: true } }) as { run_id: string }
  expect(runtime.engine.candidate(trigger.id)).toMatchObject({ strength: 'explicit' })
  await host.runTool(`reporter-${started.run_id}`, 'reporter_submit_report', { summary: '本轮未发现已确认问题。',
    full_report: '已按授权方向完成审查，没有证据充分、可提交修复的缺陷。' })
  await runtime.effects.idle('relay')
  expect(host.deliveries.mock.calls.some(([delivery]) => delivery.sessionId === runtime.masterId
    && delivery.text.includes('本轮未发现已确认问题。'))).toBe(true)
  await host.runTool(runtime.masterId, 'orchestrator_reply', { trigger_id: trigger.id, purpose: 'answer', text: '审查已完成，目前没有确认的问题。完整报告已保存在管理页。' })
  expect(runtime.store.tickets.list()).toEqual([])
  expect(runtime.engine.candidate(trigger.id)).toBeUndefined()
  await expect(host.route({ kind: 'accept', trigger_id: trigger.id, title: '修复问题', worktree_name: 'review-findings', acknowledgement: '收到。' }))
    .rejects.toThrow('answered or clarified')
})

it('ignores the original non-Feishu review candidate after Reporter reports completion without creating a Worker', async () => {
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_ENABLED', '1')
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_TOKEN', 'a-test-capability-with-more-than-32-characters')
  host = await startRuntime()
  const { runtime } = host
  const trigger = github('reporter-review-github', '@agent-bot review the project and report confirmed issues.')
  runtime.receive(trigger)
  await runtime.idle()
  expect(runtime.engine.candidate(trigger.id)).toMatchObject({ strength: 'explicit' })

  const started = await host.runTool(runtime.masterId, 'orchestrator_reporter_start', { trigger_id: trigger.id, goal: trigger.text,
    mode: 'real-service', permissions: { read_only_service: true } }) as { run_id: string }
  await host.runTool(`reporter-${started.run_id}`, 'reporter_submit_report', { summary: 'Review complete; no confirmed issues.',
    full_report: 'The authorized review is complete. No sufficiently evidenced issue needs a ticket.' })
  await runtime.effects.idle('relay')
  expect(host.deliveries.mock.calls.some(([delivery]) => delivery.sessionId === runtime.masterId
    && delivery.text.includes('Review complete; no confirmed issues.'))).toBe(true)

  await host.route({ kind: 'ignore', trigger_id: trigger.id, reason: '审查完成，没有需要创建工单的已确认问题。' })
  expect(runtime.store.tickets.list()).toEqual([])
  expect(runtime.engine.candidate(trigger.id)).toBeUndefined()
  expect(runtime.store.decisions.byThread('github:1')).toContainEqual(expect.objectContaining({ kind: 'ignore' }))
})

it('does not start a Reporter or route an old Feishu Trigger after answer consumed it', async () => {
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_ENABLED', '1')
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_TOKEN', 'a-test-capability-with-more-than-32-characters')
  host = await startRuntime()
  const { runtime } = host
  const trigger = feishu('reporter-review-handled', '@agent-bot 审查项目里有没有问题。')
  runtime.receive(trigger)
  await runtime.idle()
  await host.runTool(runtime.masterId, 'orchestrator_reply', { trigger_id: trigger.id, purpose: 'answer', text: '我正在检查。' })
  await expect(host.runTool(runtime.masterId, 'orchestrator_reporter_start', { trigger_id: trigger.id, goal: trigger.text,
    mode: 'real-service', permissions: { read_only_service: true } })).rejects.toMatchObject({ code: 'notExplicit' })
  await expect(host.route({ kind: 'accept', trigger_id: trigger.id, title: '准备代码检查结果', worktree_name: 'review-result',
    acknowledgement: '收到。' })).rejects.toThrow('answered or clarified')
  expect(runtime.reporterRuns!.list()).toEqual([])
  expect(runtime.store.tickets.list()).toEqual([])
})

it('requires critical source and screenshot GUI review while leaving investigation choices to Reporter', async () => {
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_ENABLED', '1')
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_TOKEN', 'a-test-capability-with-more-than-32-characters')
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_BROWSER', '1')
  host = await startRuntime()
  const { ticket } = await host.acceptedTicket(feishu('reporter-code-reference', '@agent-bot review the settings flow'))
  const run = await host.runtime.reporterRuns!.start({ idempotency_key: 'reporter-code-reference', goal: '以普通项目维护者视角核对设置操作是否符合预期',
    project_source_id: 'github', mode: 'browser', permissions: { browser: true }, ticket_id: ticket.id })

  expect(host.restrictions.get(run.session_id)).toEqual([{ allow: ['read', 'read_image', 'glob', 'grep'] }])
  const initialPrompt = host.deliveries.mock.calls.map(([delivery]) => delivery).find(delivery => delivery.sessionId === run.session_id)?.text
  const systemPrompt = host.systemPrompts.get(run.session_id)?.map(section => section.text({})).join('\n')
  expect(initialPrompt).toContain('尽可能寻找实现薄弱点、失败路径、界面问题和行为矛盾')
  expect(initialPrompt).toContain('结合同项目源码审查与实际截图 GUI 操作')
  expect(initialPrompt).toContain('具体审查哪个区域、提出什么假设、使用哪些工具以及按什么顺序继续，由你自主判断')
  expect(initialPrompt).toContain('没有实际看到截图图像时，不得称为完成了截图审查')
  expect(initialPrompt).toContain('工具返回稳定 candidate_id、investigation_status=investigating 和 continue_investigation=true')
  expect(initialPrompt).toContain('疑点 relay 后继续在当前 DSH Session 调查同一分支')
  expect(initialPrompt).toContain('执行依赖 relay 后继续其他可行方向')
  expect(initialPrompt).toContain('一次候选被否定、一个页面或工具受阻')
  expect(initialPrompt).toContain('同项目只读源码工作区')
  expect(initialPrompt).toContain('本次已授权截图 GUI。请实际观察截图图像并像真实用户一样操作界面')
  expect(systemPrompt).toContain('主动、挑剔的产品审查者')
  expect(systemPrompt).toContain('结合同项目源码审查与实际截图 GUI 操作')
  expect(systemPrompt).toContain('静态实现证据本身可以支持调查疑点')
  expect(systemPrompt).toContain('工具结果包含稳定 candidate_id、investigation_status=investigating 和 continue_investigation=true')
  expect(systemPrompt).toContain('疑点 relay 后必须在当前 DSH Session 继续调查、复现和核验同一分支')
  expect(systemPrompt).toContain('执行依赖 relay 后继续所有可行方向')
  expect(systemPrompt).toContain('一个候选被否定、一个页面或工具受阻')
  expect(systemPrompt).toContain('编排者的回复只处理当前分支')
  expect(systemPrompt).not.toContain('不要为了格式或清单而读取文件')
  expect(systemPrompt).not.toContain('问题判断必须依据真实用户可观察行为')

  const orchestratorTools = host.tools.get(host.runtime.masterId)!
  const replyTool = orchestratorTools.get('orchestrator_reporter_reply')!
  expect(replyTool.description).toContain('只处理当前分支')
  expect(replyTool.description).toContain('路线由 Reporter 自主选择')
  expect(replyTool.description).toContain('是否派工由你独立评估')
})

it('exchanges Reporter findings, orchestrator replies and its free-text report through native DSH Sessions', async () => {
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_ENABLED', '1')
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_TOKEN', 'a-test-capability-with-more-than-32-characters')
  host = await startRuntime()
  const { runtime } = host
  const triggersBefore = Number(runtime.store.db.prepare('SELECT COUNT(*) AS count FROM trigger').get()?.count)
  const ticketsBefore = runtime.store.tickets.list().length
  const receiptsBefore = Number(runtime.store.db.prepare('SELECT COUNT(*) AS count FROM outbox').get()?.count)
  const run = await runtime.reporterRuns!.start({ idempotency_key: 'native-session-roundtrip', goal: '确认产品行为并交流发现',
    project_source_id: 'github', mode: 'simulation', permissions: { simulation: true } })
  expect(host.agents.has(run.session_id)).toBe(true)
  expect(run.model).toEqual({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })
  expect(host.restrictions.get(run.session_id)).toEqual([{ allow: [] }])
  const reporterTools = [...host.tools.get(run.session_id)!.keys()]
  expect(reporterTools).toEqual(expect.arrayContaining(['reporter_simulator_feedback', 'reporter_simulate_user_action', 'reporter_candidate', 'reporter_submit_finding', 'reporter_submit_report']))
  expect(reporterTools).not.toEqual(expect.arrayContaining(['bash', 'pwsh', 'write', 'edit', 'subagent', 'orchestrator_route', 'orchestrator_reporter_reply']))

  const candidate = await host.runTool(run.session_id, 'reporter_candidate', { text: '登录后的设置页返回空白，需要确认是否稳定复现。' }) as {
    candidate_id: string; investigation_status: string; continue_investigation: boolean
  }
  expect(candidate).toMatchObject({ candidate_id: expect.stringMatching(/^candidate-[a-f0-9]{24}$/),
    investigation_status: 'investigating', continue_investigation: true })
  await runtime.effects.idle('relay')
  const toOrchestrator = host.deliveries.mock.calls.map(([delivery]) => delivery).find(delivery =>
    delivery.sessionId === runtime.masterId && delivery.text.includes('登录后的设置页返回空白'))
  expect(toOrchestrator).toMatchObject({ mode: 'steer' })
  expect(toOrchestrator?.text).toContain(`candidate_id：${candidate.candidate_id}`)
  expect(toOrchestrator?.text).toContain('若是未确认疑点，Reporter 会在当前 DSH Session 继续调查同一分支')
  expect(toOrchestrator?.text).toContain('不是 Trigger、用户授权、已确认问题或工单')
  expect(Number(runtime.store.db.prepare('SELECT COUNT(*) AS count FROM trigger').get()?.count)).toBe(triggersBefore)
  expect(runtime.store.tickets.list()).toHaveLength(ticketsBefore)

  await host.runTool(runtime.masterId, 'orchestrator_reporter_reply', { run_id: run.id, reply_id: 'check-reproduction',
    text: '请在全新会话和已有会话中分别复现，并比较结果。' })
  const toReporter = host.deliveries.mock.calls.map(([delivery]) => delivery).find(delivery =>
    delivery.sessionId === run.session_id && delivery.text.includes('请在全新会话'))
  expect(toReporter).toMatchObject({ mode: 'steer' })
  expect(toReporter?.id).toMatch(/^dsh-superagent:/)
  expect(host.agents.get(run.session_id)!.inbox.nextStep.some(message => message.id === toReporter?.id)).toBe(true)
  expect(host.agents.get(run.session_id)!.inbox.nextTurn.some(message => message.id === toReporter?.id)).toBe(false)

  vi.spyOn(runtime.sessions, 'relay').mockImplementationOnce(() => { throw new Error('relay queue failed') })
  await expect(host.runTool(run.session_id, 'reporter_submit_report', { summary: '新会话首次加载设置页时出现空白。',
    full_report: '复现步骤：\n1. 创建全新会话。' })).rejects.toThrow('relay queue failed')
  expect(runtime.reporterRuns!.get(run.id)?.status).not.toBe('completed')
  expect(runtime.reporterRuns!.get(run.id)?.summary).toBeUndefined()

  await host.runTool(run.session_id, 'reporter_submit_report', { summary: '新会话首次加载设置页时出现空白。',
    full_report: '复现步骤：\n1. 创建全新会话。\n2. 打开设置页。\n\n已有会话没有复现。' })
  await runtime.effects.idle('relay')
  expect(runtime.reporterRuns!.get(run.id)).toMatchObject({ status: 'completed',
    summary: '新会话首次加载设置页时出现空白。', full_report: expect.stringContaining('已有会话没有复现') })
  expect(host.deliveries.mock.calls.map(([delivery]) => delivery).filter(delivery =>
    delivery.sessionId === runtime.masterId && delivery.text.includes('Reporter 测试报告'))).toHaveLength(1)
  expect(Number(runtime.store.db.prepare('SELECT COUNT(*) AS count FROM trigger').get()?.count)).toBe(triggersBefore)
  expect(runtime.store.tickets.list()).toHaveLength(ticketsBefore)
  expect(Number(runtime.store.db.prepare('SELECT COUNT(*) AS count FROM outbox').get()?.count)).toBe(receiptsBefore)
})

it.each(['enabled', 'disabled', 'deleted'].flatMap(rule => ['followup', 'attach'].map(via => ({ rule, via }))))(
  'revalidates a confirmed Reporter ticket before $via with its matched rule $rule', async ({ rule, via }) => {
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_ENABLED', '1')
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_TOKEN', 'a-test-capability-with-more-than-32-characters')
  host = await startRuntime()
  const { runtime } = host
  const run = await runtime.reporterRuns!.start({ idempotency_key: 'confirmed-finding-chain', goal: '确认设置页的窄屏问题',
    project_source_id: 'github', mode: 'real-service', permissions: { read_only_service: true } })
  const finding = { finding_id: 'narrow-settings', title: '窄屏设置页裁切内容', body: '在窄视口打开设置页时主要操作区被裁切。', evidence: '源码布局约束与真实截图复现一致。' }
  const submitted = await host.runTool(run.session_id, 'reporter_submit_finding', finding)
  expect(submitted).toMatchObject({ finding_id: finding.finding_id, trigger_id: expect.stringMatching(/^reporter:finding:/), disposition: 'stored' })
  await runtime.idle()
  const triggerId = submitted.trigger_id as string
  expect(runtime.store.triggers.get(triggerId)).toMatchObject({ source: 'github', human: false, actor: { id: '' }, meta: { reporter: { kind: 'finding', confidence: 'confirmed' } } })
  expect(runtime.store.triggers.disposition(triggerId)).toMatchObject({ evalId: expect.any(String) })
  expect(runtime.store.tickets.list()).toHaveLength(0)
  await host.runTool(runtime.masterId, 'orchestrator_eval', { trigger_id: triggerId })
  const accepted = await host.runTool(runtime.masterId, 'orchestrator_eval_decide', {
    trigger_id: triggerId, decision: 'accept', title: finding.title, worktree_name: 'narrow-settings', scope: finding.body,
    reason: 'Reporter 已提供可复核的源码和截图证据。', intent_evidence: finding.evidence,
    acknowledgement: '收到，按正常工单流程处理。',
    rule_assessments: [{ rule_id: 'copy', matched: false, reason: '不是文案问题' }, { rule_id: 'visual', matched: true, reason: '存在可复核的布局裁切' }],
    direction: { implementation_requested: true, target_basis: 'existing-standard', requires_design_decision: false, evidence: finding.evidence },
  })
  expect(accepted).toMatchObject({ decision: 'accept', ticket: { ticket_id: expect.any(String) } })
  await runtime.idle()
  const ticket = runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!
  expect(ticket.origin.triggerId).toBe(triggerId)
  expect(ticket.mandate).toMatchObject({ strength: 'inferred', basis: { via: 'reporter', authority: 'confirmed', rules: ['visual'] } })
  runtime.engine.bindThread(ticket.id, { source: 'github', id: '7' }, true)
  await host.runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'dropped', summary: '本轮结束。' })
  await runtime.idle()
  const ended = runtime.store.tickets.get(ticket.id)!.ended
  expect(ended).toMatchObject({ by: 'executor' })

  const policy = runtime.store.settings().policy
  const rules = rule === 'deleted' ? policy.rules.filter(item => item.id !== 'visual')
    : policy.rules.map(item => ({ ...item, enabled: item.id === 'visual' ? rule === 'enabled' : item.enabled }))
  await runtime.settings.save('policy', { ...policy, rules }, runtime.store.blockRevision('policy'), 'panel')
  expect(runtime.store.settings().eval.mode).toBe('auto')
  expect(runtime.store.tickets.get(ticket.id)!.inputs.some(input => input.kind === 'policy-changed')).toBe(false)

  const message: Trigger = { id: 'reporter-followup', source: 'github', actor: { source: 'github', id: 'alice' }, human: true,
    threads: [{ source: 'github', id: via === 'attach' ? '8' : '7' }], addressed: 'mention', at: new Date().toISOString(),
    text: '请继续检查这个问题。', meta: { number: via === 'attach' ? 8 : 7, isPr: true, kind: 'conversation' } }
  runtime.receive(message)
  await runtime.idle()
  if (via === 'attach') {
    if (rule === 'enabled') runtime.engine.attach(ticket.id, message.id)
    else expect(() => runtime.engine.attach(ticket.id, message.id)).toThrow(new UserError('mandateRevoked'))
    await runtime.idle()
  }
  const current = runtime.store.tickets.get(ticket.id)!
  expect(current.mandate).toEqual(ticket.mandate)
  if (rule === 'enabled') {
    expect(current.ended).toBeUndefined()
    expect(current.assignments).toHaveLength(2)
    expect(runtime.store.triggers.disposition(message.id)?.fanout).toContain(ticket.id)
  } else {
    expect(current.ended).toEqual(ended)
    expect(current.assignments).toHaveLength(1)
    expect(current.undelivered).toEqual([])
    expect(runtime.store.triggers.disposition(message.id)?.fanout).not.toContain(ticket.id)
    expect(runtime.engine.candidate(message.id)).toBeDefined()
  }
})

it('offers only the current simulation safe projection on demand and advances its sequence with accepted input', async () => {
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_ENABLED', '1')
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_TOKEN', 'a-test-capability-with-more-than-32-characters')
  host = await startRuntime()
  const runtime = host.runtime
  const run = await runtime.reporterRuns!.start({ idempotency_key: 'simulator-feedback-projection', goal: '自主选择如何了解产品行为',
    project_source_id: 'github', mode: 'simulation', permissions: { simulation: true } })
  const feedbackTool = reporterTools({ reporter: runtime.reporter!, runs: runtime.reporterRuns!, waitForTarget: async () => {},
    probeReadOnly: async probe_id => ({ probe_id, status: 200, body: '{}', json: true }) }, run.session_id,
  runtime.reporterRuns!.contextForSession(run.session_id)!).find(tool => tool.name === 'reporter_simulator_feedback')!
  const first = await host.runTool(run.session_id, 'reporter_simulator_feedback', {})
  expect(first).toMatchObject({
    visible: expect.objectContaining({ persona: expect.any(String), goal: '自主选择如何了解产品行为' }),
    actors: [{ id: expect.any(String), role: 'person' }], last_sequence: 0, next_sequence: 1, conversation: [],
  })
  expect(first).not.toHaveProperty('oracle')
  expect(feedbackTool.schema.safeParse({ scenario_id: 'another-run' }).success).toBe(false)

  const context = runtime.reporterRuns!.contextForSession(run.session_id)!
  const scenarioId = context.scenario_id!
  const before = runtime.reporter!.simulatorFeedback(scenarioId)!
  runtime.reporter!.submit({ scenario_id: scenarioId, scenario_version: before.scenario.version, sequence: first.next_sequence as number,
    idempotency_key: `${run.id}:1`, simulated_at: '2026-11-15T00:00:00Z', actor_id: (first.actors as { id: string }[])[0]!.id,
    project_source_id: run.project_source_id, thread_id: before.scenario.thread_id, action: { kind: 'message', text: '我想进一步了解这个项目。' } })

  const after = await host.runTool(run.session_id, 'reporter_simulator_feedback', {})
  expect(after).toMatchObject({ last_sequence: 1, next_sequence: 2,
    conversation: [{ role: 'actor', actor_id: (first.actors as { id: string }[])[0]!.id, text: '我想进一步了解这个项目。' }] })
  expect(after).not.toHaveProperty('oracle')

  const withoutSimulation = await runtime.reporterRuns!.start({ idempotency_key: 'no-simulation-feedback', goal: '读取服务健康状态',
    project_source_id: 'github', mode: 'real-service', permissions: { read_only_service: true } })
  expect(host.tools.get(withoutSimulation.session_id)?.has('reporter_simulator_feedback')).toBe(false)
})

it('projects a restored Reporter Session model from its actual DSH request header', async () => {
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_ENABLED', '1')
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_TOKEN', 'a-test-capability-with-more-than-32-characters')
  host = await startRuntime()
  const run = await host.runtime.reporterRuns!.start({ idempotency_key: 'existing-model-route', goal: '恢复 Reporter 路由',
    project_source_id: 'github', mode: 'simulation', permissions: { simulation: true } })
  const agent = host.agents.get(run.session_id)! as unknown as { session: { snapshotEvents(): { type: string }[]; append(type: string, data: unknown): unknown } }
  const events = agent.session.snapshotEvents()
  events.splice(0, events.length, ...events.filter(event => event.type !== 'model/selection'))
  agent.session.append('request/header', { header: { config: { provider: 'persisted-provider', model: 'persisted-model', reasoningEffort: 'medium' } }, reason: 'initial' })
  host.controller.modelCatalog.mockRejectedValueOnce(new Error('current DSH default model unavailable'))

  await expect(host.runtime.sessions.ensureReporter(run.session_id, host.directory, 'Reporter with an existing DSH route'))
    .resolves.toEqual({ provider: 'persisted-provider', model: 'persisted-model', reasoningEffort: 'medium' })
})

it('routes a listed user stop action on an active thread through the real Engine', async () => {
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_ENABLED', '1')
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_TOKEN', 'a-test-capability-with-more-than-32-characters')
  host = await startRuntime()
  const runtime = host.runtime, reporter = runtime.reporter!
  reporter.registerScenario({ id: 'runtime-stop', version: 1, project_source_id: 'github', thread_id: '12', thread_kind: 'issue',
    visible: { persona: '仓库维护者', goal: '取消不再需要的修复' }, actors: [{ id: 'alice', role: 'person' }],
    oracle: { assertions: [{ kind: 'decision', decision: 'stop', sequence: 2 }, { kind: 'ticket-outcome', outcomes: ['stopped'] }] } })
  const envelope = { scenario_id: 'runtime-stop', scenario_version: 1, project_source_id: 'github', thread_id: '12',
    actor_id: 'alice', simulated_at: '2026-11-14T00:00:00Z' }
  const request = reporter.submit({ ...envelope, sequence: 1, idempotency_key: 'request',
    action: { kind: 'message', text: '@agent-bot 请修复登录失败', addressed: 'mention' } })
  await runtime.idle()
  const routed = await host.route({ kind: 'accept', trigger_id: request.trigger_id, title: '修复登录失败',
    worktree_name: 'fix-login', acknowledgement: '收到。' })
  await runtime.idle()
  const ticketId = (routed.ticket as { ticket_id: string }).ticket_id
  // 名单用户在已参与线程里的追问无需再次 mention，仍由普通策略判定为明确请求。
  const stop = reporter.submit({ ...envelope, sequence: 2, idempotency_key: 'stop',
    action: { kind: 'stop', text: '不用修了，请停止。' } })
  expect(runtime.store.triggers.get(stop.trigger_id)?.addressed).toBeUndefined()
  await runtime.idle()
  const result = await host.route({ kind: 'stop', trigger_id: stop.trigger_id, ticket_id: ticketId, reason: '用户取消修复' })
  await runtime.idle()
  expect(result).toMatchObject({ decision: 'stop' })
  expect(runtime.store.tickets.get(ticketId)).toMatchObject({ ended: { by: 'human', outcome: 'stopped' },
    assignments: [expect.objectContaining({ state: 'ended' })] })
  expect(reporter.completeScenario('runtime-stop')).toMatchObject({ behavioral_pass: true, platform_pass: null })
})

it('waits for a resumed worker turn and an idle DSH Agent after its Ticket ends', async () => {
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_ENABLED', '1')
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_TOKEN', 'a-test-capability-with-more-than-32-characters')
  host = await startRuntime()
  const runtime = host.runtime, reporter = runtime.reporter!
  reporter.registerScenario({ id: 'runtime-autonomous-wait', version: 1, project_source_id: 'github', thread_id: '12', thread_kind: 'issue',
    visible: { persona: '仓库维护者', goal: '修复登录失败' }, actors: [{ id: 'alice', role: 'person' }],
    oracle: { assertions: [{ kind: 'receive', sequence: 1, result: 'stored' }] } })
  const envelope = { scenario_id: 'runtime-autonomous-wait', scenario_version: 1, project_source_id: 'github', thread_id: '12',
    actor_id: 'alice', simulated_at: '2026-11-14T00:00:00Z' }
  const first = reporter.submit({ ...envelope, sequence: 1, idempotency_key: 'first',
    action: { kind: 'message', text: '@agent-bot 请修复登录失败', addressed: 'mention' } })
  await runtime.idle()
  const accepted = await host.route({ kind: 'accept', trigger_id: first.trigger_id, title: '修复登录失败',
    worktree_name: 'reporter-followup', acknowledgement: '收到。' })
  await runtime.idle()
  const ticketId = (accepted.ticket as { ticket_id: string }).ticket_id
  await host.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'blocked', summary: '已开始检查登录失败。', human_action: '能否提供失败时间？' })
  host.agents.get(`worker-${ticketId}`)!.status = 'idle'
  await runtime.pump(); await runtime.sendReplies()

  const followup = reporter.submit({ ...envelope, sequence: 2, idempotency_key: 'followup',
    action: { kind: 'message', text: '补充说明：请同时确认失败原因。' } })
  await runtime.idle()
  expect(runtime.store.triggers.disposition(followup.trigger_id)).toMatchObject({ fanout: [ticketId] })
  expect(runtime.store.triggers.disposition(followup.trigger_id)).not.toHaveProperty('decisionId')
  await host.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'ready', summary: '已复查失败原因。' })
  const worker = host.agents.get(`worker-${ticketId}`)!
  worker.status = 'idle'
  await runtime.pump(); await runtime.sendReplies()

  worker.status = 'running'
  host.agents.get(runtime.masterId)!.status = 'idle'
  host.agents.delete(worker.id)
  let finished = false
  const wait = (runtime as unknown as { waitForReporterTarget(id: string, signal: AbortSignal): Promise<void> }).waitForReporterTarget
    .call(runtime, 'runtime-autonomous-wait', new AbortController().signal).then(() => { finished = true })
  await new Promise(resolve => setTimeout(resolve, 80))
  expect(finished).toBe(false)
  host.agents.set(worker.id, worker)
  worker.status = 'idle'
  await wait
  expect(finished).toBe(true)
}, 10_000)

it('isolates GitHub and GitLab requests with the same number and binds an MR through its project CLI', async () => {
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_ENABLED', '1')
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_TOKEN', 'a-test-capability-with-more-than-32-characters')
  host = await startRuntime()
  const runtime = host.runtime, reporter = runtime.reporter!
  const id = projectSourceId('gitlab', 'gitlab.internal', 'team/widgets')
  // 平台 setup/网络另有测试；此处向真实 Runtime 注入已完成探测的项目，验证 Engine 和工具接线。
  runtime.deployment.projects![id] = { id, provider: 'gitlab', host: 'gitlab.internal', project: 'team/widgets',
    cli: '/bin/false', login: 'agent-bot', noreply: '7-agent-bot@users.noreply.gitlab.internal', configDir: `${host.directory}/gitlab` }
  const settings = runtime.store.settings()
  runtime.store.saveSettings({ ...settings, sources: { ...settings.sources,
    [id]: { kind: 'gitlab', enabled: true, config: { host: 'gitlab.internal', repository: 'team/widgets', cli: '/bin/false' } } },
    policy: { ...settings.policy, sources: { ...settings.policy.sources, [id]: { allowed: [{ id: 'alice' }] } } } })
  runtime.sources.register(gitlabKind)
  const tickets: string[] = []
  for (const [scenario, project] of [['mixed-github', 'github'], ['mixed-gitlab', id]]) {
    reporter.registerScenario({ id: scenario!, version: 1, project_source_id: project!, thread_id: '12', thread_kind: 'pull',
      visible: { persona: '维护者', goal: '修复合并请求' }, actors: [{ id: 'alice', role: 'person' }],
      oracle: { assertions: [{ kind: 'ticket-count', count: 1 }, { kind: 'report-state', states: ['ready'] },
        { kind: 'output-count', output: 'acknowledgement', count: 1 }] } })
    const ack = reporter.submit({ scenario_id: scenario, scenario_version: 1, sequence: 1, idempotency_key: 'request',
      project_source_id: project, thread_id: '12', actor_id: 'alice', simulated_at: '2026-11-14T00:00:00Z',
      action: { kind: 'message', text: '@agent-bot 请修复这个合并请求', addressed: 'mention' } })
    await runtime.idle()
    const result = await host.route({ kind: 'accept', trigger_id: ack.trigger_id, title: '修复合并请求',
      worktree_name: scenario, acknowledgement: '收到。' })
    await runtime.idle()
    tickets.push((result.ticket as { ticket_id: string }).ticket_id)
  }
  const [githubTicket, gitlabTicket] = tickets as [string, string]
  const calls: { project: string; args: string[] }[] = []
  vi.mocked(Commands.prototype.run).mockImplementation(async function (this: Commands, _program, args) {
    calls.push({ project: this.repository, args })
    if (args[0] === 'config') return 'false'
    if (args[1]?.endsWith('/approvals')) return JSON.stringify({ approved: false })
    if (args[1] === 'projects/team%2Fwidgets/merge_requests/12') return JSON.stringify({ iid: 12, title: '修复登录', state: 'opened',
      web_url: 'https://gitlab.internal/team/widgets/-/merge_requests/12', author: { username: 'alice' }, source_branch: 'fix-login' })
    throw new Error(`Unexpected CLI call: ${args.join(' ')}`)
  })
  await expect(host.runTool(`worker-${githubTicket}`, 'orchestrator_report', { state: 'ready', summary: '完成', mr_iid: 12 })).rejects.toThrow('requires a GitLab ticket')
  await expect(host.runTool(`worker-${gitlabTicket}`, 'orchestrator_report', { state: 'ready', summary: '完成', mr_iid: 12, pr_number: 12 })).rejects.toThrow('cannot be combined')
  await host.runTool(`worker-${gitlabTicket}`, 'orchestrator_report', { state: 'ready', summary: '完成', mr_iid: 12 })
  await host.runTool(`worker-${githubTicket}`, 'orchestrator_report', { state: 'ready', summary: '完成' })
  await runtime.pump(); await runtime.sendReplies()
  expect(calls).toHaveLength(2)
  expect(calls.every(call => call.project === 'team/widgets')).toBe(true)
  expect(runtime.store.tickets.get(gitlabTicket)!.follows).toContainEqual(expect.objectContaining({ thread: `${id}:mr:12` }))
  expect(runtime.store.tickets.get(githubTicket)!.follows?.some(follow => follow.thread.startsWith(`${id}:`))).not.toBe(true)
  for (const scenario of ['mixed-github', 'mixed-gitlab']) {
    expect(reporter.completeScenario(scenario)).toMatchObject({ behavioral_pass: true, delivery_pass: true, platform_pass: null })
  }
  // 仅剩一个 GitLab 项目时，主 Session 的无前缀资源也必须绑定该项目。
  delete runtime.deployment.projects!.github
  await host.runTool(runtime.masterId, 'orchestrator_read', { resource: 'gitlab/merge_request/12/approvals' })
  expect(calls).toHaveLength(4)
  expect(calls.at(-1)?.project).toBe('team/widgets')
})
