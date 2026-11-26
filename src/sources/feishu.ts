/** Feishu source kind definition, policy synchronization, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { threadKey, type ThreadRef, type Trigger } from '../core/index.ts'
import { FeishuBotSchema } from '../deployment.ts'
import type { Deployment } from '../deployment.ts'
import { feishuLink, sendFeishu } from './feishu-channel.ts'
import { feishuThreadContext } from './feishu-read.ts'
import { refreshChatNames, runFeishu } from './feishu-loops.ts'
import { SOURCE, feishuTriggerId } from './feishu-trigger.ts'
import { sourceContext, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import type { SourceRegistry } from './registry.ts'

export { SOURCE, feishuRef, feishuThreadId, feishuTime, feishuTrigger, feishuTriggerId, historyEvent, withMentionNames }
  from './feishu-trigger.ts'
export type { FeishuEvent } from './feishu-trigger.ts'
export { backfillChat, consumerRetry, pollThreads, refreshChatNames, threadRef } from './feishu-loops.ts'
const MembersSchema = z.looseObject({
  users: z.array(z.looseObject({ member_id: z.string(), name: z.string() })),
  has_more: z.boolean(), truncations: z.array(z.unknown()).optional(),
})
const ProjectSourceIdSchema = z.union([z.literal('github'), z.literal('gitlab'), z.string().regex(/^(github|gitlab)-[a-f0-9]{24}$/)])
const FeishuConfigSchema = FeishuBotSchema.extend({
  readPageSize: z.number().int().min(1).max(50).default(20),
  linkTimeoutMs: z.number().int().min(1).max(90000).default(5000),
  chats: z.array(z.object({ chatId: z.string().regex(/^oc_[a-zA-Z0-9]+$/), name: z.string().trim().max(60).optional(),
    projectSourceId: z.preprocess(value => value === '' ? undefined : value, ProjectSourceIdSchema.optional()),
    listen: z.enum(['mentions', 'all']) }).strict())
    .refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs')
    .refine(chats => new Set(chats.flatMap(chat => chat.projectSourceId ? [chat.projectSourceId] : [])).size
      === chats.filter(chat => chat.projectSourceId).length, 'A ProjectSource may be bound to only one Feishu chat')
    .default([]),
  directMessages: z.boolean().default(true),
  otherChats: z.enum(['none', 'mentions']).default('none'),
}).strict()
export type FeishuConfig = z.infer<typeof FeishuConfigSchema>
export type FeishuBindingError = 'project_not_bound' | 'project_not_ready' | 'project_unknown' | 'project_binding_ambiguous'
  | 'project_binding_stale'
export interface FeishuProjectBinding { projectSourceId?: string; error?: FeishuBindingError; legacy?: true }
type FeishuProjectChat = FeishuConfig['chats'][number]

/** Resolves an explicitly bound group, or the deterministic old single-project/single-group and private-chat cases. */
export function feishuProjectForChat(deployment: Deployment, chats: readonly FeishuProjectChat[], chatId: string,
  direct = false): FeishuProjectBinding {
  const legacyGithub = deployment.projects === undefined && !Object.keys(deployment.projectProblems ?? {}).length
    && deployment.repository ? ['github'] : []
  const configured = [...new Set([...Object.keys(deployment.projects ?? {}), ...Object.keys(deployment.projectProblems ?? {}), ...legacyGithub])]
  let id: string | undefined
  let legacy = false
  if (direct) {
    if (configured.length === 1) { id = configured[0]; legacy = true }
  } else {
    const matches = chats.filter(chat => chat.chatId === chatId)
    if (matches.length > 1) return { error: 'project_binding_ambiguous' }
    id = matches[0]?.projectSourceId
    // Old deployments had one project and one configured group, with no projectSourceId field.
    if (!id && matches.length === 1 && chats.length === 1 && configured.length === 1) {
      id = configured[0]
      legacy = true
    }
  }
  if (!id) return { error: 'project_not_bound' }
  if (deployment.projects?.[id] || (id === 'github' && legacyGithub.length > 0)) {
    return { projectSourceId: id, ...(legacy ? { legacy: true as const } : {}) }
  }
  return { projectSourceId: id, error: deployment.projectProblems?.[id] ? 'project_not_ready' : 'project_unknown',
    ...(legacy ? { legacy: true as const } : {}) }
}

