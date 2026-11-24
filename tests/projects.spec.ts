import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, type Candidate, type Ticket } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { githubKind } from '../src/sources/github.ts'
import { issueTrigger, type GithubIssue } from '../src/sources/github-trigger.ts'
import { sourceContextOf } from '../src/app/source-context.ts'
import { environmentLines, ticketEnvironment } from '../src/app/execution-environment.ts'
import { projectSourceId, type ResolvedProject } from '../src/project-source.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { Commands } from '../src/infra/commands.ts'
import { agentVariables, workerBin, workerGitConfig, writeEnvironment } from '../src/infra/environment.ts'
import { KV } from '../src/kv.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { projectPoll } from '../src/sources/poll.ts'
import { Setup } from '../src/app/setup.ts'
import { gitlabKind } from '../src/sources/gitlab.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const exec = promisify(execFile)
const directories: string[] = []
const stores: Store[] = []
let runtimeHost: Host | undefined
const directory = () => { const value = mkdtempSync(join(tmpdir(), 'superagent-projects-')); directories.push(value); return value }
afterEach(async () => { await runtimeHost?.stop(); runtimeHost = undefined; for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })
const issue = (repository = 'acme/one'): GithubIssue => ({ id: 5, number: 5, user: { login: 'alice' }, title: '修复', body: '@agent-bot 修复问题',
  created_at: '2026-11-14T00:00:00Z', html_url: `https://github.com/${repository}/issues/5`, state: 'open' })
function harness() {
  const dir = directory(), store = new Store(join(dir, 'db.sqlite')); stores.push(store)
  const projects = Object.fromEntries(['acme/one', 'acme/two'].map(project => {
    const id = projectSourceId('github', 'github.com', project)
    return [id, { id, provider: 'github', host: 'github.com', project, cli: '/bin/false', login: 'agent-bot', noreply: 'bot@example.com',
      configDir: join(dir, id), environment: { HTTPS_PROXY: 'http://user:password@proxy.internal:3128' } } satisfies ResolvedProject]
  }))
  const ids = Object.keys(projects)
  const settings = SettingsSchema.parse({ sources: Object.fromEntries(Object.values(projects).map(project => [project.id, { kind: project.provider, enabled: true, config: { repository: project.project, cli: project.cli } }])),
    policy: { sources: Object.fromEntries(ids.map(id => [id, { allowed: [{ id: 'alice' }] }])) }, eval: { mode: 'auto' } })
  store.saveSettings(settings)
  const sources = new SourceRegistry(() => store.settings()); sources.register(githubKind)
  const deployment = testDeployment({ stateDir: dir, projects })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const candidates: Candidate[] = []
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: candidate => { candidates.push(candidate) } }, executor: { start: () => {}, deliver: () => {}, stop: () => {} },
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const context = (id: string) => sourceContextOf({ store, engine, commands, sources, deployment, ready: Promise.resolve(), configured: () => true,
    outbox: { send: message => { store.receipts.add(message) } }, receive: trigger => engine.receive(trigger) }, { ...githubKind, id })
  return { dir, store, projects, ids, sources, deployment, commands, engine, candidates, context, settings }
}

