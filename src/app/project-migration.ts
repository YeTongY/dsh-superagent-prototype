/** 显式、可预览的旧 GitHub 项目迁移；失败时整个事务回滚。 */
import type { Store } from './store.ts'
import type { Deployment } from '../deployment.ts'
import type { Trigger } from '../core/index.ts'
import { projectSourceId } from '../project-source.ts'
import { policyVersion, SettingsSchema } from '../policy.ts'
import { KV } from '../kv.ts'

/** One-time attribution of records that predate ProjectSource-aware Feishu intake. */
export function attributeLegacyFeishuTriggers(store: Store, deployment: Deployment): void {
  if (store.get(KV.runtime.feishuProjectAttribution)) return
  if (Object.keys(deployment.projectProblems ?? {}).length) return
  const [project, ...others] = Object.values(deployment.projects ?? {})
  const settings = store.settings(), source = settings.sources.feishu
  const chats = source?.config.chats
  const chat = Array.isArray(chats) && chats.length === 1 ? chats[0] as { chatId?: string; projectSourceId?: string } : undefined
  const group = chat?.projectSourceId ? undefined : chat?.chatId
  const history = store.settingsHistory(Infinity).map(({ settings: past }) => SettingsSchema.parse(past))
  const canAttribute = project && !others.length && source
    && history.every(past => {
      const repositories = Object.entries(past.sources).filter(([id, config]) => {
        const provider = config.kind ?? id
        return (provider === 'github' || provider === 'gitlab') && !!config.config.repository
      })
      return repositories.every(([id, config]) => {
        const provider = config.kind ?? id
        if (id !== project.id || provider !== project.provider) return false
        try { return projectSourceId(project.provider, String(config.config.host || project.host), String(config.config.repository))
          === projectSourceId(project.provider, project.host, project.project) }
        catch { return false }
      })
    })
  const canAttributeGroup = canAttribute && group && history.every(past => {
    const pastChats = past.sources.feishu?.config.chats
    return !Array.isArray(pastChats) || pastChats.every(row => row?.chatId === group && !row.projectSourceId)
  })

  store.atomic(() => {
    if (canAttribute) {
      // Only metadata changes. Keep domain Thread keys, input ids and platform receipts intact.
      const update = store.db.prepare("UPDATE trigger SET value=json_set(value, '$.meta.projectSourceId', ?, '$.meta.projectBindingLegacy', json('true')) WHERE id=?")
      const rows = store.db.prepare(`SELECT id, value FROM trigger WHERE value ->> '$.source' = 'feishu'
        AND value ->> '$.meta.projectSourceId' IS NULL AND value ->> '$.meta.projectBindingError' IS NULL`).all()
      for (const row of rows) {
        const trigger = JSON.parse(String(row.value)) as Trigger
        if (trigger.meta.direct === true ? source.config.directMessages === false : !canAttributeGroup || trigger.meta.chatId !== group) continue
        const conflict = trigger.threads.some(ref => {
          const suffix = /#project:([a-z0-9-]+)$/.exec(ref.id)?.[1]
          const explicit = store.threads.get(`${ref.source}:${ref.id}`)?.meta.projectSourceId
          return ref.source !== 'feishu' || (suffix && suffix !== project.id) || (explicit && explicit !== project.id)
        })
        if (!conflict) update.run(project.id, String(row.id))
      }
    }
    store.set(KV.runtime.feishuProjectAttribution, true)
  })
}

export interface ProjectMigrationPlan { source: string; target: string; records: number; cursors: number; completed: boolean; dryRun: boolean }
export function migrateLegacyGithub(store: Store, options: { dryRun?: boolean } = {}): ProjectMigrationPlan {
  const legacy = store.settings().sources.github
  const completed = store.get<string>('project-migration:github')
  if (completed) return { source: 'github', target: completed, records: 0, cursors: 0, completed: true, dryRun: options.dryRun !== false }
  if (!legacy || typeof legacy.config.repository !== 'string' || !legacy.config.repository) throw new Error('没有可迁移的旧 GitHub 项目配置')
  const target = projectSourceId('github', 'github.com', legacy.config.repository)
  if (store.settings().sources[target]) throw new Error('目标项目已存在，不能覆盖已有状态')
  const ids = new Map(store.db.prepare("SELECT id FROM trigger WHERE value ->> '$.source' = 'github'").all().map(row => [String(row.id), `${target}/${String(row.id)}`]))
  const feishuThread = (value: string) => value.replace(/^((?:feishu:)?oc_[a-zA-Z0-9]+:om_[a-zA-Z0-9_-]+#project:)github$/, `$1${target}`)
  const threads = new Map(store.threads.list().flatMap(thread => {
    if (thread.ref.source === 'github') return [[thread.key, `${target}:${thread.ref.id}`] as const]
    const next = feishuThread(thread.key)
    return thread.ref.source === 'feishu' && next !== thread.key ? [[thread.key, next] as const] : []
  }))
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
  const string = (value: string, field = ''): string => triggerIdFields.has(field) ? ids.get(value) ?? (field === 'id' ? feishuThread(value) : value)
    : threadKeyFields.has(field) ? threads.get(value) ?? (value.startsWith('github:') ? `${target}:${value.slice(7)}` : feishuThread(value)) : value
  const noticeName = (name: string): string => {
    if (name === 'settings:source:github') return `settings:source:${target}`
    return name.startsWith('subscription:') ? `subscription:${string(name.slice('subscription:'.length), 'thread')}` : name
  }
  const rewrite = (value: unknown, field = ''): unknown => {
    if (typeof value === 'string') {
      if (field === 'policyVersion') return policyVersions.get(value) ?? value
      return (field === 'source' || field === 'projectSourceId' || field === 'projectId') && value === 'github' ? target : string(value, field)
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
        const rewritten = rewrite(JSON.parse(String(row.value)))
        const old = String(row[primary]), next = table === 'trigger' || table === 'disposition' ? ids.get(old) ?? old : table === 'thread' ? threads.get(old) ?? old : old
        if (table === 'effect' && row.kind === 'notice') {
          const payload = rewritten as { name?: string; value: Record<string, unknown> }
          const prefix = 'project:github:'
          const key = old.startsWith(prefix) ? `project:${target}:${noticeName(old.slice(prefix.length))}` : noticeName(old)
          if (payload.name) payload.name = noticeName(payload.name)
          if (payload.value.settings_saved === 'source:github') payload.value.settings_saved = `source:${target}`
          if (payload.value.read === 'settings/source:github') payload.value.read = `settings/source:${target}`
          store.db.prepare('UPDATE effect SET key = ?, value = ? WHERE kind = ? AND key = ?').run(key, JSON.stringify(payload), 'notice', old)
        } else if (table === 'effect') store.db.prepare('UPDATE effect SET value = ? WHERE kind = ? AND key = ?').run(JSON.stringify(rewritten), String(row.kind), old)
        else if (table === 'decision') store.db.prepare('UPDATE decision SET value = ?, thread = ? WHERE id = ?').run(JSON.stringify(rewritten), string(String(row.thread), 'thread'), old)
        else store.db.prepare(`UPDATE ${table} SET ${primary} = ?, value = ? WHERE ${primary} = ?`).run(next, JSON.stringify(rewritten), old)
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
