/** Registry of installed Source kinds, their configured instances, and the Engine's SourceScope implementation. */
import type { ChannelRef, OutboundMessage, ScopeResult, SourceScope, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { HealthBoard, type HealthEntry } from '../infra/health.ts'
import { AdmissionTableSchema, type Settings } from '../policy.ts'
import { projectSourceId } from '../project-source.ts'
import type { ChannelLink, ChannelLinks, SourceInstance, SourceKind, TriggerContext, VariableSpec } from './kind.ts'


/**
 * Manages registered SourceKind plugins, validates their instance and policy configurations, and implements SourceScope for the Engine.
 * Claims each registered kind's health entries on HealthBoard and mediates access to source channels, links, environment variables, and thread context readers for Runtime, Settings, Outbox, and MasterAssessor.
 */
export class SourceRegistry implements SourceScope {
  private readonly kinds = new Map<string, SourceKind>()
  private readonly health = new Map<string, HealthEntry>()
  constructor(private readonly settings: () => Settings, private readonly board: Pick<HealthBoard, 'claim'> = new HealthBoard(),
    private readonly registered: (kind: SourceKind) => () => void = () => () => {}) {}

  /** Registers a SourceKind, claims its health entries on HealthBoard (rejecting `sync:` prefixes owned by Settings), and returns an unregister disposer. */
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void {
    if (this.kinds.has(kind.kind)) throw new Error(`Source kind already registered: ${kind.kind}`)
    const refused = (name: string) => new Error(`Source kind ${kind.kind} declares the health entry ${name}, which another part reports`)
    const synced = kind.health.find(name => name.startsWith('sync:'))
    if (synced) throw refused(synced)
    const entries = new Map<string, HealthEntry>()
    const release = () => {
      const owned = new Map(entries)
      for (const [name, entry] of this.health) if (kind.health.some(base => name.startsWith(`${base}:`))) owned.set(name, entry)
      for (const [name, entry] of owned) { entry.release(); this.health.delete(name) }
    }
    for (const name of kind.health) {
      try { entries.set(name, this.board.claim(name, { state: 'starting', detail: '' })) }
      catch { release(); throw refused(name) }
    }
    for (const [name, entry] of entries) this.health.set(name, entry)
    this.kinds.set(kind.kind, kind as unknown as SourceKind)
    const unregistered = this.registered(kind as unknown as SourceKind)
    return () => { this.kinds.delete(kind.kind); release(); unregistered() }
  }
  /**
   * Returns the active health entries for `names`. A Source context writes through the entries it received when built,
   * so reports sent after that registration ended do nothing even if the kind registers again.
   */
  healthEntries(names: readonly string[], source?: string): Map<string, HealthEntry> {
    return new Map(names.flatMap(name => {
      const key = source ? `${name}:${source}` : name
      if (source && this.health.has(name) && !this.health.has(key)) this.health.set(key, this.board.claim(key, { state: 'starting', detail: '' }))
      const entry = this.health.get(key); return entry ? [[name, entry] as const] : []
    }))
  }
  kind(id: string): SourceKind | undefined { return this.kinds.get(this.settings().sources[id]?.kind ?? id) }
  private kindFor(id: string, settings: Settings): SourceKind | undefined { return this.kinds.get(settings.sources[id]?.kind ?? id) }
  project(source: string): string | undefined {
    const provider = this.settings().sources[source]?.kind ?? source
    return provider === 'github' || provider === 'gitlab' ? source : undefined
  }
  /** Every registered kind's instance ordered by ID, followed by stored instances whose kind is not installed (with their config kept as stored). */
  instances(settings = this.settings()): (SourceInstance & { installed: boolean })[] {
    const installed = [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => {
      const stored = Object.entries(settings.sources).filter(([id, value]) => (value.kind ?? id) === kind.kind)
      return (stored.length ? stored : [[kind.kind, undefined] as const]).map(([id, value]) => ({ ...this.resolve(kind, value, id), installed: true }))
    })
    const orphaned = Object.entries(settings.sources).filter(([id]) => !this.kindFor(id, settings)).map(([id, stored]) => ({ id, kind: stored.kind ?? id, enabled: stored.enabled, config: stored.config, installed: false }))
    return [...installed, ...orphaned]
  }
  instance<C extends Record<string, unknown>>(id: string, settings = this.settings()): SourceInstance<C> | undefined {
    const kind = this.kindFor(id, settings)
    return kind ? this.resolve(kind, settings.sources[id], id) as SourceInstance<C> : undefined
  }
  validate(id: string, value: { kind?: string; enabled: boolean; config: unknown }): { kind?: string; enabled: boolean; config: Record<string, unknown> } {
    const kind = value.kind ? this.kinds.get(value.kind) : this.kind(id)
    if (!kind) throw new Error(`Source kind not installed: ${id}`)
    const config = kind.schema.parse(value.config)
    const existing = this.settings().sources[id]
    if (existing && (existing.kind ?? id) !== kind.kind) throw new Error('不能修改现有 Source 的 Provider')
    if (id !== kind.kind && (kind.kind === 'github' || kind.kind === 'gitlab')) {
      const expected = projectSourceId(kind.kind, String(config.host ?? (kind.kind === 'github' ? 'github.com' : '')), String(config.repository ?? ''))
      if (id !== expected) throw new Error('项目身份与配置不一致；请创建新的 ProjectSource')
    }
    return { ...(id !== kind.kind ? { kind: kind.kind } : {}), enabled: value.enabled, config }
  }
  /** 验证项目独立的策略，不回退到其他项目的权限。 */
  validatePolicy(parts: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown> & { allowed: { id: string; name?: string }[] }> {
    return Object.fromEntries(Object.entries(parts).map(([id, part]) => {
      const policy = this.kind(id)?.policy
      // `admission` is validated by the Policy's own schema (shared across all kinds), while the kind validates the rest of its part.
      const { admission, ...rest } = part
      return [id, policy ? { ...policy.schema.parse(rest), admission: AdmissionTableSchema.parse(admission ?? {}) } : part as Record<string, unknown> & { allowed: { id: string; name?: string }[] }]
    }))
  }
  policyPart(id: string, settings = this.settings()) {
    const policy = this.kindFor(id, settings)?.policy
    if (!policy) return undefined
    const { admission, ...rest } = settings.policy.sources[id] ?? {}
    const parsed = policy.schema.safeParse(rest)
    return { ...parsed.success ? parsed.data : policy.schema.parse({}), admission: AdmissionTableSchema.safeParse(admission ?? {}).data ?? {} }
  }
  channelAllowed(channel: { source: string; address: Record<string, string> }, settings = this.settings()): boolean {
    const kind = this.kindFor(channel.source, settings)
    if (!kind) return false
    const instance = this.resolve(kind, settings.sources[channel.source], channel.source)
    return instance.enabled && (kind.channel?.allowed?.(channel.address, instance.config) ?? true)
  }
  /** Environment variable declarations for every installed kind, whether enabled or disabled. */
  declarations(): { kind: string; variables: readonly VariableSpec[] }[] {
    return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => kind.environment ? [{ kind: kind.kind, variables: kind.environment.variables }] : [])
  }
  environments(settings = this.settings()) {
    return this.instances(settings).flatMap(instance => {
      const kind = this.kindFor(instance.id, settings)
      return kind?.environment && instance.enabled ? [{ id: instance.id, kind, environment: kind.environment, config: instance.config }] : []
    })
  }

  /**
   * Sends a message idempotently through its Channel's kind; returns `'waiting'` while the kind is not installed, or
   * `'gone'` when the target (or a kind without channels) can never receive it.
   */
  async send(message: OutboundMessage, commands: Commands): Promise<'sent' | 'gone' | 'waiting'> {
    const kind = this.kind(message.channel.source)
    if (!kind) return 'waiting'
    return kind.channel ? kind.channel.send({ commands: this.forSource(commands, message.channel.source) }, message) : 'gone'
  }
  link(channel: ChannelRef, links: ChannelLinks): ChannelLink {
    const config = this.instance(channel.source)?.config
    const link = this.kind(channel.source)?.channel?.link(channel.address, { ...links,
      ...(typeof config?.repository === 'string' && config.repository ? { repository: config.repository } : {}) })
    return link ?? { url: '', label: { zh: channel.source, en: channel.source } }
  }
  find(query: string): { threads: string[]; terms: string[] } {
    const found = this.instances().flatMap(instance => {
      const kind = this.kind(instance.id)
      if (!kind?.find) return []
      const found = kind.find(query)
      return [{ ...found, threads: found.threads.map(thread => instance.id !== kind.kind && thread.startsWith(`${kind.kind}:`) ? `${instance.id}:${thread.slice(kind.kind.length + 1)}` : thread) }]
    })
    return { threads: [...new Set(found.flatMap(item => item.threads))], terms: [...new Set(found.flatMap(item => item.terms))] }
  }
  repliesTo(trigger: Trigger): string | undefined { return this.kind(trigger.source)?.repliesTo?.(trigger) }
  threadContext(trigger: Trigger, settings = this.settings()): TriggerContext | undefined {
    const kind = this.kindFor(trigger.source, settings)
    const context = kind?.threadContext
    if (!kind || !context) return undefined
    const { config } = this.resolve(kind, settings.sources[trigger.source], trigger.source)
    return {
      messageId: context.messageId(trigger),
      read: (commands, part, cursor) => context.read(this.forSource(commands, trigger.source), trigger, part, cursor, config),
      images: text => context.images?.(text) ?? [],
      image: async (agent, commands, message, key, stateDir, signal) => {
        if (!context.image) throw new Error(`The ${kind.kind} Source has no images`)
        return context.image(agent, this.forSource(commands, trigger.source), trigger, message, key, stateDir, signal)
      },
    }
  }
  /** Project Providers need bound credentials; other kinds keep the host Commands instance. */
  private forSource(commands: Commands, source: string): Commands {
    const provider = this.settings().sources[source]?.kind ?? source
    return (provider === 'github' || provider === 'gitlab') && typeof commands.forSource === 'function'
      ? commands.forSource(source) : commands
  }
  scope(input: { source: string; meta: Record<string, unknown> }, settings = this.settings()): ScopeResult {
    const kind = this.kindFor(input.source, settings)
    const stored = settings.sources[input.source]
    // Without its kind plugin the stored scope cannot be evaluated, so a configured Source whose plugin is missing listens to nothing.
    if (!kind) return stored ? { listened: false, reason: 'source_not_installed' } : { listened: true, observed: false }
    const instance = this.resolve(kind, stored, input.source)
    if (!instance.enabled) return { listened: false, reason: 'source_disabled' }
    return kind.scope ? kind.scope({ meta: input.meta }, instance.config) : { listened: true, observed: false }
  }
  /** Falls back to schema defaults and disables the instance when stored configuration fails validation. */
  private resolve(kind: SourceKind, stored: { enabled: boolean; config: Record<string, unknown> } | undefined, id = kind.kind): SourceInstance {
    const parsed = kind.schema.safeParse(stored?.config ?? {})
    return { id, kind: kind.kind, enabled: parsed.success && (stored?.enabled ?? true), config: parsed.success ? parsed.data : kind.schema.parse({}) }
  }
}
