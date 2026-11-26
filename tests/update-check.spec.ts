/** Tests for read-only build metadata, host update-status.json parsing, SSRF validation, and GHCR update checks. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { UpdateError, checkForUpdate, parseGhcrImage, readUpdateStatus } from '../src/app/update.ts'

let stateDir: string

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'superagent-update-'))
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

it('reads build version, env metadata, and valid host update-status.json while ignoring malformed files', () => {
  const empty = readUpdateStatus(stateDir, {
    DSH_SUPERAGENT_COMMIT: 'abc1234567890',
    DSH_SUPERAGENT_BUILD_TIME: '2026-11-26T00:00:00Z',
    DSH_SUPERAGENT_IMAGE: 'ghcr.io/owner/dsh-superagent-prototype:edge',
  })
  expect(empty.current).toMatchObject({
    commit: 'abc1234567890',
    buildTime: '2026-11-26T00:00:00Z',
    image: 'ghcr.io/owner/dsh-superagent-prototype:edge',
  })
  expect(empty.current.version).toMatch(/^\d+\.\d+\.\d+/)
  expect(empty.hostStatus).toBeNull()

  writeFileSync(join(stateDir, 'update-status.json'), '{not-json')
  expect(readUpdateStatus(stateDir, {}).hostStatus).toBeNull()

  writeFileSync(join(stateDir, 'update-status.json'), JSON.stringify({
    checkedAt: '2026-11-26T08:00:00Z',
    action: 'deferred',
    image: 'ghcr.io/owner/dsh-superagent-prototype:edge',
    currentImageId: 'sha256:old',
    targetImageId: 'sha256:new',
    upToDate: false,
    runningWorkers: 1,
    runtimeState: 'ready',
    rollbackTag: null,
    error: null,
  }))
  const loaded = readUpdateStatus(stateDir, {})
  expect(loaded.current.image).toBe('ghcr.io/owner/dsh-superagent-prototype:edge')
  expect(loaded.hostStatus).toMatchObject({ action: 'deferred', upToDate: false, runningWorkers: 1 })
})

it('rejects empty, non-GHCR, or path-traversal image references to prevent SSRF', () => {
  for (const invalid of [
    '',
    'dsh-superagent:local',
    'docker.io/library/node:24',
    'http://127.0.0.1:8080/owner/repo:edge',
    'ghcr.io/owner/repo',
    'ghcr.io/owner/repo@sha256:deadbeef',
    'ghcr.io/owner/../evil:edge',
    'ghcr.io/owner/repo/nested:edge',
  ]) {
    expect(() => parseGhcrImage(invalid)).toThrowError(UpdateError)
  }
  expect(parseGhcrImage('ghcr.io/Owner/DSH-Superagent-Prototype:edge')).toEqual({
    owner: 'owner',
    repo: 'dsh-superagent-prototype',
    tag: 'edge',
    normalized: 'ghcr.io/owner/dsh-superagent-prototype:edge',
  })
})

it('reports up_to_date, update_available, auth_required, unknown, and error from mocked GHCR responses', async () => {
  const image = 'ghcr.io/owner/dsh-superagent-prototype:edge'
  const mkFetch = ({
    tokenStatus = 200,
    manifestStatus = 200,
    digest = 'sha256:remote-digest',
    commitSha = '1111111111111111111111111111111111111111',
  }: {
    tokenStatus?: number; manifestStatus?: number; digest?: string; commitSha?: string
  }): typeof fetch => (async (input) => {
    const url = String(input)
    if (url.startsWith('https://ghcr.io/token')) {
      return new Response(JSON.stringify({ token: 'anon-token' }), { status: tokenStatus })
    }
    if (url.startsWith('https://ghcr.io/v2/')) {
      return new Response(null, { status: manifestStatus, headers: digest ? { 'docker-content-digest': digest } : {} })
    }
    if (url.startsWith('https://api.github.com/')) {
      return new Response(JSON.stringify({
        sha: commitSha,
        commit: { committer: { date: '2026-11-26T07:00:00Z' }, message: 'feat: latest build\n\nbody' },
      }), { status: 200 })
    }
    throw new Error(`unexpected URL: ${url}`)
  }) as typeof fetch

  const upToDate = await checkForUpdate({
    stateDir,
    image,
    env: { DSH_SUPERAGENT_COMMIT: '1111111111111111111111111111111111111111' },
    fetchImpl: mkFetch({}),
  })
  expect(upToDate).toMatchObject({
    state: 'up_to_date',
    remoteDigest: 'sha256:remote-digest',
    remoteCommit: '1111111111111111111111111111111111111111',
    remoteCommitMessage: 'feat: latest build',
  })

  const available = await checkForUpdate({
    stateDir,
    image,
    env: { DSH_SUPERAGENT_COMMIT: '0000000000000000000000000000000000000000' },
    fetchImpl: mkFetch({}),
  })
  expect(available.state).toBe('update_available')

  const authRequired = await checkForUpdate({
    stateDir,
    image,
    env: {},
    fetchImpl: mkFetch({ manifestStatus: 401 }),
  })
  expect(authRequired.state).toBe('auth_required')

  const unknown = await checkForUpdate({
    stateDir,
    image,
    env: {},
    fetchImpl: mkFetch({}),
  })
  expect(unknown.state).toBe('unknown')

  const missingTag = await checkForUpdate({
    stateDir,
    image,
    env: {},
    fetchImpl: mkFetch({ manifestStatus: 404 }),
  })
  expect(missingTag.state).toBe('error')
})
