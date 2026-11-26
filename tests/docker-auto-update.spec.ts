/** Tests for scripts/docker-auto-update using a temporary deployment dir, stubbed docker CLI, and mock state HTTP server. */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

let root: string
let server: Server | undefined
let holders: ChildProcess[] = []
let stateByImage: Record<string, { state: string; running: number }>

const IMAGE = 'ghcr.io/owner/dsh-superagent-prototype:edge'
const binDir = () => join(root, 'bin')
const stateDir = () => join(root, 'fake-docker')
const dataDir = () => join(root, 'shared', 'data')
const backupDir = () => join(root, 'shared', 'backups')
const composeFile = () => join(root, 'release', 'compose.yaml')

function writeDockerStub() {
  const script = `#!/usr/bin/env python3
import os, sys
from pathlib import Path

state = Path(${JSON.stringify(stateDir())})
log = state / 'docker.log'
args = sys.argv[1:]
with log.open('a', encoding='utf-8') as f:
    f.write(' '.join(args) + '\\n')

def read(name, default=''):
    p = state / name
    return p.read_text(encoding='utf-8').strip() if p.exists() else default

def write(name, val):
    (state / name).write_text(val, encoding='utf-8')

if not args:
    sys.exit(2)

cmd = args[0]
if cmd == 'pull':
    if read('fail-pull') == '1':
        sys.stderr.write('pull denied\\n')
        sys.exit(1)
    write('pulled-id', read('remote-id'))
    sys.exit(0)

if cmd == 'image' and len(args) >= 2 and args[1] == 'inspect':
    target = args[-1]
    if target == ${JSON.stringify(IMAGE)}:
        print(read('pulled-id') or read('remote-id'))
        sys.exit(0)
    print(read('current-id'))
    sys.exit(0)

if cmd == 'inspect':
    cur = read('current-id')
    running = read('running', 'false')
    if not cur:
        sys.exit(1)
    print(f'{cur} {running}')
    sys.exit(0)

if cmd == 'image' and len(args) >= 2 and args[1] == 'tag':
    src, tag = args[-2], args[-1]
    existing = read('rollback-tags').splitlines() if read('rollback-tags') else []
    if tag not in existing:
        existing.append(tag)
        write('rollback-tags', '\\n'.join(existing) + '\\n')
    write(f'tag:{tag}', src)
    sys.exit(0)

if cmd == 'images':
    for line in read('rollback-tags').splitlines():
        if line.strip():
            print(line.strip())
    sys.exit(0)

if cmd == 'rmi':
    tag = args[-1]
    tags = [line for line in read('rollback-tags').splitlines() if line.strip() and line.strip() != tag]
    write('rollback-tags', ('\\n'.join(tags) + '\\n') if tags else '')
    sys.exit(0)

if cmd == 'compose':
    img = os.environ.get('DSH_SUPERAGENT_IMAGE', '')
    with log.open('a', encoding='utf-8') as f:
        f.write(f'compose-env DSH_SUPERAGENT_IMAGE={img}\\n')
    if 'down' in args:
        write('running', 'false')
        sys.exit(0)
    if 'up' in args:
        if img.startswith('dsh-superagent:rollback-'):
            write('current-id', read(f'tag:{img}') or read('previous-id'))
        else:
            write('current-id', read('pulled-id') or read('remote-id'))
        write('running', 'true')
        sys.exit(0)

sys.stderr.write(f'unexpected docker args: {args}\\n')
sys.exit(2)
`
  writeFileSync(join(binDir(), 'docker'), script, { mode: 0o755 })
}

function runScript(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile('python3', [join(root, 'release', 'scripts', 'docker-auto-update'), ...args], {
      env: { ...process.env, PATH: `${binDir()}:${process.env.PATH}`, ...env },
      timeout: 20_000,
    }, (error, stdout, stderr) => resolve({
      code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr,
    }))
  })
}

