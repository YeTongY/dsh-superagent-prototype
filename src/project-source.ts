/** 项目身份与执行环境的唯一边界；不保存任何认证 Secret。 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Deployment } from './deployment.ts'
import type { Trigger } from './core/index.ts'

export type ProjectProvider = 'github' | 'gitlab'
const ENVIRONMENT_KEYS = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'GIT_SSL_CAINFO'])
export const ProjectEnvironmentSchema = z.record(z.string(), z.string()).refine(value => Object.keys(value).every(key => ENVIRONMENT_KEYS.has(key)), '仅允许代理和 CA 环境变量').default({})
export function normalizeHost(host: string): string {
  const value = host.trim().toLowerCase().replace(/\/$/, '')
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/.test(value)) throw new Error('项目 host 必须为主机名，可包含端口')
  return value
}
export function normalizeProject(project: string): string {
  const value = project.trim().replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(value) || value.split('/').some(part => part === '.' || part === '..')) throw new Error('项目必须为完整 group/name 路径')
  return value.toLowerCase()
}
export function projectSourceId(provider: ProjectProvider, host: string, project: string): string {
  return `${provider}-${createHash('sha256').update(`${normalizeHost(host)}/${normalizeProject(project)}`).digest('hex').slice(0, 24)}`
}
export interface ProjectSource {
  id: string; provider: ProjectProvider; host: string; project: string; cli: string
  configDir?: string; environment?: Record<string, string>
}
export interface ResolvedProject extends ProjectSource { login: string; noreply: string }
/** 所有 Ticket/工具入口共用的项目选择规则，未知身份不能落到默认账号。 */
export function projectForTrigger(deployment: Deployment, trigger?: Trigger): ResolvedProject | undefined {
  if (!deployment.projects) return undefined
  if (trigger && deployment.projects[trigger.source]) return deployment.projects[trigger.source]
  const named = trigger?.meta.projectSourceId
  if (typeof named === 'string') {
    const project = deployment.projects[named]
    if (!project) throw new Error(`项目尚未完成部署检查：${named}`)
    return project
  }
  if (trigger && /^(github|gitlab)(?:-|$)/.test(trigger.source)) throw new Error(`项目尚未完成部署检查：${trigger.source}`)
  const projects = Object.values(deployment.projects)
  if (projects.length === 1) return projects[0]
  if (projects.length > 1) throw new Error('工单未绑定具体项目；请在项目来源中发起请求，或指定 projectSourceId')
  return undefined
}
/** 旧配置无 projects 字段时保持原有行为；显式项目必须精确匹配。 */
export function deploymentForSource(deployment: Deployment, source?: string): Deployment {
  if (!source || source === 'feishu') return deployment
  const project = deployment.projects?.[source]
  if (!project) {
    if (deployment.projects) throw new Error(`项目尚未完成部署检查：${source}`)
    return deployment
  }
  return { ...deployment, activeProject: project, repository: project.project,
    github: { cli: project.cli, login: project.login, noreply: project.noreply } }
}
/** 在 Source 边界赋予项目身份，保留 Provider 原生编号作为元数据。 */
export function projectTrigger(trigger: Trigger, source: string): Trigger {
  if (trigger.source === source) return trigger
  const provider = trigger.source
  const thread = (value: string) => value.startsWith(`${provider}:`) ? `${source}:${value.slice(provider.length + 1)}` : value
  return { ...trigger, id: `${source}/${trigger.id}`, source,
    actor: { ...trigger.actor, source }, threads: trigger.threads.map(ref => ({ ...ref, source })),
    ...trigger.channel ? { channel: { ...trigger.channel, source, thread: thread(trigger.channel.thread) } } : {},
    meta: { ...trigger.meta, projectSourceId: source, provider } }
}
