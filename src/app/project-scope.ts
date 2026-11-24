/** Project ownership helpers shared by model-facing reads, candidate cards, and routing tools. */
import { threadKey, type Decision, type Thread, type Ticket, type Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { projectForTrigger } from '../project-source.ts'
import type { Store } from './store.ts'

export interface ProjectScopeHost {
  readonly projectId?: string
  readonly deployment?: Deployment
  readonly store: Pick<Store, 'triggers' | 'threads' | 'tickets' | 'read'>
}

/** Resolve a Trigger's configured ProjectSource, retaining the legacy single-source identity when no project registry exists. */
export function triggerProjectId(deployment: Deployment | undefined, trigger: Trigger | undefined,
  store?: Pick<Store, 'threads'>): string | undefined {
  if (!trigger) return undefined
  if (typeof trigger.meta.projectBindingError === 'string') return undefined
  if (deployment?.projects) {
    const projects = deployment.projects
    // Inbound Feishu events must carry the binding chosen when they were accepted. Inferring an old
    // Feishu event from today's sole project could move an old thread when chat bindings change.
    if (trigger.source === 'feishu') {
      const named = trigger.meta.projectSourceId
      const refs = trigger.threads.filter(ref => ref.source === 'feishu')
      if (!refs.length) return undefined
      // `undefined` is an old ref with no attribution yet; `null` means contradictory or unknown attribution.
      const owners = refs.map(ref => {
        const thread = store?.threads.get(threadKey(ref))
        if (typeof thread?.meta.projectBindingError === 'string') return null
        const fromMeta = thread?.meta.projectSourceId
        const fromKey = /#project:([a-z0-9-]+)$/.exec(ref.id)?.[1]
        if (fromMeta && fromKey && fromMeta !== fromKey) return null
        const owner = typeof fromMeta === 'string' ? fromMeta : fromKey
        return owner ? projects[owner] ? owner : null : undefined
      })
      if (owners.some(owner => owner === null)) return undefined
      const knownOwners = owners.filter((owner): owner is string => typeof owner === 'string')
      if (new Set(knownOwners).size > 1) return undefined
      if (typeof named === 'string') return projects[named] && knownOwners.every(owner => owner === named) ? named : undefined
      return owners.every(owner => typeof owner === 'string') ? knownOwners[0] : undefined
    }
    if (typeof trigger.meta.projectSourceId === 'string' && trigger.meta.projectSourceId !== trigger.source) return undefined
    if (trigger.source.startsWith('github-') && trigger.threads.some(ref => ref.source === 'github') && projects.github) return 'github'
    if (trigger.source.startsWith('gitlab-') && trigger.threads.some(ref => ref.source === 'gitlab') && projects.gitlab) return 'gitlab'
    try { return projectForTrigger(deployment, trigger)?.id } catch { return undefined }
  }
  if (typeof trigger.meta.projectBindingError === 'string') return undefined
  const named = trigger.meta.projectSourceId
  if (typeof named === 'string') return named
  if (trigger.source.startsWith('github-') && trigger.threads.some(ref => ref.source === 'github')) return 'github'
  if (trigger.source.startsWith('gitlab-') && trigger.threads.some(ref => ref.source === 'gitlab')) return 'gitlab'
  return trigger.source === 'github' || trigger.source === 'gitlab' ? trigger.source : undefined
}

export function ticketProjectId(host: ProjectScopeHost, ticket: Ticket | undefined): string | undefined {
  if (!ticket) return undefined
  const origin = host.store.triggers.get(ticket.origin.triggerId)
  // A Ticket's durable origin is authoritative. Do not guess its owner from follow-up Threads
  // when that Trigger is missing or ambiguous; old bindings must remain fail-closed.
  return triggerProjectId(host.deployment, origin, host.store)
}

export function threadProjectId(host: ProjectScopeHost, thread: Thread | undefined): string | undefined {
  if (!thread) return undefined
  if (typeof thread.meta.projectBindingError === 'string') return undefined
  const projectId = /#project:([a-z0-9-]+)$/.exec(thread.ref.id)?.[1]
  const fromMeta = thread.meta.projectSourceId
  if (fromMeta && projectId && fromMeta !== projectId) return undefined
  const explicit = typeof fromMeta === 'string' ? fromMeta : projectId
  if (explicit) return host.deployment?.projects && !host.deployment.projects[explicit] ? undefined : explicit
  const first = host.store.read.firstTrigger(thread.key)
  const sourceProject = triggerProjectId(host.deployment, first, host.store)
  if (sourceProject) return sourceProject
  return host.deployment?.projects?.[thread.ref.source] ? thread.ref.source : undefined
}

export function decisionProjectId(host: ProjectScopeHost, decision: Decision | undefined): string | undefined {
  if (!decision) return undefined
  const owners = decision.triggerIds.map(id => triggerProjectId(host.deployment, host.store.triggers.get(id), host.store))
  // A mixed, partially migrated, or otherwise unresolvable decision is not safe to project into any Session.
  if (owners.some(owner => owner === undefined)) return undefined
  const projects = [...new Set(owners.filter((id): id is string => !!id))]
  if (projects.length === 1) return projects[0]
  if (projects.length > 1) return undefined
  return threadProjectId(host, host.store.threads.get(decision.threadKey))
}

export function scopedTo(projectId: string | undefined, owner: string | undefined): boolean {
  return projectId === undefined || owner === projectId
}
