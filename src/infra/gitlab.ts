/** glab adapter boundary: project-scoped API calls and setup probes, with one config directory per ProjectSource. */
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Commands } from './commands.ts'
import { CliError, validItems, type Tally } from './commands.ts'
import { executable, type Machine, type Probe } from '../deployment.ts'
import { SetupError } from '../setup.ts'
import { normalizeHost, normalizeProject, projectSourceId, ProjectEnvironmentSchema, type ResolvedProject } from '../project-source.ts'

const exec = promisify(execFile)
const TIMEOUT_MS = 90_000
export const MIN_GLAB_VERSION = '1.50.0'
const SECRET_ENVIRONMENT = ['GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'GLAB_TOKEN', 'CI_JOB_TOKEN', 'OAUTH_TOKEN'] as const
const INSECURE_ENVIRONMENT = ['GIT_SSL_NO_VERIFY', 'NODE_TLS_REJECT_UNAUTHORIZED', 'GLAB_SKIP_TLS_VERIFY', 'SKIP_TLS_VERIFY', 'GITLAB_SKIP_TLS_VERIFY'] as const

/** Settings persisted for a GitLab Source; authentication material lives only in GLAB_CONFIG_DIR. */
export const GitlabProjectConfigSchema = z.object({
  repository: z.string().trim().default(''),
  host: z.string().trim().default('gitlab.com'),
  cli: z.string().trim().default('glab'),
  configDir: z.string().trim().optional(),
  environment: ProjectEnvironmentSchema.default({}),
  pollSeconds: z.number().int().min(60).max(3600).optional(),
  failuresBeforeError: z.number().int().min(1).max(20).optional(),
  observeIssues: z.boolean().optional(), observeMergeRequests: z.boolean().optional(), observeComments: z.boolean().optional(), observePipelines: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'] as const) {
    const proxy = value.environment[key]
    if (!proxy) continue
    try {
      const parsed = new URL(proxy)
      if (parsed.username || parsed.password) context.addIssue({ code: 'custom', path: ['environment', key], message: '代理凭据不能保存在项目设置中' })
    } catch { context.addIssue({ code: 'custom', path: ['environment', key], message: '代理必须是有效 URL' }) }
  }
})
export type GitlabProjectConfig = z.infer<typeof GitlabProjectConfigSchema>

export interface GlabRunnerOptions {
  executable: string
  host: string
  project: string
  /** Injected for deterministic tests. The returned string is stdout; errors are sanitized before they leave the runner. */
  execute?: (program: string, args: string[], environment: Record<string, string | undefined>) => Promise<string>
  environment?: Record<string, string | undefined>
}

const executeGlab = async (program: string, args: string[], environment: Record<string, string | undefined>): Promise<string> => {
  const { stdout } = await exec(program, args, { env: safeEnvironment({ ...process.env, ...environment }), timeout: TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024 })
  return stdout
}
function safeEnvironment(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = { ...source, GLAB_PROMPT_DISABLED: '1' }
  for (const key of [...SECRET_ENVIRONMENT, ...INSECURE_ENVIRONMENT]) environment[key] = undefined
  return environment
}

/** Removes common token forms before CLI diagnostics are included in setup or runtime errors. */
export function sanitizeGitlabDiagnostic(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value)
  return message
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [redacted]')
    .replace(/\b(glpat|glrt|gldt|glcbt|glft|glsoat)-[A-Za-z0-9_-]{8,}/gi, '$1-[redacted]')
    .replace(/\b(token|private[_-]?token|access[_-]?token|refresh[_-]?token|password|secret|authorization)\s*([:=])\s*([^\s,;]+)/gi, '$1$2[redacted]')
    .replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, '$1[redacted]@')
    .slice(0, 800)
}

