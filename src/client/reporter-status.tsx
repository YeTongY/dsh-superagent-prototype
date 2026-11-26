/** 展示 Reporter 提交的报告，并通过 DSH 原生组件打开 Reporter Session。 */
import { useState } from 'react'
import type { ReporterAutonomousRunView } from '../reporter/autonomous.ts'
import type { DshSuperagentKey } from './locales.ts'
import { usePoll } from './api.ts'
import { Button, DisclosureRow, Icon } from './controls.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { sourceLabel } from './text.ts'
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
  const { t, navigate } = usePanel()
  const { state: panelState } = usePanelData()
  const [fullOpen, setFullOpen] = useState(false)
  const state = run.status === 'failed' ? 'error' : run.status === 'cancelled' ? 'warning'
    : run.status === 'completed' ? 'success' : 'ongoing'
  const projectDisplay = sourceLabel(t, run.project_source_id, panelState?.project_orchestrators)

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
        <div><dt>{t('reporter.projectLabel')}</dt><dd title={run.project_source_id}>{projectDisplay}</dd></div>
        <div><dt>{t('reporter.modeLabel')}</dt><dd>{t(modeKeys[run.mode])}</dd></div>
        <div><dt>{t('reporter.modelLabel')}</dt><dd>{run.model
          ? <>{run.model.provider}/{run.model.model}{run.model.reasoningEffort ? <> · {t('reporter.reasoning', { effort: run.model.reasoningEffort })}</> : null}</>
          : t('reporter.modelPending')}</dd></div>
        {run.ticket_id && <div><dt>{t('reporter.ticketId')}</dt><dd>
          <button type="button" className="dt-textlink dt-mono"
            onClick={() => navigate({ page: 'execution', id: run.ticket_id! })}>{run.ticket_id}</button>
        </dd></div>}
      </dl>

      {run.summary && <section className="dt-reporter-report-section">
        <h4>{t('reporter.summary')}</h4>
        <p>{run.summary}</p>
      </section>}
      {run.full_report && <section className="dt-reporter-report-section">
        <DisclosureRow icon={<Icon name="review" />} title={t('reporter.fullReport')} open={fullOpen}
          onToggle={() => setFullOpen(!fullOpen)}>
          <div className="dt-disclosure-body"><MarkdownLite text={run.full_report} /></div>
        </DisclosureRow>
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

const DEFAULT_RUNS = 3
export function ReporterStatus() {
  const { t, call } = usePanel()
  const { data, error } = usePoll(() => call('GET reporter'), [])
  const [showAll, setShowAll] = useState(false)
  const runs = data?.runs ?? []
  const shown = showAll ? runs : runs.slice(0, DEFAULT_RUNS)
  return <Section title={t('reporter.title')} count={runs.length}>
    {!data ? <LoadState error={error} loading /> : <>
      {error && <LoadState error={error} loading={false} />}
      {!data.enabled ? <Hint>{t('reporter.disabled')}</Hint>
        : runs.length === 0 ? <Hint>{t('reporter.enabledIdle')}</Hint>
          : <>
            <ul className="dt-list dt-reporter-runs">{shown.map(run => <ReporterRun key={run.id} run={run} />)}</ul>
            {runs.length > DEFAULT_RUNS && <div className="dt-reporter-more">
              <Button variant="outline" size="sm" icon={<Icon name={showAll ? 'chevron-up' : 'chevron-down'} size={14} />}
                onClick={() => setShowAll(!showAll)}>
                {showAll ? t('reporterShowLess') : t('reporterShowAll', { count: runs.length })}
              </Button>
            </div>}
          </>}
    </>}
  </Section>
}
