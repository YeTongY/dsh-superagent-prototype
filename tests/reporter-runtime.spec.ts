/** 真实 Runtime/Engine 的本地 Reporter 闭环；不调用平台消息 API 或模型。 */
import { afterEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { projectSourceId } from '../src/project-source.ts'
import { gitlabKind } from '../src/sources/gitlab.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { createRuntimeReporterBrowserFactory } from '../src/app/runtime.ts'
import { reporterTools } from '../src/app/tools/reporter.ts'
import { inject as runtimeInject } from '../src/index.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined; vi.unstubAllEnvs() })

it('keeps DSH Connection optional until browser mode requests its authenticated URL', async () => {
  expect(runtimeInject).not.toContain('connection')
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_ENABLED', '1')
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_TOKEN', 'a-test-capability-with-more-than-32-characters')
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_BROWSER', '1')
  host = await startRuntime()
  expect(host.runtime.reporterRuns).toBeDefined()

  const factory = createRuntimeReporterBrowserFactory({ host: '127.0.0.1', port: 3082, protocol: 'http:' }, () => undefined)
  await expect(factory.create(new AbortController().signal)).rejects.toMatchObject({ code: 'browser_unavailable' })
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
})

it('offers the bound executor workspace without prescribing an inspection path', async () => {
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_ENABLED', '1')
  vi.stubEnv('DSH_SUPERAGENT_REPORTER_TOKEN', 'a-test-capability-with-more-than-32-characters')
  host = await startRuntime()
  const { ticket } = await host.acceptedTicket(feishu('reporter-code-reference', '@agent-bot review the settings flow'))
  const run = await host.runtime.reporterRuns!.start({ idempotency_key: 'reporter-code-reference', goal: '以普通项目维护者视角核对设置操作是否符合预期',
    project_source_id: 'github', mode: 'real-service', permissions: { read_only_service: true }, ticket_id: ticket.id })

  expect(host.restrictions.get(run.session_id)).toEqual([{ allow: ['read', 'read_image', 'glob', 'grep'] }])
  const initialPrompt = host.deliveries.mock.calls.map(([delivery]) => delivery).find(delivery => delivery.sessionId === run.session_id)?.text
  const systemPrompt = host.systemPrompts.get(run.session_id)?.map(section => section.text({})).join('\n')
  expect(initialPrompt).toContain('独立决定从哪里开始')
  expect(initialPrompt).toContain('你可以自行判断读取其中代码或测试是否有助于调查')
  expect(initialPrompt).not.toContain('先用 DSH 原生只读文件工具')
  expect(initialPrompt).not.toContain('检查项目入口及与目标相关的实现和测试')
  expect(initialPrompt).not.toContain('在完整报告中列出实际查看的文件')
  expect(systemPrompt).toContain('调查方向、工具选择、验证顺序和结束时机都由你根据实际反馈自行决定')
  expect(systemPrompt).toContain('只读代码和测试是否有助于调查由你自行判断')
  expect(systemPrompt).not.toContain('先用 DSH 原生只读文件工具')
  expect(systemPrompt).not.toContain('检查项目入口及与目标相关的实现和测试')
  expect(systemPrompt).not.toContain('在完整报告中列出实际查看的文件')
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
  expect(reporterTools).toEqual(expect.arrayContaining(['reporter_simulator_feedback', 'reporter_simulate_user_action', 'reporter_candidate', 'reporter_submit_report']))
  expect(reporterTools).not.toEqual(expect.arrayContaining(['bash', 'pwsh', 'write', 'edit', 'subagent', 'orchestrator_route', 'orchestrator_reporter_reply']))

  await host.runTool(run.session_id, 'reporter_candidate', { text: '登录后的设置页返回空白，需要确认是否稳定复现。' })
  await runtime.effects.idle('relay')
  const toOrchestrator = host.deliveries.mock.calls.map(([delivery]) => delivery).find(delivery =>
    delivery.sessionId === runtime.masterId && delivery.text.includes('登录后的设置页返回空白'))
  expect(toOrchestrator).toMatchObject({ mode: 'steer' })
  expect(toOrchestrator?.text).toContain('不是用户消息、用户授权或派工指令')

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
