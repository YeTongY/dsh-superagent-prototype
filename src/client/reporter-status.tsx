/** 展示 Reporter 运行进度；完整测试报告由 DSH 主会话原生呈现。 */
import type { ReactNode } from 'react'
import type { ReporterAutonomousRunView } from '../reporter/autonomous.ts'
import type { DshSuperagentKey } from './locales.ts'
import { usePoll } from './api.ts'
import { usePanel } from './provider.tsx'
import { Hint, LoadState, Section, SessionButton, When } from './widgets.tsx'

type Finding = NonNullable<ReporterAutonomousRunView['findings']>[number]
type Experiment = ReporterAutonomousRunView['experiment_log'][number]
type BrowserStep = NonNullable<Experiment['browser_steps']>[number]
type ProgressKind = NonNullable<ReporterAutonomousRunView['progress']>['kind']

const MAX_LEGACY_DIAGNOSTIC_CHARS = 8_000

interface RunDiagnostic {
  status: string
  stop: string
  actions: number
  snapshot: boolean
  outputs: number
  raw: string
}

function diagnosticFrom(summary: string | undefined): RunDiagnostic | undefined {
  if (!summary) return undefined
  const match = /status=([a-z_]+);\s*stop=([a-z_]+);\s*actions=(\d+);\s*snapshot=(true|false);\s*outputs=(\d+)/.exec(summary)
  if (!match) return undefined
  return { status: match[1]!, stop: match[2]!, actions: Number(match[3]), snapshot: match[4] === 'true',
    outputs: Number(match[5]), raw: match[0] }
}

function narrativeFrom(summary: string | undefined, diagnostic: RunDiagnostic | undefined): string | undefined {
  if (!summary) return undefined
  const narrative = diagnostic ? summary.replace(diagnostic.raw, '').replace(/[;，,]\s*$/, '').trim() : summary.trim()
  return narrative || undefined
}

function isLegacyBrowserJson(value: string): boolean {
  return /"(?:accessibility_snapshot|snapshot_truncated|page_errors|blocked_requests)"\s*:/.test(value)
}

