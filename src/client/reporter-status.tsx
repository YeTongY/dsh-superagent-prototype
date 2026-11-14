/** 以可扫读的运行卡片展示 Reporter 状态，并将完整运行材料放在原生折叠区。 */
import type { ReactNode } from 'react'
import type { ReporterAutonomousRunView } from '../reporter/autonomous.ts'
import type { DshSuperagentKey } from './locales.ts'
import { usePoll } from './api.ts'
import { usePanel } from './provider.tsx'
import { Hint, LoadState, Section, When } from './widgets.tsx'

type Finding = NonNullable<ReporterAutonomousRunView['findings']>[number]
type Experiment = ReporterAutonomousRunView['experiment_log'][number]

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
    run_timeout: 'reporter.reason.timeout',
    runtime_restarted: 'reporter.reason.restarted',
  }
  return keys[code] ?? 'reporter.reason.failed'
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

function ExperimentRow({ experiment, index }: { experiment: Experiment; index: number }) {
  const { t } = usePanel()
  return <li className="dt-reporter-experiment">
    <div className="dt-reporter-experiment-head">
      <span className="dt-reporter-kind">{t(`reporter.mode.${experiment.kind}`)}</span>
      {experiment.scenario_id && <span className="dt-mono">{experiment.scenario_id}</span>}
      <span className="dt-reporter-index">{t('reporter.experimentNumber', { number: index + 1 })}</span>
    </div>
    <p><strong>{t('reporter.hypothesis')}：</strong>{experiment.hypothesis}</p>
    <p><strong>{t('reporter.observation')}：</strong>{experiment.observation}</p>
    {experiment.evidence.length > 0 && <div>
      <strong>{t('reporter.evidence')}</strong>
      <ul>{experiment.evidence.map((item, evidenceIndex) => <li key={evidenceIndex}>{item}</li>)}</ul>
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
      <div className="dt-reporter-meta">
        <span title={run.project_source_id}>{t('reporter.projectLabel')} <b>{run.project_source_id}</b></span>
        <span title={`${run.model.provider}/${run.model.model}`}>{t('reporter.modelLabel')} <b>{run.model.provider}/{run.model.model}</b></span>
        <span>{t('reporter.reasoning', { effort: run.model.reasoningEffort })}</span>
      </div>
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
