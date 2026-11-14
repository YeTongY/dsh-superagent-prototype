/** 只读展示有界自主报告者运行状态和发现。 */
import type { ReporterAutonomousRunView } from '../reporter/autonomous.ts'
import { usePoll } from './api.ts'
import { usePanel } from './provider.tsx'
import { Hint, LoadState, Section, When } from './widgets.tsx'

function ReporterFinding({ finding }: { finding: NonNullable<ReporterAutonomousRunView['findings']>[number] }) {
  const { t } = usePanel()
  return <li className="dt-row dt-reporter-finding">
    <div className="dt-row-main">
      <strong>{finding.title}</strong>
      <div className="dt-row-meta">
        <span>{t(`reporter.finding.${finding.status}`)}</span>
        <span>{t(`reporter.severity.${finding.severity}`)}</span>
      </div>
      {(finding.evidence.length > 0 || finding.reproduction.length > 0) && <details className="dt-reporter-finding-details">
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
    </div>
  </li>
}

function ReporterRun({ run }: { run: ReporterAutonomousRunView }) {
  const { t } = usePanel()
  return <li className={`dt-row dt-reporter-run dt-reporter-${run.status}`}>
    <div className="dt-row-main">
      <strong className="dt-reporter-goal">{run.goal}</strong>
      <div className="dt-row-meta">
        <span>{t(`reporter.status.${run.status}`)}</span>
        <span>{t('reporter.phase', { phase: run.phase })}</span>
        <span>{t(`reporter.mode.${run.mode}`)}</span>
      </div>
      <div className="dt-row-meta">
        <span>{t('reporter.project', { project: run.project_source_id })}</span>
        <span>{t('reporter.model', { provider: run.model.provider, model: run.model.model })}</span>
        <span>{t('reporter.reasoning', { effort: run.model.reasoningEffort })}</span>
      </div>
      <div className="dt-row-meta">
        <span>{t('reporter.experiments', { count: run.experiments })}</span>
        <span>{t(run.mode === 'browser' ? 'reporter.browserActions' : 'reporter.actions', { count: run.turns })}</span>
        <span>{t('reporter.modelCalls', { count: run.model_calls })}</span>
      </div>
      <div className="dt-row-meta">
        <span>{t('reporter.promptTokens', { count: run.model_usage.prompt_tokens ?? t('reporter.unknown') })}</span>
        <span>{t('reporter.completionTokens', { count: run.model_usage.completion_tokens ?? t('reporter.unknown') })}</span>
        <span>{t('reporter.cost', { cost: run.model_usage.cost_usd === null ? t('reporter.unknown') : run.model_usage.cost_usd })}</span>
        <span>{t('reporter.retries', { count: run.model_usage.retries ?? t('reporter.unknown') })}</span>
        <span>{t(`reporter.usage.${run.model_usage.completeness}`)}</span>
      </div>
      <div className="dt-row-meta">
        <span>{t('reporter.started')} <When at={run.started_at} /></span>
        <span>{t('reporter.updated')} <When at={run.updated_at} /></span>
      </div>
      {run.summary && <p>{run.summary}</p>}
      {run.error_code && <p className="dt-error dt-mono">{t('reporter.error', { code: run.error_code })}</p>}
      <div>
        <strong>{t('reporter.scenarios')}</strong>
        {run.scenario_ids.length ? <ul>{run.scenario_ids.map(id => <li className="dt-mono" key={id}>{id}</li>)}</ul>
          : <Hint>{t('reporter.noScenarios')}</Hint>}
      </div>
      <div>
        <strong>{t('reporter.experimentLog')}</strong>
        {run.experiment_log.length ? <ul className="dt-list dt-cards">{run.experiment_log.map((experiment, index) => <li
          className="dt-row dt-reporter-experiment" key={`${experiment.kind}:${experiment.scenario_id ?? index}`}>
          <div className="dt-row-main">
            <div className="dt-row-meta">
              <span>{t(`reporter.mode.${experiment.kind}`)}</span>
              {experiment.scenario_id && <span>{t('reporter.scenario', { id: experiment.scenario_id })}</span>}
            </div>
            <strong>{t('reporter.hypothesis')}：{experiment.hypothesis}</strong>
            <details className="dt-reporter-experiment-details">
              <summary>{t('reporter.experimentDetails')}</summary>
              <p><strong>{t('reporter.observation')}：</strong>{experiment.observation}</p>
              {experiment.evidence.length > 0 && <div>
                <strong>{t('reporter.evidence')}</strong>
                <ul>{experiment.evidence.map((item, evidenceIndex) => <li key={evidenceIndex}>{item}</li>)}</ul>
              </div>}
            </details>
          </div>
        </li>)}</ul> : <Hint>{t('reporter.noExperiments')}</Hint>}
      </div>
      <div>
        <strong>{t('reporter.findings')}</strong>
        {run.findings?.length ? <ul className="dt-list dt-cards">{run.findings.map((finding, index) => <ReporterFinding
          key={`${finding.status}:${finding.title}:${index}`} finding={finding} />)}</ul>
          : <Hint>{t('reporter.noFindings')}</Hint>}
      </div>
    </div>
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
          : <ul className="dt-list dt-cards">{data.runs.map(run => <ReporterRun key={run.id} run={run} />)}</ul>}
    </>}
  </Section>
}
