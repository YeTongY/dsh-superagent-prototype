/** 自主 Reporter 的真实活动信号与连续无进展 watchdog。 */
export type ReporterProgressKind = 'model_stream' | 'model_call' | 'user_action' | 'target_state'
  | 'service_probe' | 'browser_observation' | 'browser_action'

/** Reporter 在配置的连续无进展窗口内没有观察到有效活动时抛出的终止原因。 */
export class ReporterProgressStalledError extends Error {
  readonly code = 'progress_stalled'
  constructor() {
    super('Reporter 在允许的无进展窗口内没有观察到真实活动')
    this.name = 'ReporterProgressStalledError'
  }
}

/** 只在调用方观察到真实工作时 pulse；定时轮询和 busy 状态不得调用。 */
export class ReporterProgressWatchdog {
  private readonly controller = new AbortController()
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false
  private stalledValue = false

  constructor(readonly windowMs: number) {
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new RangeError('无进展窗口必须是正整数毫秒')
    this.arm()
  }

  get signal(): AbortSignal { return this.controller.signal }
  get stalled(): boolean { return this.stalledValue }

  pulse(): void {
    if (this.disposed || this.signal.aborted) return
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
      if (this.disposed || this.signal.aborted) return
      this.stalledValue = true
      this.controller.abort(new ReporterProgressStalledError())
    }, this.windowMs)
  }
}