describe('项目身份与边界', () => {
  it('规范化 host/项目路径，并按 Provider、host 和完整路径区分身份', () => {
    const id = projectSourceId('gitlab', 'GitLab.Internal', '/Team/Sub/Repo.git/')
    expect(id).toBe(projectSourceId('gitlab', 'gitlab.internal', 'team/sub/repo'))
    expect(id).not.toBe(projectSourceId('gitlab', 'other.internal', 'team/sub/repo'))
    expect(id).not.toBe(projectSourceId('github', 'gitlab.internal', 'team/sub/repo'))
    expect(() => projectSourceId('gitlab', 'https://user:secret@host', 'team/repo')).toThrow()
    expect(() => projectSourceId('gitlab', 'host', 'team/../repo')).toThrow()
  })
  it('项目创建 API 省略 GitLab host 时使用 schema 默认值计算稳定 ID', async () => {
    runtimeHost = await startRuntime()
    runtimeHost.runtime.sources.register(gitlabKind)
    vi.spyOn(Setup.prototype, 'checkAccounts').mockResolvedValue()
    const response = await runtimeHost.api('POST', 'projects', { provider: 'gitlab', config: { repository: 'team/app' } })
    const id = projectSourceId('gitlab', 'gitlab.com', 'team/app')
    expect(response).toMatchObject({ status: 200, body: { id } })
    expect(runtimeHost.runtime.store.settings().sources[id]).toMatchObject({ kind: 'gitlab', enabled: true,
      config: { host: 'gitlab.com', repository: 'team/app' } })
  })
  it('固定 github/gitlab Source ID 只允许从空配置初始化，换仓库必须使用新的 ProjectSource ID', () => {
    let current = SettingsSchema.parse({ sources: {
      github: { enabled: true, config: { repository: '' } },
      gitlab: { enabled: true, config: { repository: '', host: 'gitlab.com' } },
    } })
    const sources = new SourceRegistry(() => current)
    sources.register(githubKind); sources.register(gitlabKind)
    for (const item of [
      { provider: 'github' as const, original: { repository: 'acme/one' }, replacement: { repository: 'acme/two' } },
      { provider: 'gitlab' as const, original: { host: 'gitlab.internal', repository: 'team/one' }, replacement: { host: 'gitlab.internal', repository: 'team/two' } },
    ]) {
      const first = sources.validate(item.provider, { enabled: true, config: item.original })
      current = SettingsSchema.parse({ ...current, sources: { ...current.sources, [item.provider]: first } })
      expect(() => sources.validate(item.provider, { enabled: true, config: item.replacement }))
        .toThrow('不能在固定 Source ID 下替换项目身份')

      const nextId = projectSourceId(item.provider, String(item.replacement.host ?? (item.provider === 'github' ? 'github.com' : 'gitlab.com')),
        String(item.replacement.repository))
      expect(sources.validate(nextId, { kind: item.provider, enabled: true, config: item.replacement }))
        .toMatchObject({ kind: item.provider, enabled: true, config: item.replacement })
    }
  })
  it('同编号 Issue 经过正常 Engine 后分别创建 Thread 和 Ticket，重复事件只在本项目去重', () => {
    const h = harness(), [first, second] = h.ids as [string, string]
    const trigger = issueTrigger(issue(), 'agent-bot')
    expect(h.context(first).receive(trigger)).toBe('stored')
    expect(h.context(first).receive(trigger)).toBe('duplicate')
    expect(h.context(second).receive(trigger)).toBe('stored')
    h.engine.evaluateDue()
    expect(h.candidates).toHaveLength(2)
    for (const candidate of h.candidates) h.engine.decide(candidate.triggers[0]!.id, { evalId: candidate.evalId, kind: 'accept', title: '修复', scope: 'small', reason: 'requested', acknowledgement: '收到' })
    const tickets = h.store.tickets.open()
    expect(tickets).toHaveLength(2)
    expect(h.store.threads.get(`${first}:5`)).toBeDefined()
    expect(h.store.threads.get(`${second}:5`)).toBeDefined()
    expect(h.context(first).tickets.open()).toHaveLength(1)
    expect(h.context(second).tickets.open()).toHaveLength(1)
    const other = tickets.find(ticket => h.store.triggers.get(ticket.origin.triggerId)?.source === second)!
    expect(h.context(first).tickets.get(other.id)).toBeUndefined()
    expect(() => h.context(first).tickets.bindThread(other.id, { source: 'github', id: '5' }, true)).toThrow()
    expect(() => h.context(first).threads.get(`${second}:5`)).toThrow()
  })
  it('隔离游标、策略、账号及 Worker 可见变量，Prompt 不包含代理凭据', () => {
    const h = harness(), [first, second] = h.ids as [string, string]
    h.context(first).state.set(KV.github.cursor(5), 'one')
    h.context(second).state.set(KV.github.cursor(5), 'two')
    expect(h.context(first).state.get(KV.github.cursor(5))).toBe('one')
    expect(h.store.get(KV.github.cursor(5))).toBeUndefined()
    expect(h.context(first).commands.repository).toBe('acme/one')
    expect(h.context(second).commands.repository).toBe('acme/two')
    expect(h.sources.instances()).toHaveLength(2)
    const trigger = { ...issueTrigger(issue(), 'agent-bot'), source: second, threads: [{ source: second, id: '5' }] }
    const variables = ticketEnvironment({ deployment: h.deployment, sources: h.sources, settings: h.settings, ticket: { id: 't', execution: { name: 't', directory: '/tmp/t', assignment: '' } } as Ticket, trigger })
    expect(variables.find(variable => variable.key === 'DSH_SUPERAGENT_GITHUB_REPOSITORY')?.value).toBe('acme/two')
    expect(variables.find(variable => variable.key === 'GH_CONFIG_DIR')?.value).toBe(h.projects[second]!.configDir)
    expect(variables.find(variable => variable.key === 'GIT_CONFIG_GLOBAL')?.value).toBe(workerGitConfig(h.dir, second))
    expect(environmentLines(variables)).not.toContain('password')
    expect(variables.filter(variable => variable.key === 'DSH_SUPERAGENT_GITHUB_REPOSITORY')).toHaveLength(1)
  })
  it('项目不存在时拒绝命令绑定，不回退到另一个账号', () => {
    const h = harness()
    expect(() => h.commands.forSource('github-missing')).toThrow('尚未完成部署检查')
  })
  it('同名账号不能把其他项目的消息附加、订阅或停止本项目工单，拒绝时不部分写入', () => {
    const h = harness(), [first, second] = h.ids as [string, string]
    const raw = issueTrigger(issue(), 'agent-bot')
    h.context(first).receive(raw); h.context(second).receive(raw); h.engine.evaluateDue()
    const one = h.candidates.find(candidate => candidate.thread.ref.source === first)!
    const two = h.candidates.find(candidate => candidate.thread.ref.source === second)!
    h.engine.decide(one.triggers[0]!.id, { evalId: one.evalId, kind: 'accept', title: '修复', scope: 'small', reason: 'requested' })
    const ticket = h.store.tickets.open()[0]!
    const before = JSON.stringify(h.store.tickets.get(ticket.id))
    const denied = { code: 'crossProject', missing: false }
    expect(() => h.engine.attach(ticket.id, two.triggers[0]!.id)).toThrow(expect.objectContaining(denied))
    expect(() => h.engine.followForContext(ticket.id, { source: second, id: '5' })).toThrow(expect.objectContaining(denied))
    expect(() => h.engine.bindThread(ticket.id, { source: second, id: '5' }, true)).toThrow(expect.objectContaining(denied))
    expect(() => h.engine.decide(two.triggers[0]!.id, { evalId: two.evalId, kind: 'stop', ticketId: ticket.id, reason: 'stop' })).toThrow(expect.objectContaining(denied))
    expect(JSON.stringify(h.store.tickets.get(ticket.id))).toBe(before)
    expect(h.store.decisions.byThread(`${second}:5`)).toHaveLength(0)
    expect(h.store.threads.get(`${second}:5`)?.evaluating?.id).toBe(two.evalId)
    expect(h.store.threads.get(`${second}:5`)?.subscriptions).not.toContain(ticket.id)
  })
})

