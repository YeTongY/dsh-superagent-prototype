/** 自主 Reporter 的真实活动信号与连续无进展提醒。 */
export type ReporterProgressKind = 'model_stream' | 'model_call' | 'user_action' | 'target_state'
  | 'service_probe' | 'browser_observation' | 'browser_action'

/** 无进展窗口只产生提示，不中止模型推理或目标会话等待。 */
export class ReporterProgressMonitor {
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false
  private stalledValue = false

  constructor(readonly windowMs: number, private readonly onStalled?: () => void) {
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new RangeError('无进展窗口必须是正整数毫秒')
    this.arm()
  }

  get stalled(): boolean { return this.stalledValue }

  pulse(): void {
    if (this.disposed) return
    this.stalledValue = false
    this.arm()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private arm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      if (this.disposed || this.stalledValue) return
      this.stalledValue = true
      try { this.onStalled?.() } catch { /* A progress warning must not interrupt the run. */ }
    }, this.windowMs)
  }
}
