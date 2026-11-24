import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SourceScope, Trigger } from '../src/core/index.ts'
import { Engine } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { attributeLegacyFeishuTriggers, migrateLegacyGithub } from '../src/app/project-migration.ts'
import { KV } from '../src/kv.ts'
import { policyVersion, SettingsSchema, settingsPolicy, type Settings } from '../src/policy.ts'
import { projectSourceId } from '../src/project-source.ts'
import { testDeployment } from './fixtures/deployment.ts'

const directories: string[] = []
const stores: Store[] = []
const directory = () => { const value = mkdtempSync(join(tmpdir(), 'superagent-project-migration-')); directories.push(value); return value }
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function legacyTrigger(number: number, actor = 'alice'): Trigger {
  const thread = { source: 'github', id: String(number) }
  return { id: `github/issue:${number}`, source: 'github', threads: [thread], actor: { source: 'github', id: actor }, human: true,
    addressed: 'mention', at: `2026-11-14T00:00:${String(number).padStart(2, '0')}.000Z`, text: '@agent 请处理',
    channel: { source: 'github', thread: `github:${number}`, address: { repository: 'acme/one', issue: String(number) } },
    meta: { repository: 'acme/one', number } }
}

function projectScope(store: Store): SourceScope {
  return {
    scope: () => ({ listened: true, observed: false, row: 'repository' }),
    project: source => {
      const settings = store.settings()
      const configured = settings.sources[source]
      return configured && (configured.kind ?? source) === 'github' ? source : undefined
    },
  }
}

function engineFor(store: Store, scope: SourceScope, now: () => string): Engine {
  return new Engine({ repo: store, scope, policy: () => settingsPolicy(store.settings(), scope), assessor: { request: () => {} },
    executor: { start: () => {}, deliver: () => {}, stop: () => {} }, outbox: { send: () => {}, status: () => undefined, withdraw: () => {} }, now })
}