async function startStateServer(): Promise<string> {
  server = createServer((_req, res) => {
    const idFile = join(stateDir(), 'current-id')
    const runFile = join(stateDir(), 'running')
    const currentId = existsSync(idFile) ? readFileSync(idFile, 'utf8').trim() : ''
    const isRunning = existsSync(runFile) && readFileSync(runFile, 'utf8').trim() === 'true'
    const entry = isRunning ? stateByImage[currentId] : undefined
    if (!entry) {
      res.writeHead(503).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      health: { runtime: { state: entry.state, detail: '' } },
      load: { running: entry.running, queued: 0, maxWorkers: 3 },
    }))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'docker-auto-update-'))
  mkdirSync(binDir(), { recursive: true })
  mkdirSync(stateDir(), { recursive: true })
  mkdirSync(join(root, 'release', 'scripts'), { recursive: true })
  mkdirSync(join(dataDir(), 'superagent'), { recursive: true })
  mkdirSync(backupDir(), { recursive: true })
  writeFileSync(join(dataDir(), 'superagent', 'marker.txt'), 'before-update')
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'docker-auto-update'), join(root, 'release', 'scripts', 'docker-auto-update'))
  copyFileSync(join(import.meta.dirname, '..', 'compose.yaml'), composeFile())
  writeFileSync(join(stateDir(), 'current-id'), 'sha256:old-image')
  writeFileSync(join(stateDir(), 'previous-id'), 'sha256:old-image')
  writeFileSync(join(stateDir(), 'remote-id'), 'sha256:new-image')
  writeFileSync(join(stateDir(), 'running'), 'true')
  stateByImage = {
    'sha256:old-image': { state: 'ready', running: 0 },
    'sha256:new-image': { state: 'ready', running: 0 },
  }
  writeDockerStub()
})

afterEach(() => {
  server?.close(); server = undefined
  for (const child of holders) child.kill()
  holders = []
  rmSync(root, { recursive: true, force: true })
})

it('checks for available updates and running workers without modifying the container', async () => {
  const url = await startStateServer()
  stateByImage['sha256:old-image'] = { state: 'ready', running: 1 }
  const deferredCheck = await runScript(['check', '--image', IMAGE, '--compose-file', composeFile(), '--url', url])
  expect(deferredCheck.code).toBe(0)
  expect(JSON.parse(deferredCheck.stdout)).toMatchObject({
    action: 'check', current_image_id: 'sha256:old-image', target_image_id: 'sha256:new-image',
    up_to_date: false, running_workers: 1, would_update: false,
  })
  expect(readFileSync(join(stateDir(), 'docker.log'), 'utf8')).not.toContain('compose')
})

it('skips restart when already running the pulled image digest', async () => {
  writeFileSync(join(stateDir(), 'remote-id'), 'sha256:old-image')
  const url = await startStateServer()
  const result = await runScript(['update', '--image', IMAGE, '--compose-file', composeFile(), '--url', url])
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ action: 'noop', reason: 'up_to_date', image_id: 'sha256:old-image' })
  expect(readFileSync(join(stateDir(), 'docker.log'), 'utf8')).not.toContain('compose')
})

it('defers when workers are active and proceeds when --force is passed', async () => {
  const url = await startStateServer()
  stateByImage['sha256:old-image'] = { state: 'ready', running: 2 }
  const deferred = await runScript([
    'update', '--image', IMAGE, '--compose-file', composeFile(), '--data-dir', dataDir(), '--url', url,
  ])
  expect(deferred.code).toBe(0)
  expect(JSON.parse(deferred.stdout)).toMatchObject({ action: 'deferred', reason: 'workers_running', running: 2 })
  const deferredStatus = JSON.parse(readFileSync(join(dataDir(), 'superagent', 'update-status.json'), 'utf8')) as Record<string, unknown>
  expect(deferredStatus).toMatchObject({
    action: 'deferred', image: IMAGE, currentImageId: 'sha256:old-image', targetImageId: 'sha256:new-image',
    upToDate: false, runningWorkers: 2, error: null,
  })

  const forced = await runScript([
    'update', '--image', IMAGE, '--compose-file', composeFile(), '--data-dir', dataDir(), '--url', url, '--force',
    '--health-timeout', '3', '--health-interval', '0.05',
  ])
  expect(forced.code).toBe(0)
  expect(JSON.parse(forced.stdout)).toMatchObject({ action: 'updated', image_id: 'sha256:new-image' })
  const updatedStatus = JSON.parse(readFileSync(join(dataDir(), 'superagent', 'update-status.json'), 'utf8')) as Record<string, unknown>
  expect(updatedStatus).toMatchObject({
    action: 'updated', image: IMAGE, currentImageId: 'sha256:new-image', targetImageId: 'sha256:new-image',
    upToDate: true, runningWorkers: 0, runtimeState: 'ready',
  })
  expect(JSON.stringify(updatedStatus)).not.toContain(root)
  expect(updatedStatus).not.toHaveProperty('backup_file')
  expect(updatedStatus).not.toHaveProperty('lock_file')
})

