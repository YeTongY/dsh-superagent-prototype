/** Provider 使用原生局部身份；此边界负责持久化的项目隔离。 */
import type { ChannelRef, ThreadRef, Ticket, Trigger } from '../core/index.ts'
import type { Family, Key } from '../kv.ts'
import { deploymentForSource, projectTrigger } from '../project-source.ts'
import type { SourceContext } from './host.ts'

export function projectContext(base: SourceContext, provider: string, id: string): SourceContext {
  if (provider !== 'github' && provider !== 'gitlab') return base
  // Deployments created before ProjectSource support have no project registry; keep their original
  // single GitHub context intact. Runtime deployments with a registry still scope a legacy `github`
  // instance so it cannot see the other projects' tickets.
  if (provider === 'github' && id === 'github') {
    try { if (base.configured() && !base.deployment.projects) return base }
    catch { /* A test or pre-setup context may not yet expose deployment readiness; defer to the scoped wrapper. */ }
  }
  // `github` is the pre-ProjectSource identity. Keep its unscoped KV and message IDs readable while
  // still filtering its tickets when it coexists with other projects. A GitLab instance named
  // `gitlab` is new configuration and uses the normal project namespace.
  const legacyGithub = provider === 'github' && id === 'github'
  const baseIdentity = id === provider
  const scoped = (key: string) => {
    if (key.startsWith(`${provider}:`)) return `${id}:${key.slice(provider.length + 1)}`
    if (key.startsWith(`${id}:`)) return key
    throw new Error('不能访问其他项目的 Thread')
  }
  const local = (key: string) => key.startsWith(`${id}:`) ? `${provider}:${key.slice(id.length + 1)}` : key
  const triggerId = (value: string) => baseIdentity || value.startsWith(`${id}/`) ? value : `${id}/${value}`
  const localId = (value: string) => !baseIdentity && value.startsWith(`${id}/`) ? value.slice(id.length + 1) : value
  const channel = (value: ChannelRef): ChannelRef => ({ ...value, source: value.source === id ? provider : value.source, thread: local(value.thread) })
  const ref = (value: ThreadRef): ThreadRef => {
    if (value.source !== provider && value.source !== id) throw new Error('不能访问其他项目的 Thread')
    return { ...value, source: id }
  }
  const trigger = (value: Trigger | undefined): Trigger | undefined => value && ({ ...value, id: localId(value.id), source: provider,
    actor: { ...value.actor, source: provider }, threads: value.threads.map(item => ({ ...item, source: provider })),
    ...value.channel ? { channel: channel(value.channel) } : {} })
  const getTrigger = (key: string): Trigger | undefined => {
    const exact = base.triggers.get(key)
    if (exact?.source === id) return trigger(exact)
    if (exact && (baseIdentity || key.includes('/'))) return undefined
    const namespaced = base.triggers.get(triggerId(key))
    return namespaced?.source === id ? trigger(namespaced) : undefined
  }
  const soleProject = () => {
    try {
      if (!base.configured()) return false
      const projectIds = Object.keys(base.deployment.projects ?? {})
      return projectIds.length === 1 && projectIds[0] === id
    } catch { return false }
  }
  const owns = (ticket: Ticket) => {
    const origin = base.triggers.get(ticket.origin.triggerId)
    const unboundOrigin = !origin || !/^(?:github|gitlab)(?:-|$)/.test(origin.source)
    return origin?.source === id || ticket.follows?.some(follow => follow.thread.startsWith(`${id}:`)) === true || (unboundOrigin && soleProject())
  }
  const ticket = (value: Ticket | undefined): Ticket | undefined => value && owns(value) ? ({ ...value,
    origin: { triggerId: localId(value.origin.triggerId), triggerIds: value.origin.triggerIds.map(localId) },
    channels: value.channels.filter(item => item.source === id || (item.source !== provider && !item.source.startsWith(`${provider}-`))).map(channel),
    ...value.follows ? { follows: value.follows.filter(item => !item.thread.startsWith(`${provider}-`) || item.thread.startsWith(`${id}:`)).map(item => ({ ...item, thread: local(item.thread) })) } : {} }) : undefined
  const prefix = legacyGithub ? '' : `project:${id}:`
  const stateKey = <V>(key: Key<V>): Key<V> => `${prefix}${key}` as Key<V>
  return {
    sourceId: id, ready: base.ready, atomic: base.atomic, report: base.report,
    get deployment() { return deploymentForSource(base.deployment, id) },
    get commands() { return base.commands.forSource(id) },
    get problem() { return base.problem },
    configured: () => base.configured() && (!base.deployment.projects || !!base.deployment.projects[id]),
    config: <C extends Record<string, unknown>>(_kind: string) => base.config<C>(id),
    receive: value => base.receive(projectTrigger(value, id)),
    state: {
      get: key => base.state.get(stateKey(key)), set: (key, value) => base.state.set(stateKey(key), value),
      keys: <V>(family: Family<V, never>) => base.state.keys(Object.assign(() => '', { prefix: `${prefix}${family.prefix}` }) as Family<V, never>).map(key => key.slice(prefix.length) as Key<V>),
    },
    threads: {
      get: key => { const value = base.threads.get(scoped(key)); return value && { ...value, key: local(value.key), ref: { ...value.ref, source: provider } } },
      subscribed: () => base.threads.subscribed(id).map(value => ({ ...value, key: local(value.key), ref: { ...value.ref, source: provider } })),
      describe: (key, value) => base.threads.describe(scoped(key), value), patch: (key, value) => base.threads.patch(scoped(key), value),
    },
    tickets: {
      get: key => ticket(base.tickets.get(key)), open: () => base.tickets.open().flatMap(value => ticket(value) ?? []),
      bindThread: (key, value, own) => { if (!ticket(base.tickets.get(key))) throw new Error('不能绑定其他项目的工单'); base.tickets.bindThread(key, ref(value), own) },
      threadClosed: (value, outcome, at) => base.tickets.threadClosed(ref(value), outcome, at),
    },
    triggers: { get: getTrigger, latest: key => {
      const value = base.triggers.latest(scoped(key))
      return value?.source === id ? trigger(value) : undefined
    } },
    notify: value => base.notify({ ...value, id: baseIdentity ? value.id : `${id}/${value.id}`,
      channel: value.channel.source === provider ? { ...value.channel, source: id, thread: scoped(value.channel.thread) } : value.channel }),
  }
}
