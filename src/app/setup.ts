/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, resolveDeployment, resolveFeishuBot, workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import type { ResolvedProject } from '../project-source.ts'
import { gitlabConfigDirConflicts, resolveGitlabProject, validateGitlabConfigDirs } from '../infra/gitlab.ts'
import { normalizeHost, normalizeProject, projectSourceId } from '../project-source.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
}

const setupFields = (settings: Settings, includeEnabled = true) =>
  JSON.stringify([...new Set([...Object.keys(SETUP_FIELDS), ...Object.keys(settings.sources)])].sort().flatMap(id => {
    const value = settings.sources[id]
    const kind = value?.kind ?? id
    const keys = SETUP_FIELDS[kind]
    return keys ? [[id, kind, ...(includeEnabled ? [value?.enabled ?? true] : []), keys.map(key => value?.config[key] ?? '')]] : []
  }))
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)
/** 开关可以通过明确的配置请求修改；更换账号或执行配置仅允许管理面板。 */
export const accountsChanged = (before: Settings, after: Settings): boolean => setupFields(before, false) !== setupFields(after, false)

/**
 * Resolves the target repository, GitHub account, and optional Feishu bot by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures in `problem`/`feishuProblem` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and Feishu are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.feishuProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** Verify account CLIs for a modified source block before saving, ignoring setup errors belonging to other blocks. */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    if (!block.startsWith('source:')) return
    const id = block.slice(7), source = settings.sources[id], kind = source?.kind ?? id
    if (source?.enabled === false) return
    if (kind === 'feishu') await resolveFeishuBot(machine, source?.config, this.probe())
    else if (kind === 'gitlab') {
      const resolved = { ...await resolveGitlabProject(source?.config, this.probe(), machine, this.path), id }
      const peers = Object.values(this.resolved?.projects ?? {}).filter(project => project.provider === 'gitlab' && project.id !== id)
      const identity = projectSourceId('gitlab', resolved.host, resolved.project)
      const duplicate = peers.find(project => projectSourceId('gitlab', project.host, project.project) === identity)
      if (duplicate) throw new SetupError('gitlabProjectRepeated', { host: resolved.host, project: resolved.project, otherSource: duplicate.id })
      validateGitlabConfigDirs([...peers, resolved])
    }
    else if (kind === 'github') await resolveDeployment(machine, source?.config, this.probe(), this.path)
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    const stored = Object.entries(settings.sources).filter(([id, value]) => ['github', 'gitlab'].includes(value.kind ?? id))
    // 没有新项目配置时保留旧单 GitHub 的 setup 诊断。
    if (!stored.length) stored.push(['github', { enabled: true, config: {} }])
    const projects: Record<string, ResolvedProject> = {}, projectProblems: Record<string, SetupProblem> = {}
    const gitlabIdentities = new Map<string, { id: string; host: string; project: string }>()
    for (const [id, value] of stored) {
      if (!value.enabled) continue
      const provider = value.kind ?? id
      try {
        if (provider === 'gitlab') {
          const project = { ...await resolveGitlabProject(value.config, probe, machine, this.path), id }
          const identity = projectSourceId('gitlab', project.host, project.project)
          const previous = gitlabIdentities.get(identity)
          if (previous) throw new SetupError('gitlabProjectRepeated', { host: project.host, project: project.project, otherSource: previous.id })
          gitlabIdentities.set(identity, { id, host: project.host, project: project.project })
          projects[id] = project
        }
        else {
          const resolved = await resolveDeployment(machine, value.config, probe, this.path)
          projects[id] = { id, provider: 'github', host: 'github.com', project: resolved.repository, ...resolved.github,
            ...(typeof value.config.configDir === 'string' ? { configDir: value.config.configDir } : {}),
            ...(value.config.environment ? { environment: value.config.environment as Record<string, string> } : {}) }
        }
      } catch (error) {
        if (!(error instanceof SetupError)) throw error
        projectProblems[id] = error.problem
        context.logger.warn('ProjectSource %s setup failed: %s', id, error.problem.code)
      }
    }
    for (const conflict of gitlabConfigDirConflicts(Object.values(projects).filter(project => project.provider === 'gitlab'))) {
      const { project, previous } = conflict
      const id = project.id
      const error = new SetupError('gitlabConfigDirShared', { host: project.host, project: project.project,
        otherProject: previous.project, sourceId: project.id, otherSource: previous.id })
      projectProblems[id] = error.problem
      delete projects[id]
      context.logger.warn('ProjectSource %s setup failed: %s', id, error.problem.code)
    }
    const first = projects.github ?? Object.values(projects)[0]
    if (!first && Object.values(projectProblems)[0]) {
      const problem = Object.values(projectProblems)[0]!
      throw new SetupError(problem.code, problem.values)
    }
    const deployment: Deployment = { ...machine, repository: first?.project ?? '', github: { cli: first?.cli ?? '', login: first?.login ?? '', noreply: first?.noreply ?? '' }, projects, projectProblems }
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', error.message)
      return undefined
    })
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}) }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    await verifyEnvironment(resolved, context.subprocess, lifetime).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}
