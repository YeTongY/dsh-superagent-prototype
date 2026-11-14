/** 展示 Reporter 提交的报告，并通过 DSH 原生组件打开 Reporter Session。 */
import type { ReporterAutonomousRunView } from '../reporter/autonomous.ts'
import type { DshSuperagentKey } from './locales.ts'
import { usePoll } from './api.ts'
import { usePanel } from './provider.tsx'
import { Hint, LoadState, MarkdownLite, Section, SessionButton, When } from './widgets.tsx'

const statusKeys: Record<ReporterAutonomousRunView['status'], DshSuperagentKey> = {
  running: 'reporter.status.running',
  waiting: 'reporter.status.waiting',
  completed: 'reporter.status.completed',
  failed: 'reporter.status.failed',
  cancelled: 'reporter.status.cancelled',
}

const modeKeys: Record<ReporterAutonomousRunView['mode'], DshSuperagentKey> = {
  simulation: 'reporter.mode.simulation',
  'real-service': 'reporter.mode.real-service',
  browser: 'reporter.mode.browser',
  both: 'reporter.mode.both',
}

function ReporterRun({ run }: { run: ReporterAutonomousRunView }) {
  const { t } = usePanel()
  const state = run.status === 'failed' ? 'error' : run.status === 'cancelled' ? 'warning'
    : run.status === 'completed' ? 'success' : 'ongoing'

  return <li className="dt-reporter-run" data-state={state}>
    <article className="dt-reporter-card">
      <header className="dt-reporter-head">
        <div className="dt-reporter-title-line">
          <h3 className="dt-reporter-goal">{run.goal}</h3>
          <span className="dt-reporter-status" data-status={run.status}>{t(statusKeys[run.status])}</span>
        </div>
        <span className="dt-reporter-updated"><span>{t('reporter.updatedShort')}</span><When at={run.updated_at} /></span>
      </header>

      <dl className="dt-reporter-meta">
        <div><dt>{t('reporter.projectLabel')}</dt><dd className="dt-mono">{run.project_source_id}</dd></div>
        <div><dt>{t('reporter.modeLabel')}</dt><dd>{t(modeKeys[run.mode])}</dd></div>
        <div><dt>{t('reporter.modelLabel')}</dt><dd>{run.model
          ? <>{run.model.provider}/{run.model.model}{run.model.reasoningEffort ? <> · {t('reporter.reasoning', { effort: run.model.reasoningEffort })}</> : null}</>
          : t('reporter.modelPending')}</dd></div>
        {run.ticket_id && <div><dt>{t('reporter.ticketId')}</dt><dd className="dt-mono">{run.ticket_id}</dd></div>}
      </dl>

      {run.summary && <section className="dt-reporter-report-section">
        <h4>{t('reporter.summary')}</h4>
        <p>{run.summary}</p>
      </section>}
      {run.full_report && <section className="dt-reporter-report-section">
        <h4>{t('reporter.fullReport')}</h4>
        <MarkdownLite text={run.full_report} />
      </section>}
      {!run.summary && run.status !== 'failed' && run.status !== 'cancelled'
        && <Hint>{t('reporter.investigating')}</Hint>}
      {run.error_code && <p className="dt-reporter-error"><span>{t('reporter.errorCode')}：</span><code>{run.error_code}</code></p>}

      <div className="dt-reporter-actions">
        <SessionButton sessionId={run.session_id} label={t('reporter.openSession')} variant="outline" />
      </div>
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