function projectIn(value: Trigger | undefined, context: Pick<SourceContext, 'threads'>): { projectSourceId?: string; refs: ThreadRef[];
  conflict: boolean } {
  if (!value) return { refs: [], conflict: false }
  const refs = value.threads.filter(ref => ref.source === SOURCE)
  const ids = new Set<string>()
  if (typeof value.meta.projectSourceId === 'string') ids.add(value.meta.projectSourceId)
  for (const ref of refs) {
    const suffix = /#project:([a-z0-9-]+)$/.exec(ref.id)?.[1]
    if (suffix) ids.add(suffix)
    const id = context.threads.get(threadKey(ref))?.meta.projectSourceId
    if (typeof id === 'string') ids.add(id)
  }
  return { projectSourceId: ids.size === 1 ? [...ids][0] : undefined, refs, conflict: ids.size > 1 }
}

/** Stamps trusted ProjectSource identity before ingestion and keeps an already established Feishu topic on its original project. */
export function bindFeishuProject(trigger: Trigger, deployment: Deployment, config: FeishuConfig,
  context: Pick<SourceContext, 'threads' | 'triggers'>): Trigger {
  if (trigger.source !== SOURCE) return trigger
  // Native/legacy Deployments have no project map. Keep source translation unchanged there; the Runtime resolves
  // the old implicit GitHub owner separately. Resolve project metadata only for the uniquely inferable old
  // single-project/single-chat configuration; explicit bindings still use the strict resolver below.
  if (deployment.projects === undefined && !Object.keys(deployment.projectProblems ?? {}).length
    && !config.chats.some(chat => chat.projectSourceId)
    && !(deployment.repository && config.chats.length === 1) && trigger.meta.direct !== true) return trigger
  const storedSelf = context.triggers.get(trigger.id)
  if (storedSelf) {
    const known = projectIn(storedSelf, context)
    if (known.conflict) return { ...storedSelf, meta: { ...storedSelf.meta, projectBindingError: 'project_binding_ambiguous' } }
    if (known.projectSourceId) return typeof storedSelf.meta.projectSourceId === 'string' ? storedSelf
      : { ...storedSelf, meta: { ...storedSelf.meta, projectSourceId: known.projectSourceId } }
    if (typeof storedSelf.meta.projectBindingError === 'string') return storedSelf
    const chatId = typeof storedSelf.meta.chatId === 'string' ? storedSelf.meta.chatId : ''
    const legacy = feishuProjectForChat(deployment, config.chats, chatId, storedSelf.meta.direct === true)
    if (!legacy.legacy || config.chats.some(chat => chat.chatId === chatId && chat.projectSourceId)) {
      // A message already stored without project identity cannot inherit a new explicit group binding.
      return { ...storedSelf, meta: { ...storedSelf.meta, projectBindingError: 'project_binding_ambiguous' } }
    }
    if (legacy.projectSourceId) return { ...storedSelf, meta: { ...storedSelf.meta, projectSourceId: legacy.projectSourceId,
      projectBindingLegacy: true } }
  }
  const chatId = typeof trigger.meta.chatId === 'string' ? trigger.meta.chatId : ''
  const direct = trigger.meta.direct === true
  const rootId = typeof trigger.meta.rootId === 'string' ? trigger.meta.rootId
    : typeof trigger.meta.messageId === 'string' ? trigger.meta.messageId : undefined
  const parentId = typeof trigger.meta.parentId === 'string' ? trigger.meta.parentId : undefined
  const stored = [...(rootId ? [context.triggers.get(feishuTriggerId(rootId))] : []),
    ...(parentId ? [context.triggers.get(feishuTriggerId(parentId))] : [])].filter((item): item is Trigger => !!item && item.id !== trigger.id)
  const owners = stored.map(item => projectIn(item, context))
  const ownerIds = new Set(owners.flatMap(owner => owner.projectSourceId ? [owner.projectSourceId] : []))
  const conflict = owners.some(owner => owner.conflict) || ownerIds.size > 1
  const current = feishuProjectForChat(deployment, config.chats, chatId, direct)
  const hasOldThread = stored.length > 0 || owners.some(owner => owner.refs.some(ref => context.threads.get(threadKey(ref))))
  // Only an untouched old configuration has a safe implicit group mapping. An explicit rebind cannot identify which
  // ProjectSource owns older messages that were stored before project attribution existed.
  const legacySafe = current.legacy === true && !config.chats.some(chat => chat.chatId === chatId && chat.projectSourceId)
  const historicalProject = ownerIds.size === 1 ? [...ownerIds][0] : undefined
  const stale = historicalProject && (current.projectSourceId !== historicalProject || !!current.error
    && current.error !== 'project_not_ready')
  const projectSourceId = !conflict ? historicalProject ?? (hasOldThread && !legacySafe ? undefined : current.projectSourceId) : undefined
  const error = conflict ? 'project_binding_ambiguous'
    : stale ? 'project_binding_stale'
      : projectSourceId ? deployment.projects?.[projectSourceId]
        || (projectSourceId === 'github' && deployment.projects === undefined && !!deployment.repository)
        ? current.projectSourceId === projectSourceId ? current.error : undefined
        : deployment.projectProblems?.[projectSourceId] ? 'project_not_ready' : 'project_unknown'
        : hasOldThread && !legacySafe ? 'project_binding_ambiguous' : current.error ?? 'project_not_bound'
  const knownRef = owners.flatMap(owner => owner.refs).find(ref => ref.source === SOURCE)
  const multipleProjects = new Set([...Object.keys(deployment.projects ?? {}), ...Object.keys(deployment.projectProblems ?? {})]).size > 1
  const messageId = typeof trigger.meta.messageId === 'string' ? trigger.meta.messageId : ''
  const physicalId = chatId && (rootId || messageId) ? `${chatId}:${rootId ?? messageId}` : undefined
  const threads = trigger.threads.map(ref => {
    if (ref.source !== SOURCE) return ref
    const base = knownRef?.id ?? physicalId ?? ref.id
    const physical = base.replace(/#project:[a-z0-9-]+$/, '')
    // Preserve an established ThreadRef exactly. Adding/removing the suffix during a project-count change would
    // detach existing Ticket subscriptions from the same Feishu topic.
    const id = knownRef?.id ?? (projectSourceId && multipleProjects ? `${physical}#project:${projectSourceId}` : physical)
    return { ...ref, id }
  })
  const sourceMeta = { ...trigger.meta }
  delete sourceMeta.projectSourceId
  delete sourceMeta.projectBindingError
  delete sourceMeta.projectBindingLegacy
  const legacyBinding = !!projectSourceId && current.legacy === true
    && !config.chats.some(chat => chat.chatId === chatId && chat.projectSourceId) && !error
  return { ...trigger, threads,
    meta: { ...sourceMeta, ...(projectSourceId ? { projectSourceId } : {}), ...(legacyBinding ? { projectBindingLegacy: true } : {}),
      ...(error ? { projectBindingError: error } : {}) } }
}

/** Resolves the ProjectSource for a stored or incoming Feishu Trigger without changing its durable payload. */
export function feishuProjectForTrigger(trigger: Trigger, deployment: Deployment, config: FeishuConfig,
  context: Pick<SourceContext, 'threads' | 'triggers'>): FeishuProjectBinding {
  if (trigger.source !== SOURCE) return { error: 'project_not_bound' }
  const bound = bindFeishuProject(trigger, deployment, config, context)
  const id = typeof bound.meta.projectSourceId === 'string' ? bound.meta.projectSourceId : undefined
  const rawError = bound.meta.projectBindingError
  const error = typeof rawError === 'string' ? rawError as FeishuBindingError : undefined
  if (error) return { ...(id ? { projectSourceId: id } : {}), error }
  if (!id && deployment.projects === undefined && !Object.keys(deployment.projectProblems ?? {}).length
    && !config.chats.some(chat => chat.projectSourceId)) {
    const chatId = typeof trigger.meta.chatId === 'string' ? trigger.meta.chatId : ''
    return feishuProjectForChat(deployment, config.chats, chatId, trigger.meta.direct === true)
  }
  if (!id) return { error: 'project_not_bound' }
  if (deployment.projects?.[id] || (id === 'github' && deployment.projects === undefined
    && !Object.keys(deployment.projectProblems ?? {}).length && !!deployment.repository)) return { projectSourceId: id }
  return { projectSourceId: id, error: deployment.projectProblems?.[id] ? 'project_not_ready' : 'project_unknown' }
}

const projectChoices = (deployment: Deployment | undefined, chats: readonly FeishuProjectChat[]) => {
  const choices = new Map<string, Localized>()
  const entries = Object.entries(deployment?.projects ?? {})
  const counts = new Map<string, number>()
  for (const [, project] of entries) {
    const key = `${project.provider}:${project.host}/${project.project}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const [id, project] of entries) {
    const key = `${project.provider}:${project.host}/${project.project}`
    const hostSuffix = project.provider === 'gitlab' ? project.host : 'GitHub'
    const base = `${project.project} (${hostSuffix})`
    const value = (counts.get(key) ?? 0) > 1 ? `${base} · ${id.slice(0, 12)}` : base
    choices.set(id, { zh: value, en: value })
  }
  for (const id of Object.keys(deployment?.projectProblems ?? {})) {
    if (!choices.has(id)) choices.set(id, { zh: `${id}（未就绪）`, en: `${id} (not ready)` })
  }
  if (deployment && deployment.projects === undefined && !Object.keys(deployment.projectProblems ?? {}).length && deployment.repository) {
    const value = `${deployment.repository} (GitHub)`
    choices.set('github', { zh: value, en: value })
  }
  for (const chat of chats) if (chat.projectSourceId && !choices.has(chat.projectSourceId)) {
    choices.set(chat.projectSourceId, { zh: `${chat.projectSourceId}（未知或未就绪）`, en: `${chat.projectSourceId} (unknown or not ready)` })
  }
  return [{ value: '', label: { zh: '选择关联仓库', en: 'Select repository' } }, ...[...choices]
    .sort(([a], [b]) => a.localeCompare(b)).map(([value, label]) => ({ value, label }))]
}
export const feishuKind: SourceKind<FeishuConfig> = {
  kind: SOURCE,
  refreshLabels: (host, signal) => refreshChatNames(sourceContext(host, feishuKind), signal),
  title: { zh: '飞书', en: 'Feishu' },
  description: { zh: '接收绑定飞书群及私聊中发给机器人的消息，并在关联对话收到新消息时自动跟踪。', en: 'Receives messages to the bot in bound Feishu chats and direct messages, and tracks updates in subscribed conversations.' },
  schema: FeishuConfigSchema,
  fields: [
    { key: 'cli', type: 'text', label: { zh: '机器人 lark-cli 路径', en: 'Bot lark-cli' },
      hint: { zh: '命令名或绝对路径，需指向仅使用机器人身份（strict mode bot）的 lark-cli 配置；执行器会通过 lark-cli 调用它。保存时会校验机器人并重启服务。', en: 'A command name or absolute path of a strict-mode bot lark-cli config; the runner calls it as lark-cli. Saving checks the bot and restarts the service.' } },
    { key: 'chats', type: 'rows', label: { zh: '监听的飞书群', en: 'Feishu chats' },
      hint: { zh: '每个群需绑定一个已就绪的代码仓库（每个仓库与群只能一对一绑定）。「仅 @」只接收 @ 机器人的消息和已有工单的后续回复；「全部消息」会接收群内所有消息供 AI 判断。',
        en: 'Bind each chat to one ready repository (one-to-one). "@ only" receives @ mentions and follow-ups on existing Tickets; "All" also passes unmentioned messages for AI assessment.' },
      columns: [
        { key: 'chatId', type: 'text', label: { zh: '群聊', en: 'Chat' }, pattern: 'oc_[a-zA-Z0-9]+', choose: { zh: '选择机器人已加入的群', en: 'Choose a chat the bot has joined' }, refresh: { zh: '刷新群列表', en: 'Refresh chats' } },
        { key: 'projectSourceId', type: 'select', label: { zh: '绑定仓库', en: 'Repository' }, options: [{ value: '', label: { zh: '选择关联仓库', en: 'Select repository' } }] },
        { key: 'listen', type: 'select', label: { zh: '接收范围', en: 'Receive' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
      ] },
    { key: 'otherChats', type: 'select', label: { zh: '其他群（旧版兼容）', en: 'Other chats (legacy)' }, options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }],
      hint: { zh: '多仓库模式下只接收上方已绑定的群；此旧版选项仅对未启用多仓库的旧配置生效。', en: 'Multi-repo setups only listen to bound chats above; this legacy option applies only to old single-repo deployments.' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收机器人私聊', en: 'Direct messages' },
      hint: { zh: '仅当只有一个可用代码仓库时，私聊机器人的消息才会进入该仓库的编排会话。', en: 'Direct messages reach an orchestrator session only when exactly one repository is configured and ready.' } },
    { key: 'readPageSize', type: 'number', advanced: true, min: 1, max: 50, label: { zh: '每次读取消息条数', en: 'Messages per page' }, hint: { zh: '读取对话上下文和群历史记录时，每次拉取的消息数。', en: 'Messages per page when agents read conversation context and chat history.' } },
    { key: 'linkTimeoutMs', type: 'number', advanced: true, min: 1, max: 90000, label: { zh: '获取消息链接超时 / 毫秒', en: 'Message link timeout / ms' },
      hint: { zh: '查询原消息链接的最大等待时间；超时后将直接读取消息正文。', en: 'How long to wait for an original message link before reading the message directly.' } },
  ],
  fieldsFor(deployment, config) {
    const options = projectChoices(deployment, config.chats)
    return this.fields.filter(field => field.key !== 'otherChats' || !deployment?.projects).map(field => field.key === 'chats' && field.type === 'rows'
      ? { ...field, columns: field.columns.map(column => column.key === 'projectSourceId' && column.type === 'select'
        ? { ...column, options } : column) } : field)
  },
  health: ['feishu', 'history'],
  scope({ meta }, config) {
    if (typeof meta.projectBindingError === 'string') return { listened: false, reason: meta.projectBindingError }
    if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const chat = config.chats.find(item => item.chatId === meta.chatId)
    if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
    return config.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_allowed' }
  },
  // A reply goes only to a chat the Source still receives.
  channel: {
    allowed: (address, config) =>
      feishuKind.scope!({ meta: { chatId: address.chatId ?? '', direct: address.direct === 'true' } }, config).listened,
    send: sendFeishu, link: feishuLink,
  },
  threadContext: feishuThreadContext,
  find: query => ({ threads: [], terms: [...new Set(query.match(/om_[A-Za-z0-9_-]+/g) ?? [])] }),
  // A message's Trigger is named after the message, so the one it answers is named after its parent.
  repliesTo: trigger => typeof trigger.meta.parentId === 'string' ? feishuTriggerId(trigger.meta.parentId) : undefined,
  policy: {
    unnamed: { person: { zh: '飞书用户', en: 'Feishu user' }, bot: { zh: '飞书机器人', en: 'Feishu bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^ou_[a-zA-Z0-9]+$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate open_ids').default([]),
      syncChat: z.string().regex(/^(oc_[a-zA-Z0-9]+)?$/).default(''),
      bots: z.array(z.object({ id: z.string().regex(/^(cli|ou)_[a-zA-Z0-9]+$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(bots => new Set(bots.map(bot => bot.id)).size === bots.length, 'Duplicate bot ids').optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '允许直接派活的飞书用户', en: 'Allowlisted Feishu users' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'open_id', en: 'open_id' }, pattern: 'ou_[a-zA-Z0-9]+' }, { key: 'name', type: 'text', label: { zh: '备注名', en: 'Name' }, optional: true }] },
      { key: 'syncChat', type: 'text', pattern: '(oc_[a-zA-Z0-9]+)?', label: { zh: '自动同步群成员', en: 'Sync members from chat' }, choose: { zh: '不同步', en: 'Do not sync' },
        hint: { zh: '开启同步后，上方白名单将自动与该群成员保持一致（启动时和点击同步时自动增删并更新姓名）。', en: 'Syncing keeps the allowlist identical to members of this chat at startup and on Sync.' } },
      { key: 'bots', type: 'rows', label: { zh: '允许触发 AI 判断的机器人', en: 'Bots whose messages AI may assess' },
        hint: { zh: '白名单中的机器人在监听群发消息时，会交给 AI 判断是否接单，但不能直接下指令或停止工单。', en: 'Messages from listed bots in listened chats are sent to AI assessment; they never directly start or stop a ticket.' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'App ID 或 open_id', en: 'App ID or open_id' }, pattern: '(cli|ou)_[a-zA-Z0-9]+' },
          { key: 'name', type: 'text', label: { zh: '备注名', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '白名单成员在群里 @ 机器人或私聊机器人时，始终直接接单，无需额外配置。', en: 'An allowlisted user mentioning or messaging the bot directly always starts a Ticket directly.' },
    rows(stored) {
      const config = FeishuConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      return [
        ...config.chats.map(chat => ({ id: chat.chatId, label: chat.name || chat.chatId, note: chat.listen === 'all' ? { zh: '全部消息', en: 'All' } : mentions,
          cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' } })),
        { id: 'other', label: { zh: '其他群', en: 'Other chats' }, note: config.otherChats === 'mentions' ? mentions : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
    sync: {
      label: { zh: '立即同步', en: 'Sync now' },
      ready: part => !!part.syncChat,
      async run(host, part, signal) {
        const commands = sourceContext(host, feishuKind).commands.withSignal(signal)
        const chat = String(part.syncChat)
        const members = ['im', '+chat-members-list', '--chat-id', chat, '--member-types', 'user', '--page-all', '--page-limit', '0']
        const result = MembersSchema.parse(await commands.lark(members))
        if (result.has_more || result.truncations?.length) throw new Error('Feishu returned an incomplete member list')
        // Preserve existing member order so policy version hashes stay stable; update names in place and append new members.
        const users = new Map(result.users.map(user => [user.member_id, user.name]))
        const known = new Set(part.allowed.map(entry => entry.id))
        return { ...part, allowed: [...part.allowed.filter(entry => users.has(entry.id)).map(entry => ({ ...entry, name: users.get(entry.id)! })), ...result.users.filter(user => !known.has(user.member_id)).map(user => ({ id: user.member_id, name: user.name }))] }
      },
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_FEISHU_BOT', description: { zh: '飞书机器人；lark-cli 以它行事', en: 'The Feishu bot; lark-cli acts as it' } },
      { key: 'DSH_SUPERAGENT_FEISHU_CHAT', description: { zh: '接下工单的飞书群 chat_id；工单不是从飞书来的时为空', en: 'chat_id of the Feishu chat that started the ticket; empty when the ticket did not start on Feishu' } },
    ],
    values: ({ deployment, trigger }) => ({ DSH_SUPERAGENT_FEISHU_BOT: deployment.feishu ? deployment.feishu.name || deployment.feishu.botId : '', DSH_SUPERAGENT_FEISHU_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '' }),
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.feishu ? { cli: { zh: `当前机器人 ${deployment.feishu.name || deployment.feishu.botId}`, en: `Current bot ${deployment.feishu.name || deployment.feishu.botId}` } } : {},
}
/** Returns the Feishu Source's settings, falling back to schema defaults while the Feishu plugin is disabled. */
export const feishuSettings = (sources: Pick<SourceRegistry, 'instance'>): FeishuConfig => sources.instance<FeishuConfig>(SOURCE)?.config ?? FeishuConfigSchema.parse({})

export const name = 'dsh-superagent-feishu'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(feishuKind), 'feishu: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runFeishu(sourceContext(ctx.orchestrator, feishuKind), controller.signal)
    return async () => { controller.abort(); await running }
  })
}
