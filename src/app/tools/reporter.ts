/** Reporter DSH Session 的只读观察、仿真和报告工具。 */
import { z } from 'zod'
import type { LocalReporter } from '../../reporter/local-reporter.ts'
import { ReporterBrowserActionSchema } from '../../reporter/browser.ts'
import type { ReporterAutonomousRuns, ReporterSessionContext } from '../../reporter/autonomous.ts'
import { ReporterActionSchema } from '../../reporter/protocol.ts'
import { tool, type Tool } from './tool.ts'

const ProbeSchema = z.enum(['state', 'overview', 'sources', 'tickets', 'threads', 'decisions'])
export type ReporterReadOnlyProbe = z.infer<typeof ProbeSchema>

export interface ReporterToolsHost {
  readonly reporter: Pick<LocalReporter, 'simulatorFeedback' | 'submit'>
  readonly runs: Pick<ReporterAutonomousRuns, 'candidate' | 'submitReport' | 'browserDriver'>
  waitForTarget(scenarioId: string, signal: AbortSignal): Promise<void>
  probeReadOnly(probe: z.infer<typeof ProbeSchema>, signal: AbortSignal): Promise<{ probe_id: string; status: number; body: string; json: boolean }>
}

export function reporterTools(host: ReporterToolsHost, sessionId: string, context: ReporterSessionContext): Tool[] {
  const { request, view, scenario_id: scenarioId } = context
  const tools: Tool[] = []

  if (request.permissions.simulation && scenarioId) {
    tools.push(tool({
      name: 'reporter_simulator_feedback',
      description: '按需读取当前运行的仿真场景向你公开的信息、允许的用户身份、已有对话和下一序号。不含隐藏预期结果；场景由当前 Session 固定，不能选择其他场景。',
      schema: z.object({}).strict(),
      execute: async () => {
        const feedback = host.reporter.simulatorFeedback(scenarioId)
        if (!feedback) throw new Error('Reporter scenario is unavailable')
        return { visible: feedback.scenario.visible, actors: feedback.scenario.actors, last_sequence: feedback.last_sequence,
          next_sequence: feedback.last_sequence + 1, conversation: feedback.conversation }
      },
    }))
    tools.push(tool({
      name: 'reporter_simulate_user_action',
      description: '作为目标 ProjectSource 中的一个已授权用户执行一条真实本地仿真动作。每次调用先读取上一条反馈中的 next_sequence；动作经 Runtime/Engine，随后等待 Superagent 的真实处理结果。',
      schema: z.object({
        actor_id: z.string().min(1).max(160),
        sequence: z.number().int().positive(),
        action: ReporterActionSchema,
      }).strict(),
      execute: async (args, signal) => {
        const feedback = host.reporter.simulatorFeedback(scenarioId)
        if (!feedback) throw new Error('Reporter scenario is unavailable')
        if (!feedback.scenario.actors.some(actor => actor.id === args.actor_id)) throw new Error('Reporter actor is not authorized for this ProjectSource')
        const expected = feedback.last_sequence + 1
        if (args.sequence !== expected) throw new Error(`Expected the next Reporter sequence to be ${expected}`)
        const ack = host.reporter.submit({ scenario_id: scenarioId, scenario_version: feedback.scenario.version, sequence: args.sequence,
          idempotency_key: `${view.id}:${args.sequence}`, simulated_at: new Date().toISOString(), actor_id: args.actor_id,
          project_source_id: request.project_source_id, thread_id: feedback.scenario.thread_id, action: args.action })
        await host.waitForTarget(scenarioId, signal)
        const next = host.reporter.simulatorFeedback(scenarioId)
        return { accepted: ack.disposition, duplicate: ack.duplicate, next_sequence: (next?.last_sequence ?? args.sequence) + 1,
          conversation: next?.conversation ?? [] }
      },
    }))
  }

  if (request.permissions.read_only_service) {
    tools.push(tool({
      name: 'reporter_probe_read_only_service',
      description: '读取当前 Superagent 实例的一个固定只读管理接口。不能访问自定义 URL、发送请求体或改变服务状态。',
      schema: z.object({ probe_id: ProbeSchema }).strict(),
      execute: async (args, signal) => host.probeReadOnly(args.probe_id, signal),
    }))
  }

  if (request.permissions.browser) {
    tools.push(tool({
      name: 'reporter_browser_observe',
      description: '打开受保护的本地 Superagent 管理页，返回控件观察和当前视口截图图像附件。只有当前 DSH 模型路由明确支持图像且附件已保存时才会附图；否则查看结果中的 screenshot 状态，并且不要声称看过截图。',
      schema: z.object({}).strict(),
      execute: async (_args, signal) => (await host.runs.browserDriver(sessionId, signal)).observe(signal),
    }))
    tools.push(tool({
      name: 'reporter_browser_act',
      description: '在本地 Superagent 面板执行一个受限的真实 GUI 动作，然后返回新视口截图附件和控件观察。可用截图坐标、滚动、调整视口、精确控件操作或恢复 Superagent 面板；坐标必须来自刚收到的截图并位于可见产品内容区。不能导航到任意 URL、运行脚本、提交设置或触发写操作。',
      schema: z.object({ action: ReporterBrowserActionSchema }).strict(),
      execute: async (args, signal) => (await host.runs.browserDriver(sessionId, signal)).act(args.action, signal),
    }))
  }

  tools.push(tool({
    name: 'reporter_candidate',
    description: '把一个需要编排者判断的候选问题、证据或疑问即时发送给 Orchestrator。Orchestrator 可在这个 Reporter Session 中回复；候选本身不授权派工。',
    schema: z.object({ text: z.string().trim().min(1).max(8_000) }).strict(),
    execute: async args => { host.runs.candidate(sessionId, args.text); return { forwarded: true, run_id: view.id } },
  }))
  tools.push(tool({
    name: 'reporter_submit_report',
    description: '提交一段简短摘要和自由文本完整报告到 Superagent 页面，并将报告本地转交给 Orchestrator。报告不需要 JSON，也没有固定模板。',
    schema: z.object({ summary: z.string().trim().min(1).max(4_000), full_report: z.string().trim().min(1).max(50_000) }).strict(),
    execute: async args => {
      await host.runs.submitReport(sessionId, args.summary, args.full_report)
      return { recorded: true, run_id: view.id }
    },
  }))

  return tools
}
