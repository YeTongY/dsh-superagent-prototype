/** Execution environment variables exposed to prepare commands and documented in worker Session instructions; never contains credentials. */
import { join } from 'node:path'
import type { Ticket, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import type { Localized, VariableSpec } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { deploymentForSource, projectForTrigger } from '../project-source.ts'
import { workerGitConfig } from '../infra/environment.ts'

/** Variables registered by the Executor; `ticket` entries are populated only when a ticket is present. */
export const EXECUTOR_VARIABLES: readonly (VariableSpec & { ticket?: true })[] = [
  { key: 'DSH_SUPERAGENT_SOURCE', ticket: true, description: { zh: '工单所属的 ProjectSource；CLI 和 Git 凭据按此项目选择', en: 'ProjectSource of this ticket; selects project CLI and Git credentials' } },
  { key: 'GIT_CONFIG_GLOBAL', ticket: true, description: { zh: '仅包含本项目凭据 helper 的 Git 配置路径', en: 'Git configuration containing only this project credential helper' } },
  { key: 'DSH_SUPERAGENT_DIR', ticket: true, description: { zh: '这个工单的执行目录；执行器 Session 在其中工作', en: 'This ticket\'s directory; the executor Session works in it' } },
  { key: 'DSH_SUPERAGENT_NAME', ticket: true, description: { zh: '工单的短名，也是执行目录的名字', en: 'The ticket\'s short name, also its directory\'s name' } },
  { key: 'DSH_SUPERAGENT_TICKET', ticket: true, description: { zh: '工单 id', en: 'The ticket id' } },
  { key: 'DSH_SUPERAGENT_BLOCKED_COMMANDS', description: { zh: '这个执行环境禁止调用的命令，以空格分隔；不要运行它们', en: 'Commands blocked in this execution environment, separated by spaces; never run them' } },
]
export interface Variable { key: string; value: string; description: Localized; owner: string; hidden?: true }

export const executionRoot = (settings: Settings, stateDir: string): string => settings.executor.directory || join(stateDir, 'work')

/** Lists all declared variables grouped by owner; `enabled` is false for Sources that are currently switched off. */
export function declaredVariables(sources: SourceRegistry, settings?: Settings): { owner: string; enabled: boolean; variables: readonly VariableSpec[] }[] {
  const on = new Set(sources.environments(settings).map(item => item.kind.kind))
  return [{ owner: 'executor', enabled: true, variables: EXECUTOR_VARIABLES },
    ...sources.declarations().map(({ kind, variables }) => ({ owner: kind, enabled: on.has(kind), variables }))]
}

export function environmentOf(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket?: { id: string; name: string; directory: string }; trigger?: Trigger }): Variable[] {
  const { deployment, sources, settings, ticket, trigger } = input
  const projectIds = Object.keys(deployment.projects ?? {})
  const selected = (ticket || trigger || projectIds.length === 1 ? projectForTrigger(deployment, trigger) : undefined)?.id
  const executor: Record<string, string> = { DSH_SUPERAGENT_BLOCKED_COMMANDS: settings.executor.blockedCommands.join(' '), ...ticket ? { DSH_SUPERAGENT_DIR: ticket.directory, DSH_SUPERAGENT_NAME: ticket.name, DSH_SUPERAGENT_TICKET: ticket.id,
    ...(selected ? { DSH_SUPERAGENT_SOURCE: selected, GIT_CONFIG_GLOBAL: workerGitConfig(deployment.stateDir, selected) } : {}) } : {} }
  const result: Variable[] = EXECUTOR_VARIABLES.filter(spec => (!spec.ticket || ticket) && (!['DSH_SUPERAGENT_SOURCE', 'GIT_CONFIG_GLOBAL'].includes(spec.key) || selected)).map(spec => ({ key: spec.key, value: executor[spec.key] ?? '', description: spec.description, owner: 'executor' }))
  for (const { id, kind, environment, config } of sources.environments(settings)) {
    if (deployment.projects && (kind.kind === 'github' || kind.kind === 'gitlab') && (!deployment.projects[id] || (selected ? id !== selected : ticket !== undefined || projectIds.length > 1))) continue
    const bound = kind.kind === 'github' || kind.kind === 'gitlab' ? deploymentForSource(deployment, id) : deployment
    const localTrigger = trigger && id !== kind.kind ? { ...trigger, source: kind.kind, threads: trigger.threads.map(ref => ({ ...ref, source: ref.source === id ? kind.kind : ref.source })) } : trigger
    const values = environment.values({ deployment: bound, config, ...localTrigger ? { trigger: localTrigger } : {} })
    for (const spec of environment.variables) result.push({ key: spec.key, value: values[spec.key] ?? '', description: spec.description, owner: id })
  }
  const project = selected && deployment.projects?.[selected]
  if (ticket && project) {
    const runtime = { ...project.environment, ...(project.configDir ? { [project.provider === 'gitlab' ? 'GLAB_CONFIG_DIR' : 'GH_CONFIG_DIR']: project.configDir } : {}) }
    for (const [key, value] of Object.entries(runtime)) result.push({ key, value, description: { zh: '宿主项目执行配置', en: 'Host project execution configuration' }, owner: project.id, hidden: true })
  }
  return result
}

/** Combines a ticket's fixed directory, name, and origin trigger with the deployment's current settings. */
export function ticketEnvironment(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket: Ticket; trigger?: Trigger }) {
  const { ticket, trigger, ...rest } = input
  const values = { id: ticket.id, name: ticket.execution?.name ?? '', directory: ticket.execution?.directory ?? '' }
  return environmentOf({ ...rest, ticket: values, ...trigger ? { trigger } : {} })
}
export function environmentLines(variables: Variable[]): string {
  return variables.filter(variable => !variable.hidden).map(variable => `- ${variable.key} = ${JSON.stringify(variable.value)}: ${variable.description.en}.`).join('\n')
}
