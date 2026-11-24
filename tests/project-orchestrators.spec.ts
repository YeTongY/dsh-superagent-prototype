import { afterEach, expect, it, vi } from 'vitest'
import { projectOrchestratorSessionId } from '../src/app/sessions.ts'
import { key } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { KV } from '../src/kv.ts'
import type { Settings } from '../src/policy.ts'
import { projectSourceId, projectTrigger } from '../src/project-source.ts'
import { githubKind } from '../src/sources/github.ts'
import { feishu, github, startRuntime, type Host } from './fixtures/host.ts'

const projects = [
  { repository: 'acme/one', chatId: 'oc_one' },
  { repository: 'acme/two', chatId: 'oc_two' },
].map(project => {
  const id = projectSourceId('github', 'github.com', project.repository)
  return { ...project, id, sessionId: projectOrchestratorSessionId(id) }
})
const [one, two] = projects as [typeof projects[number], typeof projects[number]]

function configure(settings: Settings): Settings {
  const githubAccount = settings.sources.github!.config, feishuConfig = settings.sources.feishu!.config
  return { ...settings,
    sources: { feishu: { enabled: true, config: { ...feishuConfig, otherChats: 'mentions', chats: projects.map(project => ({
      chatId: project.chatId, projectSourceId: project.id, listen: 'all',
    })) } }, ...Object.fromEntries(projects.map(project => [project.id, {
      kind: 'github', enabled: true, config: { ...githubAccount, repository: project.repository },
    }])) },
    policy: { ...settings.policy, sources: { feishu: { ...settings.policy.sources.feishu!, syncChat: '' },
      ...Object.fromEntries(projects.map(project => [project.id, settings.policy.sources.github!])) } },
  }
}

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })

it('routes repositories and their Feishu groups to independent project sessions and replies in the original topic', async () => {
  host = await startRuntime(store => store.set(KV.runtime.masterId, 'orchestrator-legacy'), configure)
  const { runtime } = host
  expect(await host.api('GET', 'state')).toMatchObject({ body: { project_orchestrators: expect.arrayContaining(projects.map(project =>
    expect.objectContaining({ project_source_id: project.id, session_id: project.sessionId, repository: project.repository, ready: true }))) } })
  const chatOne = feishu('11', '请看看仓库一', { chat_id: one.chatId })
  const chatTwo = feishu('21', '请看看仓库二', { chat_id: two.chatId })
  const issue = github('30', '@agent-bot 请检查 Issue')
  const oneIssue = projectTrigger(issue, one.id), twoIssue = projectTrigger(issue, two.id)

  for (const project of projects) {
    const source = runtime.context({ ...githubKind, id: project.id })
    expect(await source.receive(issue)).toBe('stored')
  }
  expect(runtime.receive({ ...chatOne, meta: { ...chatOne.meta, projectSourceId: two.id } })).toBe('stored')
  expect(runtime.receive(chatTwo)).toBe('stored')
  expect(runtime.receive(chatOne)).toBe('duplicate')
  expect(runtime.receive(feishu('31', '未绑定的群', { chat_id: 'oc_unbound' }))).toBe('filtered')
  expect(runtime.receive(feishu('32', '私聊请求', { chat_id: 'oc_dm', chat_type: 'p2p' }))).toBe('filtered')
  await runtime.idle()

  expect(host.candidates(one.sessionId).sort()).toEqual([oneIssue.id, chatOne.id].sort())
  expect(host.candidates(two.sessionId).sort()).toEqual([twoIssue.id, chatTwo.id].sort())
  expect(host.candidates('orchestrator-legacy')).toEqual([])
  expect(runtime.store.triggers.get(chatOne.id)?.meta.projectSourceId).toBe(one.id)
  expect(runtime.store.triggers.get(chatTwo.id)?.meta.projectSourceId).toBe(two.id)
  await expect(host.runTool(one.sessionId, 'orchestrator_read', { resource: `trigger/${oneIssue.id}` }))
    .resolves.toMatchObject({ trigger_id: oneIssue.id })
  await expect(host.runTool(one.sessionId, 'orchestrator_read', { resource: `trigger/${twoIssue.id}` })).rejects.toThrow()

  const blocked = await host.runTool(one.sessionId, 'orchestrator_route', { decisions: [{
    kind: 'accept', trigger_id: chatTwo.id, title: '越界请求', worktree_name: 'foreign', acknowledgement: '不应发送',
  }] })
  expect(blocked.results).toEqual([expect.objectContaining({ refused: expect.any(String) })])
  expect(runtime.store.tickets.list()).toEqual([])
  await expect(host.runTool(one.sessionId, 'orchestrator_read', { resource: `trigger/${chatTwo.id}` })).rejects.toThrow()
  await expect(host.runTool(one.sessionId, 'orchestrator_reply', { trigger_id: chatTwo.id, purpose: 'answer', text: '不应发送' })).rejects.toThrow()

  expect(await host.runTool(one.sessionId, 'orchestrator_reply', { trigger_id: chatOne.id, purpose: 'answer', text: '仓库一已核对。' }))
    .toMatchObject({ status: 'sent' })
  expect(await host.runTool(two.sessionId, 'orchestrator_reply', { trigger_id: chatTwo.id, purpose: 'answer', text: '仓库二已核对。' }))
    .toMatchObject({ status: 'sent' })
  const replies = vi.mocked(Commands.prototype.lark).mock.calls.map(([args]) => args).filter(args => args.includes('+messages-reply'))
  expect(replies).toEqual(expect.arrayContaining([
    expect.arrayContaining(['--message-id', 'om_11', '--markdown', '仓库一已核对。', '--reply-in-thread']),
    expect.arrayContaining(['--message-id', 'om_21', '--markdown', '仓库二已核对。', '--reply-in-thread']),
  ]))
  expect(replies.flat()).not.toContain('不应发送')
})

