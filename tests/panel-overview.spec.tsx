// @vitest-environment jsdom
// The overview.
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, all, find, tab, click, text } from './fixtures/panel.tsx'
import { server, droppedReply, threadSummary } from './fixtures/panel-server.ts'
import type { ReporterAutonomousRunView } from '../src/reporter/autonomous.ts'

usePanel()
it('leads the overview with the pending Tickets, then problems, the last day and the Executor, each linking to its stage', async () => {
  await mount()
  expect(tab(zh['tab.overview']).getAttribute('aria-selected')).toBe('true')
  expect(all('[role="tab"]').map(tab => tab.textContent)).toEqual(['概览', '来源', '触发', '评估', '执行', '设置'])
  expect(all('.dt-section-title').map(title => title.textContent)).toEqual(['待处理工单2', '系统问题2', '自主测试报告者0',
    '过去 24 小时详情 ›', '执行器详情 ›'])
  expect(text()).toContain('报告者已关闭，当前没有运行。')
  expect(all('.dt-cards .dt-ticket-stage').map(item => item.textContent)).toEqual(['待回答', '待处理失败'])
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toEqual(['飞书 来源异常', '评估未完成：这个文案好奇怪'])
  // Actions sit below the title and Threads, apart from the stage, each with its icon.
  expect(all('.dt-ticket').every(row => row.querySelector('.dt-ticket-stage button, .dt-ticket-stage a') === null
    && [...row.querySelectorAll('.dt-ticket-actions button, .dt-ticket-actions a')].every(action => action.querySelector('svg')))).toBe(true)
  expect(text()).toContain('来源会在每次轮询时自动重试')
  expect(text()).toContain('需要确认按钮颜色')
  expect(all('.dt-stat').map(stat => stat.textContent)).toEqual(['到达12', '被过滤2', '已评估5', '接单或续做1', '执行中2 / 3', '排队0', '等待新触发1'])
  expect(server.requests.some(request => request.path === 'reporter' && request.method === 'GET')).toBe(true)
  expect(all('.dt-chip').map(chip => chip.textContent)[0]).toBe('GitHub#42CI 失败1')
  expect(document.querySelector('.dt-chip-problem')?.textContent).toBe('CI 失败1')
  expect(document.querySelector<HTMLAnchorElement>('a.dt-chip-link')?.href).toBe('https://github.com/acme/widgets/pull/42')
  await click(all('.dt-more-link').at(-1)!)
  expect(tab(zh['tab.execution']).getAttribute('aria-selected')).toBe('true')
})

it('re-evaluates or dismisses an unjudged Eval from the problem list', async () => {
  await mount()
  await click(zh.requeue)
  expect(server.requests.some(request => request.path === 'triggers/e3/requeue' && request.method === 'POST')).toBe(true)
  await click(zh.dismiss)
  expect(server.requests.some(request => request.path === 'decisions/u1/dismiss' && request.method === 'POST')).toBe(true)
  expect(server.requests.filter(request => request.path === 'overview').length).toBeGreaterThan(2)
})

it('opens the Thread of an unjudged Eval at its Trigger from the problem list', async () => {
  await mount()
  await click('评估未完成：这个文案好奇怪')
  expect(server.requests.some(request => request.path.startsWith('threads/feishu:oc_1:om_root'))).toBe(true)
  expect(document.querySelector('.dt-highlight')?.textContent).toContain('message e3')
})

it('follows the last day\'s counts to the status of each stage', async () => {
  await mount()
  // Arrived Triggers include filtered ones, which have no Thread, so no list has that count to link to.
  expect(all('.dt-stat button').map(button => button.textContent)).toEqual(['2', '1'])
  await click(all('.dt-stat button')[0]!)
  expect(tab(zh['tab.source']).getAttribute('aria-selected')).toBe('true')
  await click(zh.sourceFilteredTitle)
  expect(text()).toContain('looks wrong')
  expect(text()).toContain(zh['reason.source_disabled'])
})