/** Rejects paths that make two projects share the same glab auth/config state, following existing symlinks where possible. */
export function validateGitlabConfigDirs(projects: readonly Pick<ResolvedProject, 'id' | 'host' | 'project' | 'configDir'>[]): void {
  const conflict = gitlabConfigDirConflicts(projects)[0]
  if (conflict) throw new SetupError('gitlabConfigDirShared', { host: conflict.project.host, project: conflict.project.project,
    otherProject: conflict.previous.project, sourceId: conflict.project.id, otherSource: conflict.previous.id })
}
export interface GitlabConfigDirConflict {
  project: Pick<ResolvedProject, 'id' | 'host' | 'project' | 'configDir'>
  previous: Pick<ResolvedProject, 'id' | 'host' | 'project' | 'configDir'>
}
/** Returns every project after the first that shares a canonical glab configuration directory. */
export function gitlabConfigDirConflicts(projects: readonly Pick<ResolvedProject, 'id' | 'host' | 'project' | 'configDir'>[]): GitlabConfigDirConflict[] {
  const seen = new Map<string, Pick<ResolvedProject, 'id' | 'host' | 'project' | 'configDir'>>()
  const conflicts: GitlabConfigDirConflict[] = []
  for (const project of projects) {
    if (!project.configDir) continue
    const path = canonicalPath(project.configDir)
    const previous = seen.get(path)
    if (previous && previous.id !== project.id) conflicts.push({ project, previous })
    else seen.set(path, project)
  }
  return conflicts
}
function canonicalPath(value: string): string {
  let path = resolve(value), tail: string[] = []
  while (true) {
    try { path = realpathSync.native(path); break }
    catch {
      const parent = dirname(path)
      if (parent === path) break
      tail.unshift(basename(path)); path = parent
    }
  }
  return join(path, ...tail)
}

