#!/usr/bin/env -S node --experimental-transform-types
/** 停机迁移：默认只在 SQLite 一致性副本上预览。 */
import { DatabaseSync, backup } from 'node:sqlite'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import { lockSync } from 'proper-lockfile'
import { Store } from '../src/app/store.ts'
import { migrateLegacyGithub } from '../src/app/project-migration.ts'

const { values } = parseArgs({ options: { 'state-dir': { type: 'string' }, apply: { type: 'boolean', default: false } } })
const stateDir = values['state-dir']
if (!stateDir || !isAbsolute(stateDir)) throw new Error('请使用 --state-dir 指定已有状态目录的绝对路径')
const database = join(stateDir, 'orchestrator.sqlite')
if (!existsSync(database)) throw new Error('状态数据库不存在，拒绝创建空数据库')
const release = lockSync(stateDir, { stale: 30_000 })
const scratch = mkdtempSync(join(tmpdir(), 'superagent-project-migration-'))
let store: Store | undefined
try {
  const snapshot = join(scratch, 'snapshot.sqlite')
  const source = new DatabaseSync(database, { readOnly: true })
  try { await backup(source, snapshot) } finally { source.close() }
  store = new Store(snapshot)
  const plan = migrateLegacyGithub(store)
  store.close(); store = undefined
  if (values.apply && !plan.completed) {
    const backups = join(stateDir, 'backups')
    mkdirSync(backups, { recursive: true, mode: 0o700 })
    const path = join(backups, `before-project-migration-${Date.now()}-${process.pid}.sqlite`)
    copyFileSync(snapshot, path); chmodSync(path, 0o600)
    store = new Store(database)
    const applied = migrateLegacyGithub(store, { dryRun: false })
    process.stdout.write(`${JSON.stringify({ ...applied, backup: path }, null, 2)}\n`)
  } else process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
} finally {
  store?.close()
  rmSync(scratch, { recursive: true, force: true })
  release()
}