it('restores the same project sessions after a Runtime restart and keeps work bound to its project', async () => {
  host = await startRuntime(undefined, configure)
  const before = host.runtime
  const request = feishu('11', '请修正页面标题。', { chat_id: one.chatId })
  expect(before.receive(request)).toBe('stored')
  await before.idle()
  const result = await host.route({ kind: 'accept', trigger_id: request.id, title: '修正页面标题', worktree_name: 'fix-title',
    acknowledgement: '收到，修正页面标题。' }, one.sessionId)
  await before.idle()
  const ticketId = (result.ticket as { ticket_id: string }).ticket_id
  expect(before.store.replyStatus(key('ack', request.id))).toBe('sent')
  const other = feishu('21', '仓库二的讨论', { chat_id: two.chatId })
  expect(before.receive(other)).toBe('stored')
  await before.idle()
  const thread = before.store.triggers.get(other.id)!.threads[0]!
  await expect(host.runTool(`worker-${ticketId}`, 'orchestrator_thread_follow', { thread: `${thread.source}:${thread.id}`, reason: '越界引用' }))
    .rejects.toMatchObject({ code: 'crossProject' })
  const originalSessions = projects.map(project => host!.agents.get(project.sessionId))
  expect(originalSessions.every(Boolean)).toBe(true)

  const after = await host.restart()
  for (const [index, project] of projects.entries()) expect(host.agents.get(project.sessionId)).toBe(originalSessions[index])
  expect(after.store.tickets.get(ticketId)?.origin.triggerId).toBe(request.id)
  expect(after.receive(request)).toBe('duplicate')
  await expect(host.runTool(two.sessionId, 'orchestrator_read', { resource: `ticket/${ticketId}` })).rejects.toThrow()

  const followup = feishu('12', '能告诉我进度吗？', { chat_id: one.chatId, root_id: 'om_11' })
  expect(after.receive(followup)).toBe('stored')
  await after.idle()
  expect(host.candidates(one.sessionId)).toContain(followup.id)
  expect(host.candidates(two.sessionId)).not.toContain(followup.id)
  expect(after.store.triggers.disposition(followup.id)?.fanout ?? []).toEqual([])
  expect(vi.mocked(Commands.prototype.lark).mock.calls.filter(([args]) => args.includes('收到，修正页面标题。'))).toHaveLength(1)
})