it('offers each Ticket that needs a person its actions on the overview: answer in its Channel, retry or open a failed worker, and stop',
  async () => {
  await mount()
  expect(all('.dt-ticket-actions a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['去飞书回答',
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_1']])
  expect(all('.dt-ticket-note').map(note => note.textContent)).toContain('LlmError: no adapter registered for provider "provider-a"')
  await click(zh.retry)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t4/retry' && request.method === 'POST')).toBe(true)
  await click(all('.dt-ticket-actions button').find(button => button.textContent === '打开 Session')!)
  expect(server.opened).toEqual(['worker-t4'])
  await click(all('.dt-ticket-actions button').filter(button => button.textContent === '停止').at(-1)!)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t4/stop' && request.method === 'POST')).toBe(true)
  expect(text()).not.toContain('截图工具')
})

it('shows paused processing as a system problem with its resume action, and says so on the Policy records', async () => {
  server.settings = { ...server.settings, paused: true }
  await mount()
  expect(text()).toContain(zh.problemPaused)
  await click(zh['tab.eval'])
  expect(text()).toContain(zh.evalRecordsPaused)
  await click(zh.resumeWhere)
  expect(tab(zh['tab.execution']).getAttribute('aria-selected')).toBe('true')
  await click(zh['tab.overview'])
  await click(find(zh.resumeProcessing, '.dt-att button'))
  await click(zh.confirm)
  expect(server.requests.find(request => request.path === 'executor/pause')).toMatchObject({ method: 'POST', body: { paused: false } })
})

it('offers the step that fixes a settings problem as a button on the overview', async () => {
  server.settings = { ...server.settings, policy: { ...server.settings.policy, sources: { feishu: { allowed: [], admission: {} },
    github: { allowed: [], admission: {} } } } }
  await mount()
  expect(text()).toContain(zh.problemNoAllowed)
  await click(zh.actionAddAllowed)
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.eval'])
})

it('counts the messages not sent in the last day, linking to the Source status, and shows nothing when there are none', async () => {
  await mount()
  expect(all('.dt-stat-label').map(label => label.textContent)).not.toContain(zh.flowDroppedLabel)
  server.dropped = [droppedReply('m2', 1, 'feishu', 'channelGone'), droppedReply('m1', 2, 'github', 'channelIgnored'), droppedReply('m0',
    30, 'feishu', 'channelGone')]
  await remount()
  const stat = all('.dt-stat').find(item => item.querySelector('.dt-stat-label')?.textContent === zh.flowDroppedLabel)!
  expect(stat.textContent).toBe(`${zh.flowDroppedLabel}2`)
  await click(stat.querySelector('button')!)
  expect(tab(zh['tab.source'])?.getAttribute('aria-selected')).toBe('true')
})

it('names a failing part of dsh-superagent itself by its label', async () => {
  server.health = { launch: { state: 'error', detail: 'spawn failed' }, relay: { state: 'ready', detail: 'Nothing waiting' } }
  await mount()
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toContain(zh.problemRuntime.replace('{name}', zh['health.launch']))
  expect(text()).toContain('spawn failed')
})

it('words a refused retry in the interface language by its code', async () => {
  await mount()
  // Simulate another user retrying the ticket after the overview loaded.
  server.person = server.person.map(ticket => ticket.id === 't4' ? { ...ticket, actions: { ...ticket.actions, retry: false } } : ticket)
  await click(find(zh.retry, '.dt-ticket-actions button'))
  await click(zh.confirm)
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh['userError.notRetryable'])
  expect(text()).not.toContain('Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed')
})

it('shows the overview in English', async () => {
  await mount(en)
  expect(all('.dt-section-title').map(title => title.textContent)).toEqual([`${en.pendingTickets}2`, `${en.problems}2`, `${en['reporter.title']}0`,
    `${en.lastDay}${en.details}`, `${en['term.executor']}${en.details}`])
  expect(text()).toContain(en['reporter.disabled'])
  expect(all('.dt-cards .dt-ticket-stage').map(item => item.textContent)).toEqual([en['stage.answer'], en['stage.failed']])
  expect(all('.dt-stat-label').map(label => label.textContent)).toEqual([en.flowReceivedLabel, en.flowFilteredLabel, en.flowJudgedLabel,
    en.flowAcceptedLabel, en.executingLabel, en.queuedLabel, en.idleLabel])
})

const autonomousRun = (id: string, status: ReporterAutonomousRunView['status'], finding = false): ReporterAutonomousRunView => ({
  id, goal: '检查自举项目的问题处理体验', project_source_id: 'github:acme/widgets', mode: 'both', status,
  phase: status === 'running' ? 'simulation' : 'finished', started_at: '2026-11-14T00:00:00.000Z', updated_at: '2026-11-14T00:01:00.000Z',
  model: { provider: 'host', model: 'reporter-model', reasoningEffort: 'medium' }, experiments: 1, turns: 2, model_calls: 4,
  model_usage: { prompt_tokens: 1_240, completion_tokens: 320, cost_usd: null, latency_ms: 4200, retries: null, completeness: 'partial' },
  scenario_ids: ['auto-scenario-1'], experiment_log: [
    { kind: 'simulation', hypothesis: '一条简短的产品请求可能让目标先确认需求。',
      observation: 'Superagent 已针对第一次请求创建并返回本地工单确认。', evidence: ['输入序号 1', '目标回复序号 2'], scenario_id: 'auto-scenario-1' },
    { kind: 'real-service', hypothesis: '查看运行状态可以发现对用户不可见的阻塞。',
      observation: '运行状态正常，来源仍处于可用状态。', evidence: ['HTTP 状态 200'] },
    { kind: 'browser', hypothesis: '概览页应该明确显示 Reporter 是否开始测试。',
      observation: '页面显示了已启用但尚无运行的空状态。', evidence: ['页面可见文本检查'] },
  ],
  summary: '报告者根据产品目标自主选择了一个测试方向。',
  ...(finding ? { findings: [{ severity: 'warning' as const, status: 'candidate' as const, title: '错误反馈可能不够清楚',
    evidence: ['第 2 次用户动作收到通用失败反馈'], reproduction: ['提交一个无效请求', '观察 Superagent 的拒绝说明'] }] } : {}),
})

it('shows an enabled idle Reporter distinctly from an active run and presents its autonomous evidence', async () => {
  server.reporter = { enabled: true, runs: [] }
  await mount()
  expect(text()).toContain(zh['reporter.enabledIdle'])
  expect(text()).not.toContain(zh['reporter.status.running'])

  server.reporter = { enabled: true, runs: [autonomousRun('run-active', 'running', true)] }
  await remount()
  expect(text()).toContain(zh['reporter.status.running'])
  expect(text()).toContain('阶段：simulation')
  expect(text()).toContain('仿真和服务检查')
  expect(text()).toContain('模型：host/reporter-model')
  expect(text()).toContain('推理等级：medium')
  expect(text()).toContain('实验 1')
  expect(text()).toContain('用户动作 2')
  expect(text()).toContain('模型调用 4')
  expect(text()).toContain('输入 Token：1240')
  expect(text()).toContain('输出 Token：320')
  expect(text()).toContain('费用（美元）：未知')
  expect(text()).toContain('重试次数：未知')
  expect(text()).toContain('用量部分未知')
  expect(text()).toContain('auto-scenario-1')
  expect(text()).toContain('自主测试过程')
  expect(text()).toContain('一条简短的产品请求可能让目标先确认需求。')
  expect(text()).toContain('Superagent 已针对第一次请求创建并返回本地工单确认。')
  expect(text()).toContain('输入序号 1')
  expect(text()).toContain('查看运行状态可以发现对用户不可见的阻塞。')
  expect(text()).toContain('HTTP 状态 200')
  expect(text()).toContain('浏览器操作')
  expect(text()).toContain('页面显示了已启用但尚无运行的空状态。')
  const details = all('.dt-reporter-experiment details')
  expect(details).toHaveLength(3)
  expect(details.every(item => !(item as HTMLDetailsElement).open)).toBe(true)
  expect(details[0]?.querySelector('summary')?.textContent).toBe(zh['reporter.experimentDetails'])
  expect(all('.dt-reporter-finding details').every(item => !(item as HTMLDetailsElement).open)).toBe(true)
  expect(text()).toContain('错误反馈可能不够清楚')
  expect(text()).toContain('第 2 次用户动作收到通用失败反馈')
  expect(text()).toContain('提交一个无效请求')
})

it('labels browser actions separately from simulated user actions', async () => {
  server.reporter = { enabled: true, runs: [
    { ...autonomousRun('browser', 'completed'), mode: 'browser' },
  ] }
  await mount()
  expect(text()).toContain('浏览器动作 2')
  expect(text()).not.toContain('用户动作 2')
})

it('labels completed, incomplete, failed and cancelled runs separately', async () => {
  server.reporter = { enabled: true, runs: [
    autonomousRun('done', 'completed'), autonomousRun('partial', 'incomplete'), autonomousRun('failed', 'failed'),
    autonomousRun('cancelled', 'cancelled'),
  ] }
  await mount()
  expect(all('.dt-reporter-run > .dt-row-main > .dt-row-meta:first-of-type').map(item => item.textContent)).toEqual([
    `${zh['reporter.status.completed']}阶段：finished仿真和服务检查`, `${zh['reporter.status.incomplete']}阶段：finished仿真和服务检查`,
    `${zh['reporter.status.failed']}阶段：finished仿真和服务检查`, `${zh['reporter.status.cancelled']}阶段：finished仿真和服务检查`,
  ])
})

it('lists the unavailable Evals one by one, without the health entry that counts them as a failure of dsh-superagent', async () => {
  server.health.evals = { state: 'error', detail: '1 Eval(s) unavailable in the last hour without a later judgement' }
  await mount()
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toEqual(['飞书 来源异常', '评估未完成：这个文案好奇怪'])
  expect(text()).not.toContain(zh['health.evals'])
})

it('says when no Source is on, an Eval is past its deadline or a message keeps failing, each with the way to it', async () => {
  for (const kind of ['feishu', 'github']) server.settings.sources[kind] = { ...server.settings.sources[kind]!, enabled: false }
  server.threads = [threadSummary({ key: 'github:9', title: '#9 迟迟未决', stage: 'evaluating',
    evaluating: { id: 'v9', triggers: 1, strength: 'inferred', startedAt: '2026-08-31T23:58:00Z', deadline: '2026-09-01T00:00:00Z' } })]
  server.failing = [{ id: 'm1', channel: { source: 'github', thread: 'github:42', address: { number: '42' } },
    text: '已修复', attempts: 4,
    error: 'HTTP 502 from GitHub' }]
  await mount()
  const titles = () => all('.dt-cards .dt-att-what').map(item => item.textContent)
  // The Feishu Source is off, so its error is no problem any more.
  expect(titles()).toEqual([zh.problemNoSource, '评估超时未决定：#9 迟迟未决', '评估未完成：这个文案好奇怪', 'GitHub 回复发送失败（已重试 4 次）'])
  expect(text()).toContain('HTTP 502 from GitHub')
  await click(zh.actionOpenSources)
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.source'])
  await click(tab(zh['tab.overview']))
  await click('评估超时未决定：#9 迟迟未决')
  expect(server.requests.some(request => request.path.startsWith('threads/github:9'))).toBe(true)
})