it('Worker shim 在同一 GitLab host 上使用各项目独立配置；Git helper 也不会切到另一个项目账号', async () => {
  const dir = directory(), cli = join(dir, 'fake-glab')
  writeFileSync(cli, '#!/bin/sh\nprintf "%s|%s|%s" "$GLAB_CONFIG_DIR" "$GH_TOKEN" "$GITLAB_TOKEN"\n'); chmodSync(cli, 0o755)
  const projects = Object.fromEntries(['team/one', 'team/two'].map(project => { const id = projectSourceId('gitlab', 'gitlab.internal', project); return [id,
    { id, provider: 'gitlab', host: 'gitlab.internal', project, cli, configDir: join(dir, id), login: 'bot', noreply: 'bot@internal' } satisfies ResolvedProject] }))
  const deployment = testDeployment({ stateDir: dir, projects })
  await writeEnvironment(deployment, [])
  for (const project of Object.values(projects)) {
    const polluted = { ...process.env, ...agentVariables(dir), GH_TOKEN: 'operator-github-token', GITLAB_TOKEN: 'operator-gitlab-token', PATH: `${workerBin(dir)}:/usr/bin:/bin`, DSH_SUPERAGENT_SOURCE: project.id }
    const result = await exec('glab', ['api', 'user'], { env: polluted })
    expect(result.stdout).toBe(`${project.configDir}||`)
    const config = readFileSync(workerGitConfig(dir, project.id), 'utf8')
    expect(config).toContain(project.configDir)
    expect(config).not.toContain(Object.values(projects).find(other => other.id !== project.id)!.configDir)
    const { stdout: helper } = await exec('git', ['config', '--file', workerGitConfig(dir, project.id), '--get', 'credential.https://gitlab.internal.helper'])
    expect((await exec('sh', ['-c', helper.trim().slice(1)], { env: polluted })).stdout).toBe(`${project.configDir}||`)
  }
  await expect(exec('glab', ['api', 'user'], { env: { ...process.env, PATH: `${workerBin(dir)}:/usr/bin:/bin` } })).rejects.toThrow()
})

it('项目轮询最多并行四项，排队公平且取消中的项目不会占住槽位', async () => {
  const started: number[] = [], releases: (() => void)[] = []
  const controller = new AbortController()
  const jobs = Array.from({ length: 5 }, (_, index) => projectPoll(async () => {
    started.push(index)
    await new Promise<void>(resolve => { releases[index] = resolve })
  }, controller.signal))
  const canceled = new AbortController()
  const waiting = projectPoll(async () => { throw new Error('不应执行已取消项目') }, canceled.signal)
  const rejected = expect(waiting).rejects.toThrow()
  canceled.abort(); await rejected
  expect(started).toEqual([0, 1, 2, 3])
  releases[0]!(); await jobs[0]
  expect(started).toEqual([0, 1, 2, 3, 4])
  for (const release of releases) release()
  await Promise.all(jobs)
})
