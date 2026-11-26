/** Read-only image metadata, sanitized host update status reader, and GHCR/GitHub update check helpers. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { packagePath } from '../infra/paths.ts'

const STATUS_FILE = 'update-status.json'
const GHCR_IMAGE_RE = /^ghcr\.io\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*):([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/
const OCI_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

/** Client-facing validation error when checking an invalid or missing GHCR image reference. */
export class UpdateError extends Error {
  constructor(readonly status: 400, message: string) { super(message) }
}

const HostUpdateStatusSchema = z.object({
  checkedAt: z.string(),
  action: z.enum(['check', 'noop', 'deferred', 'updated', 'rolled_back', 'rollback_failed', 'failed']),
  image: z.string(),
  currentImageId: z.string().nullable().optional().default(null),
  targetImageId: z.string().nullable().optional().default(null),
  upToDate: z.boolean().nullable().optional().default(null),
  runningWorkers: z.number().int().nonnegative().nullable().optional().default(null),
  runtimeState: z.string().nullable().optional().default(null),
  rollbackTag: z.string().nullable().optional().default(null),
  error: z.string().nullable().optional().default(null),
})

export type HostUpdateStatus = z.infer<typeof HostUpdateStatusSchema>

export interface UpdateStatusView {
  current: {
    version: string
    commit: string | null
    buildTime: string | null
    image: string | null
  }
  hostStatus: HostUpdateStatus | null
}

export type UpdateCheckState = 'up_to_date' | 'update_available' | 'auth_required' | 'unknown' | 'error'

export interface UpdateCheckResult {
  checkedAt: string
  image: string
  state: UpdateCheckState
  currentCommit: string | null
  remoteDigest: string | null
  remoteCommit: string | null
  remoteCommitAt: string | null
  remoteCommitMessage: string | null
  detail?: string
}

let cachedVersion: string | undefined
function packageVersion(): string {
  if (cachedVersion) return cachedVersion
  try {
    const parsed = JSON.parse(readFileSync(packagePath('package.json'), 'utf8')) as { version?: unknown }
    if (typeof parsed.version === 'string' && parsed.version.trim()) return cachedVersion = parsed.version.trim()
  } catch { /* Fall back to placeholder version when running without readable manifest. */ }
  return '0.0.0'
}

