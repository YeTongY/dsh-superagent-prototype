import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import type { OutboundMessage, ThreadRef, Ticket, Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf } from '../src/app/source-context.ts'
import { Commands } from '../src/infra/commands.ts'
import { deploymentForSource, type ResolvedProject } from '../src/project-source.ts'
import { projectSourceId } from '../src/project-source.ts'
import { KV } from '../src/kv.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { testDeployment } from './fixtures/deployment.ts'

const directories: string[] = []
const stores: Store[] = []
const directory = () => { const value = mkdtempSync(join(tmpdir(), 'superagent-project-context-')); directories.push(value); return value }
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function kind(id: string, used: Record<string, string | undefined>): SourceKind<{ repository: string }> {
  return { kind: id, title: { zh: id, en: id }, description: { zh: id, en: id }, schema: z.object({ repository: z.string() }), fields: [], health: [],
    channel: { send: async ({ commands }) => { used.send = commands.deployment.activeProject?.id; return 'sent' },
      link: () => ({ url: '', label: { zh: id, en: id } }) },
    threadContext: { messageId: trigger => trigger.id, read: async commands => ({ messages: [], body: { project: commands.deployment.activeProject?.id } }) } }
}

function trigger(source: string, id: string): Trigger {
  return { id, source, threads: [{ source, id: '5' }], actor: { source, id: 'alice' }, human: true,
    at: '2026-11-14T00:00:00.000Z', text: '请求', channel: { source, thread: `${source}:5`, address: {} }, meta: {} }
}

function ticket(trigger: Trigger): Ticket {
  return { id: `ticket-${trigger.id}`, title: '工作', decisionId: `decision-${trigger.id}`,
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'addressed', source: trigger.source, scope: {}, addressed: 'mention' },
      actor: trigger.actor, scope: 'request' }, channels: [trigger.channel!], assignments: [], inputs: [], undelivered: [], createdAt: trigger.at,
    updatedAt: trigger.at, origin: { triggerId: trigger.id, triggerIds: [trigger.id] } }
}