function cappedText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n…` : value
}

function readableErrorKey(code: string): DshSuperagentKey {
  const keys: Record<string, DshSuperagentKey> = {
    invalid_simulator_output: 'reporter.reason.invalidOutput',
    invalid_output: 'reporter.reason.invalidOutput',
    invalid_browser_action: 'reporter.reason.invalidOutput',
    browser_no_action: 'reporter.reason.browserNoAction',
    browser_action_budget: 'reporter.reason.browserBudget',
    browser_unavailable: 'reporter.reason.browserUnavailable',
    usage_unknown: 'reporter.reason.usageUnknown',
    token_budget: 'reporter.reason.tokenBudget',
    token_budget_exceeded: 'reporter.reason.tokenBudget',
    model_call_budget: 'reporter.reason.modelBudget',
    progress_stalled: 'reporter.reason.progressStalled',
    run_timeout: 'reporter.reason.timeout',
    runtime_restarted: 'reporter.reason.restarted',
  }
  return keys[code] ?? 'reporter.reason.failed'
}

const progressKindKeys: Record<ProgressKind, DshSuperagentKey> = {
  model_stream: 'reporter.progressKind.modelStream',
  model_call: 'reporter.progressKind.modelCall',
  user_action: 'reporter.progressKind.userAction',
  target_state: 'reporter.progressKind.targetState',
  service_probe: 'reporter.progressKind.serviceProbe',
  browser_observation: 'reporter.progressKind.browserObservation',
  browser_action: 'reporter.progressKind.browserAction',
}

function failureReason(run: ReporterAutonomousRunView, diagnostic: RunDiagnostic | undefined, t: ReturnType<typeof usePanel>['t']) {
  if (run.error_code) return t(readableErrorKey(run.error_code))
  if (!diagnostic) return run.status === 'failed' ? t('reporter.reason.failed') : undefined
  if (diagnostic.stop === 'invalid_output') return t('reporter.reason.invalidOutput')
  if (diagnostic.stop === 'usage_unknown') return t('reporter.reason.usageUnknown')
  if (diagnostic.stop === 'budget_exhausted' || diagnostic.stop === 'max_calls') return t('reporter.reason.budgetReached')
  if (diagnostic.stop === 'timeout') return t('reporter.reason.timeout')
  if (diagnostic.status === 'completed' || diagnostic.stop === 'simulator_finished') {
    return t('reporter.reason.simulationFinished', { actions: diagnostic.actions, outputs: diagnostic.outputs })
  }
  if (run.status === 'failed') return t('reporter.reason.failed')
  if (run.status === 'incomplete') return t('reporter.reason.incomplete')
  if (run.status === 'cancelled') return t('reporter.reason.cancelled')
  return undefined
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return <span className="dt-reporter-metric"><span>{label}</span><strong>{value}</strong></span>
}

function browserActionLabel(action: BrowserStep['action'], t: ReturnType<typeof usePanel>['t']): string {
  if (action === 'initial-observation') return t('reporter.browserAction.initial')
  if (action.kind === 'snapshot') return t('reporter.browserAction.snapshot')
  if (action.kind === 'click') return t(action.role === 'tab' ? 'reporter.browserAction.clickTab' : 'reporter.browserAction.clickButton', { name: action.name })
  if (action.kind === 'fill') return t('reporter.browserAction.fill', { name: action.name })
  if (action.kind === 'press') return t('reporter.browserAction.press', { name: action.name, key: action.key })
  return t('reporter.browserAction.back')
}

function BrowserStepList({ steps }: { steps: BrowserStep[] }) {
  const { t } = usePanel()
  return <div className="dt-reporter-browser-steps">
    <strong>{t('reporter.browserSteps')} <span>{steps.length}</span></strong>
    <ol>
      {steps.map(step => <li key={step.index} className="dt-reporter-browser-step" data-result={step.result}>
        <div className="dt-reporter-browser-step-head">
          <strong>{t('reporter.browserStepNumber', { number: step.index })}：{browserActionLabel(step.action, t)}</strong>
          <span className="dt-reporter-browser-result" data-result={step.result}>{t(`reporter.browserResult.${step.result}`)}</span>
        </div>
        <p>{t('reporter.browserPage', { title: step.page.title || t('reporter.unknown'), path: step.page.path })}</p>
        <p className="dt-reporter-browser-errors">{t('reporter.browserErrorCounts', {
          page: step.page.page_errors,
          console: step.page.console_errors,
          blocked: step.page.blocked_requests.length,
          blockedConsole: step.page.blocked_console_errors,
        })}</p>
        {step.error_code && <p className="dt-reporter-browser-error"><code>{step.error_code}</code></p>}
      </li>)}
    </ol>
  </div>
}

function LegacyBrowserDiagnostic({ value, label }: { value: string; label: string }) {
  const { t } = usePanel()
  return <details className="dt-reporter-nested-details dt-reporter-legacy-diagnostic">
    <summary>{label}</summary>
    <pre>{cappedText(value, MAX_LEGACY_DIAGNOSTIC_CHARS)}</pre>
    {value.length > MAX_LEGACY_DIAGNOSTIC_CHARS && <span>{t('reporter.legacyDiagnosticTruncated')}</span>}
  </details>
}

function ReportDelivery({ delivery }: { delivery: NonNullable<ReporterAutonomousRunView['report_delivery']> }) {
  const { t } = usePanel()
  const hasSession = delivery.status === 'delivered' && !!delivery.master_session_id
  return <div className="dt-reporter-delivery" data-state={delivery.status}>
    <span>{t('reporter.deliveryLabel')} <strong>{t(`reporter.delivery.${delivery.status}`)}</strong></span>
    {delivery.status === 'failed' && <span>{t('reporter.delivery.failedReason')}</span>}
    {hasSession && <SessionButton sessionId={delivery.master_session_id!} label={t('reporter.openMasterSession')} variant="outline" />}
  </div>
}

function ExperimentRow({ experiment, index }: { experiment: Experiment; index: number }) {
  const { t } = usePanel()
  const hasStructuredBrowserSteps = experiment.kind === 'browser' && !!experiment.browser_steps?.length
  const legacyObservation = experiment.kind === 'browser' && !hasStructuredBrowserSteps && isLegacyBrowserJson(experiment.observation)
  const showEvidence = experiment.evidence.length > 0 && !hasStructuredBrowserSteps
  return <li className="dt-reporter-experiment">
    <div className="dt-reporter-experiment-head">
      <span className="dt-reporter-kind">{t(`reporter.mode.${experiment.kind}`)}</span>
      {experiment.scenario_id && <span className="dt-mono">{experiment.scenario_id}</span>}
      <span className="dt-reporter-index">{t('reporter.experimentNumber', { number: index + 1 })}</span>
    </div>
    <p><strong>{t('reporter.hypothesis')}：</strong>{experiment.hypothesis}</p>
    <p className={legacyObservation ? 'dt-reporter-observation-summary' : undefined}>
      <strong>{t('reporter.observation')}：</strong>{legacyObservation ? t('reporter.legacyBrowserObservation') : experiment.observation}</p>
    {legacyObservation && <LegacyBrowserDiagnostic value={experiment.observation} label={t('reporter.legacyBrowserRaw')} />}
    {hasStructuredBrowserSteps && <BrowserStepList steps={experiment.browser_steps!} />}
    {showEvidence && <div>
      <strong>{t('reporter.evidence')}</strong>
      <ul>{experiment.evidence.map((item, evidenceIndex) => <li key={evidenceIndex}>
        {experiment.kind === 'browser' && isLegacyBrowserJson(item)
          ? <LegacyBrowserDiagnostic value={item} label={t('reporter.legacyBrowserEvidence', { number: evidenceIndex + 1 })} /> : item}
      </li>)}</ul>
    </div>}
  </li>
}

function ReporterFinding({ finding }: { finding: Finding }) {
  const { t } = usePanel()
  return <li className="dt-reporter-finding" data-severity={finding.severity}>
    <div className="dt-reporter-finding-title">
      <strong>{finding.title}</strong>
      <span className="dt-reporter-kind">{t(`reporter.finding.${finding.status}`)}</span>
      <span className="dt-reporter-kind">{t(`reporter.severity.${finding.severity}`)}</span>
    </div>
    {(finding.evidence.length > 0 || finding.reproduction.length > 0) && <details className="dt-reporter-nested-details">
      <summary>{t('reporter.findingDetails')}</summary>
      {finding.evidence.length > 0 && <div>
        <strong>{t('reporter.evidence')}</strong>
        <ul>{finding.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul>
      </div>}
      {finding.reproduction.length > 0 && <div>
        <strong>{t('reporter.reproduction')}</strong>
        <ol>{finding.reproduction.map((item, index) => <li key={index}>{item}</li>)}</ol>
      </div>}
    </details>}
  </li>
}

function RunDetails({ run, diagnostic, narrative }: { run: ReporterAutonomousRunView; diagnostic?: RunDiagnostic; narrative?: string }) {
  const { t } = usePanel()
  return <details className="dt-reporter-details">
    <summary>{t('reporter.runDetails')}</summary>
    <div className="dt-reporter-detail-body">
      <div className="dt-reporter-detail-group">
        <h4>{t('reporter.runInfo')}</h4>
        <dl className="dt-reporter-info">
          <div><dt>{t('reporter.goal')}</dt><dd>{run.goal}</dd></div>
          <div><dt>{t('reporter.projectLabel')}</dt><dd className="dt-mono">{run.project_source_id}</dd></div>
          <div><dt>{t('reporter.modelLabel')}</dt><dd>{run.model.provider}/{run.model.model} · {t('reporter.reasoning', { effort: run.model.reasoningEffort })}</dd></div>
          <div><dt>{t('reporter.started')}</dt><dd><When at={run.started_at} /></dd></div>
          <div><dt>{t('reporter.updated')}</dt><dd><When at={run.updated_at} /></dd></div>
          <div><dt>{t('reporter.runId')}</dt><dd className="dt-mono">{run.id}</dd></div>
        </dl>
      </div>
      {narrative && <div className="dt-reporter-detail-group">
        <h4>{t('reporter.summary')}</h4>
        <p>{narrative}</p>
      </div>}
      {(run.error_code || diagnostic) && <div className="dt-reporter-detail-group dt-reporter-technical">
        <h4>{t('reporter.technicalDetails')}</h4>
        <dl className="dt-reporter-info">
          <div><dt>{t('reporter.errorCode')}</dt><dd className="dt-mono">{run.error_code}</dd></div>
          {diagnostic && <div><dt>{t('reporter.rawDiagnostic')}</dt><dd className="dt-mono">{diagnostic.raw}</dd></div>}
        </dl>
      </div>}
      {run.report_delivery && <div className="dt-reporter-detail-group dt-reporter-technical">
        <h4>{t('reporter.deliveryDetails')}</h4>
        <dl className="dt-reporter-info">
          <div><dt>{t('reporter.deliveryLabel')}</dt><dd>{t(`reporter.delivery.${run.report_delivery.status}`)}</dd></div>
          {run.report_delivery.error_code && <div><dt>{t('reporter.errorCode')}</dt><dd className="dt-mono">{run.report_delivery.error_code}</dd></div>}
          {run.report_delivery.master_session_id && <div><dt>{t('reporter.deliverySessionId')}</dt><dd className="dt-mono">{run.report_delivery.master_session_id}</dd></div>}
        </dl>
      </div>}
      {run.scenario_ids.length > 0 && <div className="dt-reporter-detail-group">
        <h4>{t('reporter.scenarios')} <span>{run.scenario_ids.length}</span></h4>
        <ul className="dt-reporter-id-list">{run.scenario_ids.map(id => <li key={id} className="dt-mono">{id}</li>)}</ul>
      </div>}
      {run.experiment_log.length > 0 && <div className="dt-reporter-detail-group">
        <h4>{t('reporter.experimentLog')} <span>{run.experiment_log.length}</span></h4>
        <ol className="dt-reporter-experiments">{run.experiment_log.map((experiment, index) => <ExperimentRow key={`${experiment.kind}:${index}`}
          experiment={experiment} index={index} />)}</ol>
      </div>}
      {!!run.findings?.length && <div className="dt-reporter-detail-group">
        <h4>{t('reporter.findings')} <span>{run.findings.length}</span></h4>
        <ul className="dt-reporter-findings">{run.findings.map((finding, index) => <ReporterFinding key={`${finding.status}:${index}`}
          finding={finding} />)}</ul>
      </div>}
      <div className="dt-reporter-detail-group">
        <h4>{t('reporter.usage')}</h4>
        <div className="dt-reporter-usage">
          <Metric label={t('reporter.promptTokensLabel')} value={run.model_usage.prompt_tokens ?? t('reporter.unknown')} />
          <Metric label={t('reporter.completionTokensLabel')} value={run.model_usage.completion_tokens ?? t('reporter.unknown')} />
          <Metric label={t('reporter.costLabel')} value={run.model_usage.cost_usd === null ? t('reporter.unknown') : `$${run.model_usage.cost_usd}`} />
          <Metric label={t('reporter.retriesLabel')} value={run.model_usage.retries ?? t('reporter.unknown')} />
          <Metric label={t('reporter.usageStatus')} value={t(`reporter.usage.${run.model_usage.completeness}`)} />
          <Metric label={t('reporter.latencyLabel')} value={run.model_usage.latency_ms === null ? t('reporter.unknown') : `${run.model_usage.latency_ms} ms`} />
        </div>
      </div>
    </div>
  </details>
}

function ReporterRun({ run }: { run: ReporterAutonomousRunView }) {
  const { t } = usePanel()
  const diagnostic = diagnosticFrom(run.summary)
  const narrative = narrativeFrom(run.summary, diagnostic)
  const reason = failureReason(run, diagnostic, t)
  const primaryFinding = run.findings?.find(item => item.severity === 'error')
    ?? run.findings?.find(item => item.severity === 'warning') ?? run.findings?.[0]
  return <li className="dt-reporter-run" data-state={run.status === 'failed' ? 'error'
    : run.status === 'incomplete' || run.status === 'cancelled' ? 'warning' : run.status === 'running' ? 'ongoing' : 'success'}>
    <article className="dt-reporter-card">
      <div className="dt-reporter-head">
        <div className="dt-reporter-title-line">
          <strong className="dt-reporter-mode">{t(`reporter.mode.${run.mode}`)}</strong>
          <span className="dt-reporter-status" data-status={run.status}>{t(`reporter.status.${run.status}`)}</span>
          <span className="dt-reporter-phase">{t('reporter.phase', { phase: run.phase })}</span>
        </div>
        <span className="dt-reporter-updated"><span>{t('reporter.updatedShort')}</span><When at={run.updated_at} /></span>
      </div>
      <p className="dt-reporter-goal" title={run.goal}>{run.goal}</p>
      {reason && <p className="dt-reporter-reason" data-state={run.status === 'failed' ? 'error' : 'warning'}>
        <strong>{t(run.status === 'completed' ? 'reporter.conclusion' : 'reporter.incompleteReason')}：</strong>{reason}
      </p>}
      {narrative && <p className="dt-reporter-summary-preview" title={narrative}>{narrative}</p>}
      <div className="dt-reporter-metrics" role="group" aria-label={t('reporter.progressMetrics')}>
        <Metric label={t('reporter.experimentsShort')} value={run.experiments} />
        <Metric label={t(run.mode === 'browser' ? 'reporter.browserActionsShort' : 'reporter.actionsShort')} value={run.turns} />
        <Metric label={t('reporter.modelCallsShort')} value={run.model_calls} />
      </div>
      {run.progress && <div className="dt-reporter-last-progress">
        <span>{t('reporter.lastRealProgress')}</span>
        <strong>{t(progressKindKeys[run.progress.kind])}</strong>
        <When at={run.progress.at} />
      </div>}
      <div className="dt-reporter-meta">
        <span title={run.project_source_id}>{t('reporter.projectLabel')} <b>{run.project_source_id}</b></span>
        <span title={`${run.model.provider}/${run.model.model}`}>{t('reporter.modelLabel')} <b>{run.model.provider}/{run.model.model}</b></span>
        <span>{t('reporter.reasoning', { effort: run.model.reasoningEffort })}</span>
      </div>
      {run.report_delivery && <ReportDelivery delivery={run.report_delivery} />}
      {primaryFinding && <div className="dt-reporter-primary-finding" data-severity={primaryFinding.severity}>
        <strong>{t('reporter.findingLabel')}：</strong>{primaryFinding.title}
        <span>{t(`reporter.finding.${primaryFinding.status}`)}</span>
      </div>}
      {run.experiment_log[0] && <p className="dt-reporter-direction" title={run.experiment_log[0].hypothesis}>
        <span>{t('reporter.currentHypothesis')}：</span>{run.experiment_log[0].hypothesis}
      </p>}
      <RunDetails run={run} diagnostic={diagnostic} narrative={narrative} />
    </article>
  </li>
}

export function ReporterStatus() {
  const { t, call } = usePanel()
  const { data, error } = usePoll(() => call('GET reporter'), [])
  return <Section title={t('reporter.title')} count={data?.runs.length ?? 0}>
    {!data ? <LoadState error={error} loading /> : <>
      {error && <LoadState error={error} loading={false} />}
      {!data.enabled ? <Hint>{t('reporter.disabled')}</Hint>
        : data.runs.length === 0 ? <Hint>{t('reporter.enabledIdle')}</Hint>
          : <ul className="dt-list dt-reporter-runs">{data.runs.map(run => <ReporterRun key={run.id} run={run} />)}</ul>}
    </>}
  </Section>
}
