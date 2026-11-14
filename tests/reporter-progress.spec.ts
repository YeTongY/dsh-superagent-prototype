import { afterEach, expect, it, vi } from 'vitest'
import { ReporterProgressMonitor } from '../src/reporter/progress.ts'

afterEach(() => vi.useRealTimers())

it('报告连续无进展但不自动中止，并在真实活动恢复后重新计时', async () => {
  vi.useFakeTimers()
  const onStalled = vi.fn(), monitor = new ReporterProgressMonitor(100, onStalled)

  await vi.advanceTimersByTimeAsync(100)
  expect(monitor.stalled).toBe(true)
  expect(onStalled).toHaveBeenCalledOnce()

  monitor.pulse()
  expect(monitor.stalled).toBe(false)
  await vi.advanceTimersByTimeAsync(100)
  expect(monitor.stalled).toBe(true)
  expect(onStalled).toHaveBeenCalledTimes(2)

  monitor.dispose()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(onStalled).toHaveBeenCalledTimes(2)
})