it('backs up data, swaps to the pulled image, verifies health, and prunes old backups', async () => {
  writeFileSync(join(backupDir(), 'data-auto-20260101-000001.tar.gz'), 'old1')
  writeFileSync(join(backupDir(), 'data-auto-20260102-000001.tar.gz'), 'old2')
  const url = await startStateServer()
  const result = await runScript([
    'update', '--image', IMAGE, '--compose-file', composeFile(), '--data-dir', dataDir(), '--backup-dir', backupDir(),
    '--keep-backups', '2', '--url', url, '--health-timeout', '3', '--health-interval', '0.05',
  ])
  expect(result.code).toBe(0)
  const payload = JSON.parse(result.stdout) as { action: string; backup_file: string; rollback_tag: string; runtime_state: string }
  expect(payload).toMatchObject({ action: 'updated', runtime_state: 'ready' })
  expect(existsSync(payload.backup_file)).toBe(true)
  expect(readdirSync(backupDir()).filter(name => name.startsWith('data-auto-'))).toHaveLength(2)
  expect(readFileSync(join(stateDir(), 'docker.log'), 'utf8')).toContain(`compose-env DSH_SUPERAGENT_IMAGE=${IMAGE}`)
})

it('rolls back image and data backup automatically when the new image fails health check', async () => {
  stateByImage['sha256:new-image'] = { state: 'error', running: 0 }
  const url = await startStateServer()
  const result = await runScript([
    'update', '--image', IMAGE, '--compose-file', composeFile(), '--data-dir', dataDir(), '--backup-dir', backupDir(),
    '--url', url, '--health-timeout', '0.25', '--health-interval', '0.05',
  ])
  expect(result.code).toBe(1)
  const payload = JSON.parse(result.stdout) as {
    action: string; rollback_tag: string; rollback_healthy: boolean; rollback_state: string; failed_data_dir: string
  }
  expect(payload).toMatchObject({ action: 'rolled_back', rollback_healthy: true, rollback_state: 'ready' })
  expect(readFileSync(join(stateDir(), 'current-id'), 'utf8').trim()).toBe('sha256:old-image')
  expect(readFileSync(join(dataDir(), 'superagent', 'marker.txt'), 'utf8')).toBe('before-update')
  expect(existsSync(payload.failed_data_dir)).toBe(true)
  const rollbackStatusRaw = readFileSync(join(dataDir(), 'superagent', 'update-status.json'), 'utf8')
  const rollbackStatus = JSON.parse(rollbackStatusRaw) as Record<string, unknown>
  expect(rollbackStatus).toMatchObject({
    action: 'rolled_back', image: IMAGE, currentImageId: 'sha256:old-image', targetImageId: 'sha256:new-image',
    upToDate: false, rollbackTag: payload.rollback_tag, runtimeState: 'ready',
  })
  expect(rollbackStatusRaw).not.toContain(root)
  expect(rollbackStatus).not.toHaveProperty('failed_data_dir')
  expect(rollbackStatus).not.toHaveProperty('backup_file')
})

it('exits with locked status without touching containers when another update holds the lock', async () => {
  const lockFile = join(root, 'release', '.artifacts', 'docker-auto-update.lock')
  mkdirSync(join(root, 'release', '.artifacts'), { recursive: true })
  const holder = spawn('python3', ['-c',
    `import fcntl, sys, time; fd = open(${JSON.stringify(lockFile)}, 'w'); fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); sys.stdout.write('locked\\n'); sys.stdout.flush(); time.sleep(10)`],
  { stdio: ['ignore', 'pipe', 'ignore'] })
  holders.push(holder)
  await new Promise<void>(resolve => holder.stdout!.once('data', () => resolve()))

  const result = await runScript(['update', '--image', IMAGE, '--compose-file', composeFile(), '--lock-file', lockFile])
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ action: 'locked', lock_file: lockFile })
  expect(existsSync(join(stateDir(), 'docker.log'))).toBe(false)
})