function statusCode(error: unknown): number | undefined {
  if (error instanceof CliError && error.code) return error.code
  const message = sanitizeGitlabDiagnostic(error)
  return Number(/(?:HTTP|status(?: code)?)\s*[:=]?\s*(\d{3})\b/i.exec(message)?.[1]) || undefined
}
function safeCliError(error: unknown, program: string): CliError {
  const code = statusCode(error)
  const message = sanitizeGitlabDiagnostic(error)
  const detail = message && !/token|authorization|password|secret/i.test(message) ? message : `${basename(program)} failed`
  return new CliError(detail || `${basename(program)} failed`, code, error instanceof CliError ? error.exitCode : undefined)
}
const json = (text: string): unknown => {
  const start = text.search(/[\[{]/)
  if (start < 0) throw new Error('glab returned no JSON')
  return JSON.parse(text.slice(start)) as unknown
}

/** The only object that constructs glab API arguments. It pins the hostname and rejects endpoints outside this project. */
export class GlabRunner {
  private readonly execute: NonNullable<GlabRunnerOptions['execute']>
  private readonly environment: Record<string, string | undefined>
  private readonly projectEndpoint: string
  constructor(readonly options: GlabRunnerOptions) {
    this.execute = options.execute ?? executeGlab
    this.environment = options.environment ?? {}
    this.projectEndpoint = `projects/${encodeURIComponent(normalizeProject(options.project))}`
    normalizeHost(options.host)
    if (!options.executable.trim()) throw new Error('glab executable is required')
  }
  get projectPath(): string { return this.projectEndpoint }

  /** Authenticated request returning schema-validated JSON. Project paths and the identity endpoint are the only targets. */
  async api<T>(schema: z.ZodType<T>, endpoint: string, ...flags: string[]): Promise<T> {
    const path = this.path(endpoint)
    await this.assertTls()
    const output = await this.run(['api', path, '--hostname', normalizeHost(this.options.host), ...flags])
    try { return schema.parse(json(output)) }
    catch (error) {
      if (error instanceof z.ZodError) throw new Error(`GitLab returned an incompatible response for ${path}`)
      throw error
    }
  }

  /** Authenticated raw response for file contents or a request made by a provider-specific reader. */
  async raw(endpoint: string, ...flags: string[]): Promise<string> {
    await this.assertTls()
    return this.run(['api', this.path(endpoint), '--hostname', normalizeHost(this.options.host), ...flags])
  }

  /** Reads every API page as NDJSON and schema-validates items, recording malformed rows in the optional tally. */
  async pages<T>(item: z.ZodType<T>, endpoint: string, tally?: Tally, ...flags: string[]): Promise<T[]> {
    // glab 1.50 supports --paginate but concatenates JSON pages, so request each page explicitly. This also
    // gives us a clear termination condition for self-managed servers that omit pagination headers.
    const base = this.path(endpoint)
    const question = base.indexOf('?')
    const pathname = question < 0 ? base : base.slice(0, question)
    const query = new URLSearchParams(question < 0 ? '' : base.slice(question + 1))
    await this.assertTls()
    const requestedPageSize = Number(query.get('per_page') ?? 100)
    const pageSize = Number.isInteger(requestedPageSize) ? Math.min(100, Math.max(1, requestedPageSize)) : 100
    query.set('per_page', String(pageSize))
    const items: T[] = []
    for (let page = 1; page <= 10_000; page++) {
      query.set('page', String(page))
      const output = await this.run(['api', `${pathname}?${query.toString()}`, '--hostname', normalizeHost(this.options.host), ...flags])
      const body = json(output)
      if (!Array.isArray(body)) throw new Error(`GitLab returned a non-list response for paginated endpoint ${pathname}`)
      const batch = validItems(item, body, tally)
      items.push(...batch)
      if (body.length < pageSize) return items
    }
    throw new Error(`GitLab pagination exceeded 10000 pages for ${pathname}`)
  }

  private path(endpoint: string): string {
    const pathname = endpoint.split('?', 1)[0]!
    const prefix = this.projectEndpoint + '/'
    const suffix = pathname.startsWith(prefix) ? pathname.slice(prefix.length).split('/') : []
    const unsafeSegment = suffix.some(segment => {
      let decoded: string
      try { decoded = decodeURIComponent(segment) } catch { return true }
      return decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part => part === '.' || part === '..')
    })
    const unsafe = /^\/|^[a-z]+:|(^|\/)\.\.?($|[/?])/i.test(endpoint) || endpoint.includes('\\') || endpoint.includes('\0') || unsafeSegment
    const ownProject = endpoint === this.projectEndpoint || endpoint.startsWith(`${this.projectEndpoint}/`)
    if (unsafe || (!ownProject && endpoint !== 'user')) throw new Error('GitLab API calls are restricted to the configured project')
    return endpoint
  }

  private async run(args: string[]): Promise<string> {
    try { return await this.execute(this.options.executable, args, this.environment) }
    catch (error) { throw safeCliError(error, this.options.executable) }
  }

  private async assertTls(): Promise<void> {
    const result = (await this.run(['config', 'get', 'skip_tls_verify', '--host', normalizeHost(this.options.host)])).trim().toLowerCase()
    if (result === 'true' || result === '1') throw new CliError('TLS verification is disabled in glab configuration; enable certificate verification and configure a trusted CA instead')
  }
}

/** Creates a runner from the active GitLab ProjectSource and reuses Commands' abort, timeout, host VPN, and isolated config environment. */
export function glabFor(commands: Pick<Commands, 'deployment' | 'run'>): GlabRunner {
  const project = commands.deployment.activeProject
  if (!project || project.provider !== 'gitlab') throw new Error('A GitLab ProjectSource is required for glab API access')
  return new GlabRunner({ executable: project.cli, host: project.host, project: project.project,
    execute: (program, args) => commands.run(program, args) })
}

const VersionSchema = z.object({ version: z.string().optional() }).passthrough()
const UserSchema = z.looseObject({ id: z.number().int().positive(), username: z.string().min(1), public_email: z.string().nullish(), email: z.string().nullish(), name: z.string().optional() })
const AccessSchema = z.looseObject({ access_level: z.number().int().optional() }).nullish()
const ProjectSchema = z.looseObject({ id: z.number().int().positive(), path_with_namespace: z.string(), default_branch: z.string().nullish(),
  permissions: z.looseObject({ project_access: AccessSchema, group_access: AccessSchema }).nullish() })

function version(text: string): number[] | undefined {
  const match = /\b(?:glab\s+)?v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\b/i.exec(text)
  return match ? match.slice(1, 4).map(Number) : undefined
}
function atLeast(found: readonly number[], required: readonly number[]): boolean {
  for (let i = 0; i < required.length; i++) if ((found[i] ?? 0) !== required[i]) return (found[i] ?? 0) > required[i]!
  return true
}
function safeOutput(error: unknown): string {
  const value = sanitizeGitlabDiagnostic(error)
  return value ? value : ''
}
function setupFailure(code: ConstructorParameters<typeof SetupError>[0], values: Record<string, string>, error?: unknown): never {
  const output = error === undefined ? undefined : safeOutput(error)
  throw new SetupError(code, { ...values, ...(output ? { output } : {}) })
}

/**
 * Resolves a configured GitLab project using the same worker-side environment as execution. It checks glab version,
 * host authentication, identity, project read access, and Developer-level push capability without attempting a write.
 */
export async function resolveGitlabProject(config: unknown, probe: Probe, machine: Machine,
  path = process.env.PATH ?? ''): Promise<ResolvedProject> {
  const parsed = GitlabProjectConfigSchema.safeParse(config ?? {})
  if (!parsed.success) setupFailure('gitlabConfigInvalid', {}, parsed.error.issues.map(issue => issue.path.join('.')).join(', '))
  const settings = parsed.data
  if (!settings.repository) setupFailure('gitlabConfigInvalid', {}, 'The repository field is empty.')
  let host: string, project: string
  try { host = normalizeHost(settings.host); project = normalizeProject(settings.repository) }
  catch (error) { setupFailure('gitlabConfigInvalid', {}, error) }
  if (settings.configDir && !isAbsolute(settings.configDir)) setupFailure('gitlabConfigInvalid', {}, 'configDir must be an absolute path.')
  if (Object.values(settings.environment).some(value => value.includes('\0'))) setupFailure('gitlabConfigInvalid', {}, 'Environment values cannot contain NUL.')
  const id = projectSourceId('gitlab', host, project)
  const configDir = settings.configDir || join(machine.stateDir, 'glab', host, ...project.split('/'))
  let cli: string
  try { cli = executable(settings.cli, path) }
  catch (error) { setupFailure('gitlabCliMissing', {}, error) }
  const env = safeEnvironment({ GLAB_CONFIG_DIR: configDir, GITLAB_HOST: host, ...settings.environment })
  const unset = [...SECRET_ENVIRONMENT, ...INSECURE_ENVIRONMENT].flatMap(name => ['-u', name])
  const envArgs = Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined).map(([key, value]) => `${key}=${value}`)
  const run = (...args: string[]) => probe(['env', ...unset, ...envArgs, cli, ...args])
    .catch((error: unknown) => { throw safeCliError(error, cli) })

  const versionText = await run('version').catch(error => setupFailure('gitlabCliMissing', {}, error))
  const foundVersion = version(versionText)
  const minimum = MIN_GLAB_VERSION.split('.').map(Number)
  if (!foundVersion || !atLeast(foundVersion, minimum)) {
    setupFailure('gitlabCliTooOld', { version: foundVersion?.join('.') ?? 'unknown', minimum: MIN_GLAB_VERSION })
  }
  const insecure = await run('config', 'get', 'skip_tls_verify', '--host', host)
    .catch(error => setupFailure('gitlabConfigInvalid', { host }, error))
  if (/^(?:true|1)$/i.test(insecure.trim())) setupFailure('gitlabTlsVerificationDisabled', { host })
  await run('auth', 'status', '--hostname', host).catch(error => setupFailure('gitlabAuthFailed', { host }, error))

  const runner = new GlabRunner({ executable: cli, host, project, environment: env,
    execute: (program, args, environment) => probe(['env', ...unset, ...Object.entries(environment)
      .filter((entry): entry is [string, string] => entry[1] !== undefined).map(([key, value]) => `${key}=${value}`), program, ...args]) })
  let user: z.infer<typeof UserSchema>
  try { user = await runner.api(UserSchema, 'user') }
  catch (error) {
    if (statusCode(error) === 401 || statusCode(error) === 403) setupFailure('gitlabAuthFailed', { host }, error)
    if (error instanceof CliError) setupFailure('gitlabConnectionFailed', { host }, error)
    setupFailure('gitlabUserUnreported', { host }, error)
  }

  let remote: z.infer<typeof ProjectSchema>
  try { remote = await runner.api(ProjectSchema, runner.projectPath) }
  catch (error) {
    const code = statusCode(error)
    if (code === 401) setupFailure('gitlabAuthFailed', { host }, error)
    if (code === 403 || code === 404) setupFailure('gitlabProjectUnreadable', { account: user.username, project, host }, error)
    if (error instanceof CliError) setupFailure('gitlabConnectionFailed', { host }, error)
    setupFailure('gitlabProjectUnreported', { host, project }, error)
  }
  let canonical: string
  try { canonical = normalizeProject(remote.path_with_namespace) }
  catch { setupFailure('gitlabProjectUnreported', { host, project }) }
  if (canonical !== project) setupFailure('gitlabProjectUnreported', { host, project })
  const role = Math.max(remote.permissions?.project_access?.access_level ?? 0, remote.permissions?.group_access?.access_level ?? 0)
  if (role < 30) setupFailure('gitlabProjectReadOnly', { account: user.username, project, host })
  const noreply = user.public_email || `${user.id}-${user.username}@users.noreply.${host}`
  return { id, provider: 'gitlab', host, project: remote.path_with_namespace, cli, configDir, environment: settings.environment,
    login: user.username, noreply }
}