describe('旧 GitHub 项目迁移', () => {
  it('一次性补齐只有一个历史仓库和群的旧飞书记录，保持原话题键与消息 ID', () => {
    const dir = directory(), store = new Store(join(dir, 'db.sqlite')); stores.push(store)
    const settings = { sources: { github: { enabled: true, config: { repository: 'acme/one' } },
      feishu: { enabled: true, config: { chats: [{ chatId: 'oc_team', listen: 'all' }] } } } }
    store.saveSettings(settings)
    const old = { ...legacyTrigger(1), id: 'old-feishu', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_team:om_root' }],
      meta: { chatId: 'oc_team', messageId: 'om_root' } }
    const other = { ...old, id: 'unbound-feishu', meta: { ...old.meta, chatId: 'oc_other' } }
    store.triggers.save(old); store.triggers.save(other)
    const deployment = testDeployment({ projects: { github: { id: 'github', provider: 'github', host: 'github.com', project: 'acme/one',
      cli: '/bin/false', login: 'agent', noreply: 'agent@example.com' } } })
    attributeLegacyFeishuTriggers(store, deployment)
    expect(store.triggers.get(old.id)).toEqual({ ...old, meta: { ...old.meta, projectSourceId: 'github', projectBindingLegacy: true } })
    expect(store.triggers.get(other.id)).toEqual(other)
    expect(store.read.threadTriggers('feishu:oc_team:om_root', 10).map(item => item.id)).toContain(old.id)

    const later = { ...old, id: 'later-unattributed-feishu' }
    store.triggers.save(later)
    attributeLegacyFeishuTriggers(store, deployment)
    expect(store.triggers.get(later.id)).toEqual(later)
  })

  it('当前只剩一个项目时仍拒绝归属曾经存在多仓库的未标记旧飞书记录', () => {
    const dir = directory(), store = new Store(join(dir, 'db.sqlite')); stores.push(store)
    const github = { enabled: true, config: { repository: 'acme/one' } }
    const feishu = { enabled: true, config: { chats: [{ chatId: 'oc_team', listen: 'all' }] } }
    const second = projectSourceId('github', 'github.com', 'acme/two')
    store.saveSettings({ sources: { github, feishu, [second]: { kind: 'github', enabled: true, config: { repository: 'acme/two' } } } })
    store.saveSettings({ sources: { github, feishu } })
    const old = { ...legacyTrigger(1), id: 'old-feishu', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_team:om_root' }],
      meta: { chatId: 'oc_team', messageId: 'om_root' } }
    store.triggers.save(old)
    const deployment = testDeployment({ projects: { github: { id: 'github', provider: 'github', host: 'github.com', project: 'acme/one',
      cli: '/bin/false', login: 'agent', noreply: 'agent@example.com' } } })
    attributeLegacyFeishuTriggers(store, deployment)
    expect(store.triggers.get(old.id)).toEqual(old)
  })

  it('迁移飞书绑定和待投递项目，同时保留飞书消息与回执的 ID', () => {
    const dir = directory(), store = new Store(join(dir, 'db.sqlite')); stores.push(store)
    store.saveSettings({ sources: { github: { enabled: true, config: { repository: 'acme/one', cli: '/bin/false' } },
      feishu: { enabled: true, config: { chats: [{ chatId: 'oc_team', listen: 'all', projectSourceId: 'github' }] } } } })
    const thread = { source: 'feishu', id: 'oc_team:om_root#project:github' }
    const trigger = { ...legacyTrigger(1), id: 'feishu-message', source: 'feishu', actor: { source: 'feishu', id: 'ou_alice' },
      threads: [thread], channel: { source: 'feishu', thread: 'feishu:oc_team', address: { chatId: 'oc_team', messageId: 'om_root' } },
      meta: { projectSourceId: 'github', chatId: 'oc_team', messageId: 'om_root' } }
    store.triggers.save(trigger)
    store.threads.save({ key: `feishu:${thread.id}`, ref: thread, pending: [trigger.id], subscriptions: [], correlated: [], createdAt: trigger.at,
      meta: { projectSourceId: 'github' } })
    store.receipts.add({ id: 'feishu-reply', channel: trigger.channel, text: '收到', kind: 'reply' })
    const insert = store.db.prepare('INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?)')
    insert.run('relay', 'relay-id', JSON.stringify({ text: trigger.text, projectId: 'github' }), 1, 0, trigger.at)
    insert.run('notice', 'subscription:github:5', JSON.stringify({ value: { subscription_changes: [{ thread: 'github:5', removed: true }] }, summary: '已取消订阅' }), 2, 0, trigger.at)
    insert.run('notice', 'project:github:settings:source:github', JSON.stringify({ name: 'settings:source:github', projectId: 'github',
      value: { settings_saved: 'source:github', read: 'settings/source:github' }, summary: '设置已保存' }), 3, 0, trigger.at)

    const { target } = migrateLegacyGithub(store, { dryRun: false })
    const migrated = store.triggers.get(trigger.id)
    const threadKey = `feishu:oc_team:om_root#project:${target}`
    expect(store.settings().sources.feishu?.config.chats).toEqual([{ chatId: 'oc_team', listen: 'all', projectSourceId: target }])
    expect(migrated).toMatchObject({ id: trigger.id, channel: trigger.channel, meta: { projectSourceId: target },
      threads: [{ source: 'feishu', id: `oc_team:om_root#project:${target}` }] })
    expect(store.threads.get(threadKey)).toMatchObject({ pending: [trigger.id], meta: { projectSourceId: target } })
    expect(store.read.threadTriggers(threadKey, 10).map(item => item.id)).toEqual([trigger.id])
    expect(store.receipts.get('feishu-reply')).toMatchObject({ id: 'feishu-reply', channel: trigger.channel })
    expect(store.db.prepare('SELECT value FROM effect WHERE kind = ? AND key = ?').get('relay', 'relay-id')?.value)
      .toBe(JSON.stringify({ text: trigger.text, projectId: target }))
    const notices = store.db.prepare("SELECT key, value FROM effect WHERE kind = 'notice' ORDER BY seq").all()
    expect(notices.map(row => [row.key, JSON.parse(String(row.value))])).toEqual([
      [`subscription:${target}:5`, { value: { subscription_changes: [{ thread: `${target}:5`, removed: true }] }, summary: '已取消订阅' }],
      [`project:${target}:settings:source:${target}`, { name: `settings:source:${target}`, projectId: target,
        value: { settings_saved: `source:${target}`, read: `settings/source:${target}` }, summary: '设置已保存' }],
    ])
  })

  it('只读预览，并原子迁移来源、Trigger、Thread、Outbox marker 和游标，再次运行保持幂等', () => {
    const dir = directory(), store = new Store(join(dir, 'db.sqlite')); stores.push(store)
    store.saveSettings({ sources: { github: { enabled: true, config: { repository: 'acme/one', cli: '/bin/false' } } },
      policy: { sources: { github: { allowed: [{ id: 'alice' }] } } } })
    const trigger = { ...legacyTrigger(5), text: 'github: 这是原始请求内容，source:github 也不应被改写' }
    store.triggers.save(trigger)
    store.threads.save({ key: 'github:5', ref: { source: 'github', id: '5' }, pending: [trigger.id], subscriptions: [], correlated: [], createdAt: trigger.at, meta: {} })
    store.receipts.add({ id: 'existing-platform-marker', channel: trigger.channel!, text: '收到', kind: 'reply' })
    store.set(KV.github.cursor(5), trigger.at)
    store.set(KV.settings.block('source:github'), 3)
    store.set(KV.sources.labels('github'), { acme: 'Acme' })
    const before = store.db.prepare('SELECT * FROM kv ORDER BY key').all()
    const plan = migrateLegacyGithub(store)
    expect(plan.dryRun).toBe(true)
    expect(store.db.prepare('SELECT * FROM kv ORDER BY key').all()).toEqual(before)

    const applied = migrateLegacyGithub(store, { dryRun: false })
    const target = applied.target
    expect(store.triggers.get(`${target}/${trigger.id}`)?.source).toBe(target)
    expect(store.triggers.get(`${target}/${trigger.id}`)?.text).toBe(trigger.text)
    expect(store.threads.get(`${target}:5`)?.pending).toEqual([`${target}/${trigger.id}`])
    expect(store.read.threadTriggers(`${target}:5`, 10)).toHaveLength(1)
    expect(store.settings().sources[target]?.kind).toBe('github')
    expect(store.settings().policy.sources[target]?.allowed).toEqual([{ id: 'alice' }])
    expect(store.get(`project:${target}:github-cursor:5`)).toBe(trigger.at)
    expect(store.get(KV.settings.block(`source:${target}`))).toBe(3)
    expect(store.get(KV.sources.labels(target))).toEqual({ acme: 'Acme' })
    expect(store.get(KV.settings.block('source:github'))).toBeUndefined()
    expect(store.get(KV.sources.labels('github'))).toBeUndefined()
    expect(store.receipts.get('existing-platform-marker')).toMatchObject({ id: 'existing-platform-marker', channel: { source: target }, text: '收到', status: 'pending' })
    expect(migrateLegacyGithub(store, { dryRun: false }).completed).toBe(true)
    expect(store.triggers.get(trigger.id)).toBeUndefined()
  })

  it('发生 SQLite 写入失败时回滚所有已改写记录', () => {
    const dir = directory(), store = new Store(join(dir, 'db.sqlite')); stores.push(store)
    store.saveSettings({ sources: { github: { enabled: true, config: { repository: 'acme/one', cli: '/bin/false' } } } })
    const trigger = legacyTrigger(5); store.triggers.save(trigger)
    store.set(KV.github.cursor(5), 'old')
    store.db.exec("CREATE TRIGGER migration_failure BEFORE UPDATE OF value ON kv WHEN OLD.key = 'settings-version:1' BEGIN SELECT RAISE(ABORT, 'forced failure'); END")
    expect(() => migrateLegacyGithub(store, { dryRun: false })).toThrow('forced failure')
    expect(store.triggers.get(trigger.id)).toBeDefined()
    expect(store.settings().sources.github).toBeDefined()
    expect(store.get('project-migration:github')).toBeUndefined()
  })

  it('按每个历史设置版本重算策略哈希，保留 Mandate 和活动 Eval 的可恢复性', () => {
    const dir = directory(), store = new Store(join(dir, 'db.sqlite')); stores.push(store)
    const firstSettings = SettingsSchema.parse({ sources: { github: { enabled: true, config: { repository: 'acme/one', cli: '/bin/false' } } },
      policy: { sources: { github: { allowed: [{ id: 'alice' }] } } }, eval: { mode: 'auto' } })
    store.saveSettings(firstSettings, { source: 'internal', policyVersion: policyVersion(firstSettings), policyChanged: true, notified: [] })
    const scope = projectScope(store)
    let tick = 0
    const now = () => `2026-11-14T00:01:${String(tick++).padStart(2, '0')}.000Z`
    const engine = engineFor(store, scope, now)
    const alice = legacyTrigger(5)
    engine.receive(alice); engine.evaluateDue()
    const aliceEval = engine.candidate(alice.id)!
    const accepted = engine.decide(alice.id, { evalId: aliceEval.evalId, kind: 'accept', title: '修复', scope: 'small', reason: 'requested' })
    const ticket = store.tickets.get(accepted.ticketId!)!

    const secondSettings = SettingsSchema.parse({ ...firstSettings,
      policy: { ...firstSettings.policy, sources: { github: { allowed: [{ id: 'alice' }, { id: 'bob' }] } } } })
    store.saveSettings(secondSettings, { source: 'panel', block: 'policy', policyVersion: policyVersion(secondSettings), policyChanged: true, notified: [] })
    const bob = legacyTrigger(6, 'bob')
    engine.receive(bob); engine.evaluateDue()
    const bobEval = engine.candidate(bob.id)!
    const target = projectSourceId('github', 'github.com', 'acme/one')
    const migratedSettings = (settings: Settings) => {
      const { github: source, ...otherSources } = settings.sources
      const { github: policy, ...otherPolicies } = settings.policy.sources
      return SettingsSchema.parse({ ...settings, sources: { ...otherSources, [target]: { ...source, kind: 'github' } },
        policy: { ...settings.policy, sources: { ...otherPolicies, [target]: policy } } })
    }
    const firstVersion = policyVersion(migratedSettings(firstSettings))
    const secondVersion = policyVersion(migratedSettings(secondSettings))
    const decision = store.decisions.get(accepted.id)!

    expect(migrateLegacyGithub(store, { dryRun: false }).completed).toBe(true)
    const migratedTicket = store.tickets.get(ticket.id)!
    const migratedBob = store.triggers.get(`${target}/${bob.id}`)!
    const migratedEval = store.threads.get(`${target}:6`)!.evaluating!
    const migratedDecision = store.decisions.get(decision.id)!
    const history = store.settingsHistory()
    expect(history.find(version => version.revision === 1)?.policyVersion).toBe(firstVersion)
    expect(history.find(version => version.revision === 2)?.policyVersion).toBe(secondVersion)
    expect(migratedTicket.mandate.policyVersion).toBe(firstVersion)
    expect(migratedDecision.policyVersion).toBe(firstVersion)
    expect(migratedDecision.mandate?.policyVersion).toBe(firstVersion)
    expect(migratedEval.policyVersion).toBe(secondVersion)
    expect(settingsPolicy(store.settings(), scope).revalidate(migratedTicket.mandate)).toBe(true)

    // 迁移中断后由新的 Engine 恢复旧 Eval；无效的旧 hash 会导致 policyChanged 并丢弃活动评估。
    const restored = engineFor(store, scope, now)
    const restoredCandidate = restored.candidate(migratedBob.id)!
    expect(restoredCandidate.evalId).toBe(bobEval.evalId)
    const continued = restored.decide(migratedBob.id, { evalId: restoredCandidate.evalId, kind: 'accept', title: '继续', scope: 'small', reason: 'requested' })
    expect(store.decisions.get(continued.id)?.kind).toBe('accept')
  })
})