it('delivers another project’s notifications while the first project retries its delivery', async () => {
  host = await startRuntime(undefined, configure)
  const runtime = host.runtime
  const blocked = host.agents.get(one.sessionId)!
  blocked.steer.mockImplementationOnce(() => { throw new Error('项目会话暂时不可用') })
  runtime.sessions.relay('first-project-update', JSON.stringify({ update: '仅仓库一' }), one.id)
  runtime.sessions.relay('second-project-update', JSON.stringify({ update: '仅仓库二' }), two.id)
  await runtime.idle()

  expect(host.relays(one.sessionId)).toEqual([])
  expect(host.relays(two.sessionId)).toEqual([{ update: '仅仓库二' }])
  expect(runtime.effects.pending('relay', 'first-project-update')).toBe(true)
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3000 })
  try { await runtime.pump(); await runtime.idle() } finally { vi.useRealTimers() }
  expect(host.relays(one.sessionId)).toEqual([{ update: '仅仓库一' }])
  expect(host.relays(two.sessionId)).toEqual([{ update: '仅仓库二' }])
})

it('keeps a reassigned Feishu group from receiving a previous project’s queued reply', async () => {
  host = await startRuntime(undefined, configure)
  const { runtime } = host
  const original = feishu('11', '仓库一的原始请求', { chat_id: one.chatId })
  expect(runtime.receive(original)).toBe('stored')
  await runtime.idle()
  await runtime.settings.pause(true, 'panel')
  const message = { id: 'old-project-reply', kind: 'reply' as const, channel: original.channel!, text: '仓库一的处理结果' }
  runtime.outbox.send(message)
  expect(runtime.store.replyStatus(message.id)).toBe('pending')
  const source = runtime.store.settings().sources.feishu!
  const updated = { ...source, config: { ...source.config, chats: [
    { chatId: one.chatId, projectSourceId: two.id, listen: 'all' },
    { chatId: two.chatId, projectSourceId: one.id, listen: 'all' },
  ] } }
  expect(await host.api('PUT', 'settings/source:feishu', { value: updated, revision: runtime.store.blockRevision('source:feishu') }))
    .toMatchObject({ status: 200 })
  const oldTopic = feishu('12', '旧话题续接', { chat_id: one.chatId, root_id: 'om_11' })
  const newTopic = feishu('13', '现在的项目请求', { chat_id: one.chatId })
  expect(runtime.receive(oldTopic)).toBe('filtered')
  expect(runtime.receive(newTopic)).toBe('stored')
  await runtime.settings.pause(false, 'panel')
  await runtime.idle()

  expect(runtime.store.replyStatus(message.id)).toBe('dropped')
  expect(runtime.store.receipts.get(message.id)?.dropped?.reason).toBe('projectBindingChanged')
  expect(vi.mocked(Commands.prototype.lark).mock.calls.some(([args]) => args.includes(message.text))).toBe(false)
  expect(runtime.store.triggers.get(original.id)?.meta.projectSourceId).toBe(one.id)
  expect(host.candidates(one.sessionId)).not.toContain(oldTopic.id)
  expect(host.candidates(two.sessionId)).not.toContain(oldTopic.id)
  expect(host.candidates(two.sessionId)).toContain(newTopic.id)
  const opened = await host.runTool(two.sessionId, 'orchestrator_read', {
    resource: `feishu/${newTopic.id}/thread`, limit: 8000,
  })
  expect(JSON.parse(String(opened.text))).toMatchObject({ status: 'available', messages: [{ id: 'om_13', text: newTopic.text }] })
})
