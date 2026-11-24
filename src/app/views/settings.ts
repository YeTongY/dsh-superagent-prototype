/** Settings view combining versioned configuration blocks, per-source forms and policy metadata, and execution environment details. */
import { SETUP_FIELDS } from '../../deployment.ts'
import { deploymentForSource } from '../../project-source.ts'
import { KV } from '../../kv.ts'
import { policyVersion } from '../../policy.ts'
import type { SourceRegistry } from '../../sources/registry.ts'
import { declaredVariables, executionRoot } from '../execution-environment.ts'
import { feishuProjectForChat, type FeishuConfig, type FeishuBindingError } from '../../sources/feishu.ts'
import type { Store } from '../store.ts'
import { problemOf, sourceHealth, type HealthMap, type SetupState } from './sources.ts'

export interface ProjectOrchestratorView {
  project_source_id: string
  repository: string
  host?: string
  session_id: string
  status: 'running' | 'idle' | 'missing' | 'error'
  enabled: boolean
  ready: boolean
  error?: string
}

interface FeishuProjectBindingView {
  chat_id: string
  chat_name: string
  project_source_id?: string
  project_label?: string
  problem?: FeishuBindingError | 'session_not_ready' | 'session_disabled'
  session?: ProjectOrchestratorView
}

function feishuBindings(config: FeishuConfig, deployment: SetupState['deployment'], sessions: ProjectOrchestratorView[],
  settings: ReturnType<Store['settings']>): FeishuProjectBindingView[] {
  const sessionByProject = new Map(sessions.map(session => [session.project_source_id, session]))
  return config.chats.map(chat => {
    const binding = deployment ? feishuProjectForChat(deployment, config.chats, chat.chatId)
      : { projectSourceId: chat.projectSourceId, error: 'project_not_ready' as const }
    const id = binding.projectSourceId ?? chat.projectSourceId
    const project = id ? deployment?.projects?.[id] : undefined
    const legacy = id === 'github' && !!deployment && deployment.projects === undefined && !!deployment.repository
    const source = id ? settings.sources[id] : undefined
    const session = id ? sessionByProject.get(id) : undefined
    const problem = binding.error ?? (!id ? 'project_not_bound' : !project && !legacy ? 'project_not_ready'
      : session?.enabled === false ? 'session_disabled' : session && !session.ready ? 'session_not_ready' : undefined)
    const projectLabel = id ? project ? `${project.provider}:${project.host}/${project.project} (${id})`
      : legacy ? `github:github.com/${deployment.repository} (${id})`
      : `${id} (${source?.enabled === false ? 'disabled' : 'unknown or not ready'})` : undefined
    return { chat_id: chat.chatId, chat_name: chat.name || chat.chatId,
      ...(id ? { project_source_id: id, project_label: projectLabel } : {}), ...(problem ? { problem } : {}),
      ...(session ? { session } : {}) }
  })
}

function policyOf(sources: SourceRegistry, id: string, health: HealthMap) {
  const policy = sources.kind(id)?.policy
  if (!policy) return {}
  const part = sources.policyPart(id)!
  const config = sources.instance(id)?.config ?? {}
  const sync = policy.sync && { label: policy.sync.label, ready: policy.sync.ready(part), health: health[`sync:${id}`] }
  return { policy: { fields: policy.fields, explicit: policy.explicit, ...policy.rows ? { rows: policy.rows(config) } : {}, ...sync
    ? { sync } : {} } }
}
/**
 * Builds the settings view by block (`{ value, revision }`), per-Source configuration and restart-sensitive fields,
 * and execution environment details (`stateDir` provides the default ticket working directory root).
 */
export function settingsView(store: Store, sources: SourceRegistry, health: HealthMap, setup: SetupState, stateDir: string,
  projectOrchestrators: ProjectOrchestratorView[] = []) {
  const settings = store.settings()
  const block = <V>(name: 'policy' | 'eval' | 'executor', value: V) => ({ value, revision: store.blockRevision(name) })
  return {
    policyVersion: policyVersion(settings),
    blocks: { policy: block('policy', settings.policy), eval: block('eval', settings.eval), executor: block('executor',
      settings.executor) },
    project_orchestrators: projectOrchestrators,
    sources: sources.instances(settings).map(instance => {
      const kind = sources.kind(instance.kind)
      const problem = problemOf(instance.id, setup)
      const { id, title } = sourceHealth(sources, instance, health)
      const fields = kind?.fieldsFor?.(setup.deployment, instance.config) ?? kind?.fields ?? []
      const config = instance.kind === 'feishu'
        ? (() => {
          const feishu = instance.config as unknown as FeishuConfig
          const binding = setup.deployment && feishu.chats.length === 1
            ? feishuProjectForChat(setup.deployment, feishu.chats, feishu.chats[0]!.chatId) : undefined
          return binding?.legacy && binding.projectSourceId ? { ...instance.config,
            chats: feishu.chats.map(chat => ({ ...chat, projectSourceId: binding.projectSourceId })) } : instance.config
        })()
        : instance.config
      return { id, kind: instance.kind, title, description: kind?.description ?? { zh: '', en: '' }, installed: instance.installed,
        value: { enabled: instance.enabled, config }, revision: store.blockRevision(`source:${instance.id}`),
        restarts: SETUP_FIELDS[instance.kind] ?? [], fields, facts: kind?.facts?.(setup.deployment && (!setup.deployment.projects || setup.deployment.projects[instance.id]) ? deploymentForSource(setup.deployment, instance.id) : undefined) ?? {},
        labels: store.get(KV.sources.labels(instance.id)) ?? {}, ...instance.kind === 'feishu' ? {
          projectBindings: feishuBindings(instance.config as unknown as FeishuConfig, setup.deployment, projectOrchestrators, settings),
        } : {}, ...problem ? { problem } : {}, ...policyOf(sources, instance.id, health) }
    }),
    environment: { root: executionRoot(settings, stateDir), variables: declaredVariables(sources, settings) },
  }
}
export type SettingsView = ReturnType<typeof settingsView>
export type SourceSettingsView = SettingsView['sources'][number]
