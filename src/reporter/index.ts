/** 固定场景回归协议与自主 DSH Session Reporter 的管理投影。 */
export * from './protocol.ts'
export * from './local-reporter.ts'
export { ReporterScriptStepSchema, reporterAction, runReporterScript } from './script.ts'
export type { ReporterScriptResult, ReporterScriptStep } from './script.ts'
export { ReporterAutonomousRunError, ReporterAutonomousRunRequestSchema, ReporterAutonomousRuns } from './autonomous.ts'
export type { ReporterAutonomousHost, ReporterAutonomousManagementView, ReporterAutonomousRunRequest, ReporterAutonomousRunStatus,
  ReporterAutonomousRunView, ReporterSessionContext } from './autonomous.ts'
