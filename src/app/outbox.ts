/** Reliable outbound message delivery backed by persistent receipts and retried reply effects. */
import type { OutboundMessage, Outbox as OutboxPort, ReplyStatus } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import { feishuProjectForChat, feishuSettings, feishuTriggerId } from '../sources/feishu.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { FAILURES_BEFORE_ERROR, Later, type Effects } from './effects.ts'
import { ticketProjectId, triggerProjectId } from './project-scope.ts'
import type { Receipt, Store } from './store.ts'

export interface OutboxHost {
  readonly store: Pick<Store, 'atomic' | 'receipts' | 'triggers' | 'threads' | 'tickets' | 'read'>
  readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle'>
  readonly sources: Pick<SourceRegistry, 'instance' | 'channelAllowed' | 'send'>
  readonly commands: Commands
  /** 测试通道捕获；返回 true 后只记录本地交付，不调用外部 Provider。 */
  capture?(message: OutboundMessage): boolean
  paused(): boolean
}

/**
 * Persists outbound channel messages as receipts and delivers them sequentially through `Effects` and `SourceRegistry`.
 * Implements the core `Outbox` port for `Engine` and source contexts, ensuring per-conversation ordering for each ticket until an earlier message fails repeatedly.
 * Messages wait while processing is paused or their source is unavailable, and settle as dropped when the target conversation is ignored or gone.
 */
export class Outbox implements OutboxPort {
  constructor(private readonly host: OutboxHost) {
    host.effects.handle('reply', (_payload, id) => this.deliver(id), { limit: () => host.paused() ? 0 : 1, retry: [5000, 300_000] })
  }
  /** Record a message receipt and enqueue its delivery effect atomically; duplicate message IDs are ignored. */
  send(message: OutboundMessage): void {
    // Validate IM reply length here; acknowledgements are already validated when decided.
    if (message.kind === 'reply' && message.channel.source === 'feishu') checkedImText(message.text)
    const { store, effects } = this.host
    store.atomic(() => { if (store.receipts.add(message)) effects.enqueue('reply', message.id, {}) })
  }
  status(id: string): ReplyStatus | undefined { return this.host.store.receipts.get(id)?.status }
  withdraw(id: string): void {
    const { store, effects } = this.host
    store.atomic(() => { if (store.receipts.withdraw(id)) effects.cancel('reply', id) })
  }
  sent(): Promise<void> { return this.host.effects.idle('reply') }
  /** 当前群仍归原项目时，才能发送先前排队的回复。 */
  private feishuChannelAllowed(receipt: Receipt): boolean {
    const { store, sources, commands } = this.host
    const deployment = commands.deployment
    if (!deployment.projects) return true
    const { chatId, messageId, direct } = receipt.channel.address
    const binding = feishuProjectForChat(deployment, feishuSettings(sources).chats, chatId ?? '', direct === 'true')
    if (binding.error === 'project_not_ready') throw new Later('The Feishu channel project has not completed setup')
    if (binding.error || !binding.projectSourceId) return false
    const trigger = messageId ? store.triggers.get(feishuTriggerId(messageId)) : undefined
    if (typeof trigger?.meta.projectBindingError === 'string') return false
    const triggerOwner = triggerProjectId(deployment, trigger, store)
    const ticketOwner = receipt.ticketId ? ticketProjectId({ deployment, store }, store.tickets.get(receipt.ticketId)) : undefined
    const owner = triggerOwner ?? ticketOwner
    return (!triggerOwner || !ticketOwner || triggerOwner === ticketOwner)
      && (owner ? owner === binding.projectSourceId : binding.legacy === true)
  }
  private async deliver(id: string): Promise<void> {
    const { store, sources, commands } = this.host
    const receipt = store.receipts.get(id)
    if (receipt?.status !== 'pending') return
    if (receipt.channel.source === 'local-reporter') {
      if (!this.host.capture?.(receipt)) { store.receipts.settle(receipt, 'channelGone'); return }
      store.receipts.settle(receipt, 'sent'); return
    }
    if (!sources.instance(receipt.channel.source)?.enabled) throw new Later('The Source is off or not installed')
    // Hold later messages for the same ticket and conversation behind an earlier pending message until it exceeds the failure threshold.
    if (store.receipts.behind(id, FAILURES_BEFORE_ERROR)) throw new Later('An earlier message of this ticket to this conversation waits')
    if (!sources.channelAllowed(receipt.channel)) { store.receipts.settle(receipt, 'channelIgnored'); return }
    if (receipt.channel.source === 'feishu' && !this.feishuChannelAllowed(receipt)) {
      store.receipts.settle(receipt, 'projectBindingChanged'); return
    }
    // A permanently unreachable target (such as a recalled message or deleted Issue) settles as `channelGone` so its receipt prevents retries.
    const result = await sources.send(receipt, commands)
    if (result === 'waiting') throw new Later('The Source is not installed')
    store.receipts.settle(receipt, result === 'gone' ? 'channelGone' : 'sent')
  }
}