it('隔离旧 GitHub 与 provider 同名 GitLab 项目，并绑定命令、线程读取和回复到正确项目', async () => {
  const dir = directory(), store = new Store(join(dir, 'db.sqlite')); stores.push(store)
  const gitlabHash = projectSourceId('gitlab', 'gitlab.internal', 'team/another')
  store.saveSettings({ sources: {
    github: { enabled: true, config: { repository: 'acme/one' } },
    gitlab: { enabled: true, config: { host: 'gitlab.internal', repository: 'team/one' } },
    [gitlabHash]: { kind: 'gitlab', enabled: true, config: { host: 'gitlab.internal', repository: 'team/another' } },
  } })
  const projects: Record<string, ResolvedProject> = {
    github: { id: 'github', provider: 'github', host: 'github.com', project: 'acme/one', cli: '/bin/false', login: 'bot', noreply: 'bot@github.test' },
    gitlab: { id: 'gitlab', provider: 'gitlab', host: 'gitlab.internal', project: 'team/one', cli: '/bin/false', login: 'bot', noreply: 'bot@gitlab.test' },
    [gitlabHash]: { id: gitlabHash, provider: 'gitlab', host: 'gitlab.internal', project: 'team/another', cli: '/bin/false', login: 'bot', noreply: 'bot@gitlab.test' },
  }
  const deployment = testDeployment({ stateDir: dir, projects })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const registry = new SourceRegistry(() => store.settings())
  const githubUsed: Record<string, string | undefined> = {}, gitlabUsed: Record<string, string | undefined> = {}
  registry.register(kind('github', githubUsed)); registry.register(kind('gitlab', gitlabUsed))
  const deps = { store, outbox: { send: (message: OutboundMessage) => { store.receipts.add(message) } }, engine: {
    bindThread: (_id: string, _thread: ThreadRef, _own: boolean) => ticket(legacyTrigger),
    threadClosed: (_thread: ThreadRef, _outcome: 'merged' | 'closed', _at: string) => {},
  },
    commands, sources: registry, deployment, ready: Promise.resolve(), configured: () => true, receive: () => 'stored' as const }
  const github = sourceContextOf(deps, { kind: 'github', health: [], id: 'github' })
  const gitlab = sourceContextOf(deps, { kind: 'gitlab', health: [], id: 'gitlab' })
  const anotherGitlab = sourceContextOf(deps, { kind: 'gitlab', health: [], id: gitlabHash })
  const legacyTrigger = trigger('github', 'github:issue:5')
  const gitlabTrigger = trigger('gitlab', 'gitlab:issue:5')
  const reporterTrigger = trigger(gitlabHash, 'reporter:scenario:1')
  for (const item of [legacyTrigger, gitlabTrigger, reporterTrigger]) { store.triggers.save(item); store.tickets.save(ticket(item)) }

  expect(github.deployment.activeProject?.id).toBe('github')
  expect(github.commands.deployment.activeProject?.id).toBe('github')
  expect(gitlab.deployment.activeProject?.id).toBe('gitlab')
  expect(gitlab.commands.deployment.activeProject?.id).toBe('gitlab')
  expect(github.tickets.open().map(item => item.id)).toEqual([`ticket-${legacyTrigger.id}`])
  expect(gitlab.tickets.open().map(item => item.id)).toEqual([`ticket-${gitlabTrigger.id}`])
  expect(github.tickets.get(`ticket-${legacyTrigger.id}`)?.channels[0]?.source).toBe('github')
  expect(gitlab.tickets.get(`ticket-${gitlabTrigger.id}`)?.channels[0]?.source).toBe('gitlab')
  expect(github.triggers.get(gitlabTrigger.id)).toBeUndefined()
  expect(gitlab.triggers.get(legacyTrigger.id)).toBeUndefined()
  expect(anotherGitlab.triggers.get(reporterTrigger.id)?.id).toBe(reporterTrigger.id)
  expect(anotherGitlab.triggers.get(gitlabTrigger.id)).toBeUndefined()

  store.set(KV.github.cursor(5), 'legacy-cursor')
  expect(github.state.get(KV.github.cursor(5))).toBe('legacy-cursor')
  expect(gitlab.state.get(KV.github.cursor(5))).toBeUndefined()
  gitlab.state.set(KV.github.cursor(5), 'gitlab-cursor')
  expect(store.get(`project:gitlab:${KV.github.cursor(5)}`)).toBe('gitlab-cursor')

  await registry.send({ id: 'reply-gitlab', channel: gitlabTrigger.channel!, text: '回复', kind: 'reply' }, commands)
  expect(gitlabUsed.send).toBe('gitlab')
  const context = registry.threadContext(gitlabTrigger)
  expect((await context!.read(commands, 'thread')).body.project).toBe('gitlab')
})

it('项目注册表存在时缺失的 legacy github 身份拒绝回退到首个项目', () => {
  const gitlab: ResolvedProject = { id: 'gitlab', provider: 'gitlab', host: 'gitlab.internal', project: 'team/one', cli: '/bin/false', login: 'bot', noreply: 'bot@gitlab.test' }
  const deployment = testDeployment({ projects: { gitlab } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  expect(() => commands.forSource('github')).toThrow('项目尚未完成部署检查：github')
  expect(() => deploymentForSource(deployment, 'github')).toThrow('项目尚未完成部署检查：github')
  expect(commands.forSource('feishu')).toBe(commands)
  expect(deploymentForSource(deployment, 'feishu')).toBe(deployment)

  const legacy = testDeployment()
  const legacyCommands = new Commands(() => legacy, {}, new AbortController().signal)
  expect(legacyCommands.forSource('github')).toBe(legacyCommands)
  expect(deploymentForSource(legacy, 'github')).toBe(legacy)
})
