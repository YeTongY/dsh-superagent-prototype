/** 显式、可预览的旧 GitHub 项目迁移；失败时整个事务回滚。 */
import type { Store } from './store.ts'
import { projectSourceId } from '../project-source.ts'
import { policyVersion, SettingsSchema } from '../policy.ts'
import { KV } from '../kv.ts'

export interface ProjectMigrationPlan { source: string; target: string; records: number; cursors: number; completed: boolean; dryRun: boolean }
export function migrateLegacyGithub(store: Store, options: { dryRun?: boolean } = {}): ProjectMigrationPlan {
  const legacy = store.settings().sources.github
  const completed = store.get<string>('project-migration:github')
  if (completed) return { source: 'github', target: completed, records: 0, cursors: 0, completed: true, dryRun: options.dryRun !== false }
  if (!legacy || typeof legacy.config.repository !== 'string' || !legacy.config.repository) throw new Error('没有可迁移的旧 GitHub 项目配置')
  const target = projectSourceId('github', 'github.com', legacy.config.repository)
  if (store.settings().sources[target]) throw new Error('目标项目已存在，不能覆盖已有状态')
  const ids = new Map(store.db.prepare("SELECT id FROM trigger WHERE value ->> '$.source' = 'github'").all().map(row => [String(row.id), `${target}/${String(row.id)}`]))
  const threads = new Map(store.threads.list().filter(thread => thread.ref.source === 'github').map(thread => [thread.key, `${target}:${thread.ref.id}`]))
  const triggerIdFields = new Set(['id', 'triggerId', 'triggerIds', 'primary', 'pending'])
  const threadKeyFields = new Set(['key', 'thread', 'threadKey', 'correlated'])
  for (const id of ids.values()) if (store.triggers.get(id)) throw new Error(`目标 Trigger 已存在：${id}`)
  for (const key of threads.values()) if (store.threads.get(key)) throw new Error(`目标 Thread 已存在：${key}`)
  const cursors = store.keys('github-')
  for (const key of cursors) if (store.get(`project:${target}:${key}`) !== undefined) throw new Error(`目标 KV 已存在：${key}`)
  const tables = ['trigger', 'disposition', 'thread', 'ticket', 'decision', 'outbox', 'effect'] as const
  const records = tables.reduce((count, table) => count + Number(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n), 0)
  const plan: ProjectMigrationPlan = { source: 'github', target, records, cursors: cursors.length, completed: false, dryRun: options.dryRun !== false }
  if (plan.dryRun) return plan
  const policyVersions = new Map<string, string>()
  const string = (value: string, field = ''): string => triggerIdFields.has(field) ? ids.get(value) ?? value
    : threadKeyFields.has(field) ? threads.get(value) ?? (value.startsWith('github:') ? `${target}:${value.slice(7)}` : value) : value
  const rewrite = (value: unknown, field = ''): unknown => {
    if (typeof value === 'string') {
      if (field === 'policyVersion') return policyVersions.get(value) ?? value
      return field === 'source' && value === 'github' ? target : string(value, field)
    }
    if (Array.isArray(value)) return value.map(item => rewrite(item, field))
    if (!value || typeof value !== 'object') return value
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (field === 'sources' && key === 'github') {
        const source = rewrite(item, key) as Record<string, unknown>
        result[target] = source && 'config' in source ? { ...source, kind: 'github' } : source
      } else result[key] = rewrite(item, key)
    }
    return result
  }
  // Source-key migration changes the authorization hash. Preserve a one-to-one map for every historical policy snapshot so
  // open Mandates, active Evaluations, and Decisions keep referring to the policy that actually authorized them.
  for (const name of store.keys(KV.settings.version.prefix)) {
    const version = store.get<{ policyVersion?: string; settings: unknown }>(name)
    if (!version) continue
    const oldSettings = SettingsSchema.parse(version.settings)
    const nextSettings = SettingsSchema.parse(rewrite(version.settings))
    const oldVersion = version.policyVersion || policyVersion(oldSettings)
    const nextVersion = policyVersion(nextSettings)
    const previous = policyVersions.get(oldVersion)
    if (previous !== undefined && previous !== nextVersion) throw new Error(`策略版本映射不唯一：${oldVersion}`)
    policyVersions.set(oldVersion, nextVersion)
  }
  store.atomic(() => {
    // 先检查所有唯一键再重写，保留 Outbox marker 和外部交付身份。
    for (const table of tables) {
      const primary = table === 'thread' || table === 'effect' ? 'key' : 'id'
      for (const row of store.db.prepare(`SELECT * FROM ${table}`).all()) {
        const value = JSON.stringify(rewrite(JSON.parse(String(row.value))))
        const old = String(row[primary]), next = table === 'trigger' || table === 'disposition' ? ids.get(old) ?? old : table === 'thread' ? threads.get(old) ?? old : old
        if (table === 'effect') store.db.prepare('UPDATE effect SET value = ? WHERE kind = ? AND key = ?').run(value, String(row.kind), old)
        else if (table === 'decision') store.db.prepare('UPDATE decision SET value = ?, thread = ? WHERE id = ?').run(value, string(String(row.thread), 'thread'), old)
        else store.db.prepare(`UPDATE ${table} SET ${primary} = ?, value = ? WHERE ${primary} = ?`).run(next, value, old)
      }
    }
    for (const row of store.db.prepare('SELECT * FROM trigger_thread').all()) store.db.prepare('UPDATE trigger_thread SET thread = ?, id = ? WHERE thread = ? AND id = ?')
      .run(string(String(row.thread), 'thread'), string(String(row.id), 'id'), String(row.thread), String(row.id))
    for (const row of store.db.prepare('SELECT key, value FROM kv').all()) {
      const key = String(row.key)
      const next = key.startsWith('github-') ? `project:${target}:${key}`
        : key === KV.settings.block('source:github') ? KV.settings.block(`source:${target}`)
          : key === KV.sources.labels('github') ? KV.sources.labels(target) : key
      if (next !== key && store.get(next) !== undefined) throw new Error(`目标 KV 已存在：${next}`)
      store.set(next, rewrite(JSON.parse(String(row.value))))
      if (next !== key) store.delete(key)
    }
    store.set('project-migration:github', target)
  })
  return { ...plan, completed: true }
}