function readHostStatus(stateDir: string): HostUpdateStatus | null {
  try {
    const file = join(stateDir, STATUS_FILE)
    if (!existsSync(file)) return null
    const parsed = HostUpdateStatusSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function readUpdateStatus(stateDir: string, env: NodeJS.ProcessEnv = process.env): UpdateStatusView {
  const hostStatus = readHostStatus(stateDir)
  const envImage = env.DSH_SUPERAGENT_IMAGE?.trim() || null
  return {
    current: {
      version: packageVersion(),
      commit: env.DSH_SUPERAGENT_COMMIT?.trim() || null,
      buildTime: env.DSH_SUPERAGENT_BUILD_TIME?.trim() || null,
      image: envImage || hostStatus?.image || null,
    },
    hostStatus,
  }
}

export function parseGhcrImage(raw: string): { owner: string; repo: string; tag: string; normalized: string } {
  const trimmed = raw.trim()
  if (!trimmed) throw new UpdateError(400, '请填写要检查的 GHCR 镜像地址（如 ghcr.io/owner/repo:edge）')
  const match = GHCR_IMAGE_RE.exec(trimmed)
  if (!match || trimmed.includes('..')) {
    throw new UpdateError(400, '仅支持标准的 GHCR 镜像标签引用（格式：ghcr.io/<owner>/<repo>:<tag>）')
  }
  const owner = match[1]!.toLowerCase()
  const repo = match[2]!.toLowerCase()
  const tag = match[3]!
  return { owner, repo, tag, normalized: `ghcr.io/${owner}/${repo}:${tag}` }
}

function commitsMatch(a: string, b: string): boolean {
  const left = a.trim().toLowerCase()
  const right = b.trim().toLowerCase()
  if (!left || !right) return false
  if (left === right) return true
  return (left.length >= 7 && right.startsWith(left)) || (right.length >= 7 && left.startsWith(right))
}

async function fetchRemoteCommit(
  owner: string,
  repo: string,
  tag: string,
  fetchImpl: typeof fetch,
): Promise<{ sha: string | null; at: string | null; message: string | null }> {
  const ref = tag === 'edge' ? 'main' : /^v\d/.test(tag) ? tag : undefined
  if (!ref) return { sha: null, at: null, message: null }
  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
      {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-superagent' },
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!response.ok) return { sha: null, at: null, message: null }
    const data = await response.json() as {
      sha?: unknown
      commit?: { author?: { date?: unknown }; committer?: { date?: unknown }; message?: unknown }
    }
    const sha = typeof data.sha === 'string' && data.sha.trim() ? data.sha.trim() : null
    const dateRaw = data.commit?.committer?.date ?? data.commit?.author?.date
    const at = typeof dateRaw === 'string' && dateRaw.trim() ? dateRaw.trim() : null
    const msgRaw = typeof data.commit?.message === 'string' ? data.commit.message.split('\n')[0]?.trim() : ''
    const message = msgRaw ? (msgRaw.length > 120 ? `${msgRaw.slice(0, 117)}...` : msgRaw) : null
    return { sha, at, message }
  } catch {
    return { sha: null, at: null, message: null }
  }
}

export async function checkForUpdate({
  stateDir,
  image,
  env = process.env,
  fetchImpl = fetch,
}: {
  stateDir: string
  image?: string
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
}): Promise<UpdateCheckResult> {
  const status = readUpdateStatus(stateDir, env)
  const target = parseGhcrImage(image?.trim() || status.current.image || '')
  const checkedAt = new Date().toISOString()
  const currentCommit = status.current.commit

  const base = {
    checkedAt,
    image: target.normalized,
    currentCommit,
    remoteDigest: null as string | null,
    remoteCommit: null as string | null,
    remoteCommitAt: null as string | null,
    remoteCommitMessage: null as string | null,
  }

  try {
    const tokenRes = await fetchImpl(
      `https://ghcr.io/token?scope=repository:${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}:pull`,
      { signal: AbortSignal.timeout(10_000) },
    )
    if (tokenRes.status === 401 || tokenRes.status === 403) {
      return { ...base, state: 'auth_required' }
    }
    if (!tokenRes.ok) {
      return { ...base, state: 'error', detail: `GHCR token request failed (${tokenRes.status})` }
    }
    const tokenPayload = await tokenRes.json() as { token?: unknown }
    const token = typeof tokenPayload.token === 'string' ? tokenPayload.token : ''
    if (!token) {
      return { ...base, state: 'error', detail: 'GHCR returned an empty pull token' }
    }

    const manifestRes = await fetchImpl(
      `https://ghcr.io/v2/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/manifests/${encodeURIComponent(target.tag)}`,
      {
        method: 'HEAD',
        headers: { authorization: `Bearer ${token}`, accept: OCI_ACCEPT },
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (manifestRes.status === 401 || manifestRes.status === 403) {
      return { ...base, state: 'auth_required' }
    }
    if (manifestRes.status === 404) {
      return { ...base, state: 'error', detail: 'Image tag not found or private on GHCR (404)' }
    }
    if (!manifestRes.ok) {
      return { ...base, state: 'error', detail: `GHCR manifest check failed (${manifestRes.status})` }
    }

    const remoteDigest = manifestRes.headers.get('docker-content-digest')?.trim() || null
    const remote = await fetchRemoteCommit(target.owner, target.repo, target.tag, fetchImpl)

    let state: UpdateCheckState
    if (currentCommit && remote.sha) {
      state = commitsMatch(currentCommit, remote.sha) ? 'up_to_date' : 'update_available'
    } else if (status.hostStatus?.image.toLowerCase() === target.normalized && status.hostStatus.upToDate === false) {
      state = 'update_available'
    } else if (remoteDigest) {
      state = 'unknown'
    } else {
      state = 'error'
    }

    return {
      ...base,
      state,
      remoteDigest,
      remoteCommit: remote.sha,
      remoteCommitAt: remote.at,
      remoteCommitMessage: remote.message,
    }
  } catch (error) {
    return {
      ...base,
      state: 'error',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
