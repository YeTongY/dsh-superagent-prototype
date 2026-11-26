/** Source status view (health, project orchestrators, filtered/dropped messages) and Repos & Channels settings. */
import { useEffect, useState, type FormEvent } from 'react'
import type { FieldSpec } from '../sources/kind.ts'
import { usePoll, type DroppedReply, type ProjectOrchestratorView, type SourceStatusRow, type SourceView } from './api.ts'
import { Button, DisclosureRow, Dot, Icon, InfoTip, Input, Modal, SegmentedControl, Switch, Tag } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { sourceMark } from './marks.ts'
import { usePanel, usePanelData } from './provider.tsx'
import { setupPage, settingsRoute, type Route } from './route.ts'
import { ConfigHistory, Field, Fields, SourceField, useBlockDraft, useSettings } from './settings-kit.tsx'
import { actorName, errorText, healthText, localized, readableMarkers, reasonLabel, sourceLabel, valueLabel, when } from './text.ts'
import { CheckSetupButton, Hint, LabelValue, LoadState, Section, SessionButton, SetupMessage, StatusHead, When } from './widgets.tsx'

function ProjectOrchestrators({ items }: { items: ProjectOrchestratorView[] }) {
  const { t } = usePanel()
  const state = (item: ProjectOrchestratorView) => !item.enabled ? t('projectSessionDisabled')
    : !item.ready ? t('projectSessionNotReady')
      : item.status === 'running' ? t('projectSessionRunning')
        : item.status === 'error' ? t('projectSessionError')
          : item.status === 'missing' ? t('projectSessionMissing') : t('projectSessionIdle')
  return <Section title={t('projectOrchestratorsTitle')} count={items.length} hint={t('projectOrchestratorsHint')}>
    {items.length ? <ul className="dt-list">{items.map(item => <li key={item.project_source_id} className="dt-row">
      <Dot state={!item.enabled || !item.ready ? 'warning' : item.status === 'error' ? 'error' : item.status === 'running' ? 'ongoing' : 'done'} />
      <div className="dt-row-main">
        <div className="dt-row-title" title={item.project_source_id}>
          <span>{item.host && item.host !== 'github.com' ? `${item.host}/` : ''}{item.repository}</span>
        </div>
        <div className="dt-row-meta">
          <Tag tone={!item.enabled || !item.ready || item.status === 'error' ? 'warning' : 'neutral'}>{state(item)}</Tag>
          {item.error && <span className="dt-error dt-clamp">{item.error}</span>}
        </div>
      </div>
      <div className="dt-row-actions">
        <SessionButton sessionId={item.session_id} label={t('openProjectSession')} variant="outline" />
      </div>
    </li>)}</ul> : <Hint>{t('projectOrchestratorsEmpty')}</Hint>}
  </Section>
}

function FeishuBindingProblems({ source }: { source: SourceView }) {
  const { t } = usePanel()
  const problems = (source.projectBindings ?? []).filter(row => row.problem)
  if (!problems.length) return null
  const problemLabel = (problem: NonNullable<(typeof problems)[number]['problem']>) => {
    const keys = {
      project_not_bound: 'projectBindingNotBound', project_not_ready: 'projectBindingNotReady',
      project_unknown: 'projectBindingUnknown', project_binding_ambiguous: 'projectBindingAmbiguous',
      project_binding_stale: 'projectBindingStale',
      session_not_ready: 'projectSessionNotReady', session_disabled: 'projectSessionDisabled',
    } as const
    return t(keys[problem])
  }
  return <Section title={t('feishuProjectBindingsTitle')} count={problems.length} hint={t('feishuProjectBindingsHint')}>
    <ul className="dt-list">{problems.map(row => <li key={row.chat_id} className="dt-row">
      <Dot state="warning" />
      <div className="dt-row-main">
        <div className="dt-row-title"><span>{row.chat_name}</span><span className="dt-mono dt-hint">{row.chat_id}</span></div>
        <div className="dt-row-meta">
          {row.project_label && <LabelValue label={t('projectBindingProject')} value={row.project_label} />}
          <Tag tone="warning">{problemLabel(row.problem!)}</Tag>
        </div>
      </div>
    </li>)}</ul>
  </Section>
}

function AddProjectModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (restarting: boolean) => Promise<void> }) {
  const { t, call } = usePanel()
  const [provider, setProvider] = useState<'github' | 'gitlab'>('github')
  const [repository, setRepository] = useState('')
  const [host, setHost] = useState('gitlab.com')
  const [cli, setCli] = useState('gh')
  const [configDir, setConfigDir] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const switchProvider = (next: 'github' | 'gitlab') => {
    setProvider(next)
    setError(undefined)
    if (next === 'github' && cli === 'glab') setCli('gh')
    if (next === 'gitlab' && cli === 'gh') setCli('glab')
  }
  const reset = () => {
    setRepository(''); setHost('gitlab.com'); setCli(provider === 'github' ? 'gh' : 'glab'); setConfigDir(''); setEnabled(true); setError(undefined)
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true); setError(undefined)
    try {
      const config = provider === 'github'
        ? { repository: repository.trim(), cli: cli.trim() }
        : { repository: repository.trim(), host: host.trim(), cli: cli.trim(), ...(configDir.trim() ? { configDir: configDir.trim() } : {}) }
      const result = await call('POST projects', { body: { provider, config, enabled } })
      await onAdded(result.restarting)
      reset()
      onClose()
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }
  return <Modal open={open} onClose={() => { if (!busy) onClose() }} title={t('addProjectTitle')} closeLabel={t('close')}>
    <form className="dt-form" onSubmit={event => { void submit(event) }}>
      <Field label={t('addProjectProvider')}>
        <SegmentedControl className="dt-segmented" label={t('addProjectProvider')} value={provider} onChange={switchProvider}
          options={[{ value: 'github', label: 'GitHub' }, { value: 'gitlab', label: 'GitLab' }]} />
      </Field>
      <Field label={t(provider === 'github' ? 'addProjectRepo' : 'addProjectGitlabPath')}>
        <Input spellCheck={false} required
          pattern={provider === 'github' ? '[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+' : undefined}
          placeholder={t(provider === 'github' ? 'addProjectRepoPlaceholder' : 'addProjectGitlabPlaceholder')}
          value={repository} onChange={event => setRepository(event.target.value)} />
      </Field>
      {provider === 'gitlab' && <Field label={t('addProjectHost')}>
        <Input spellCheck={false} required value={host} onChange={event => setHost(event.target.value)} />
      </Field>}
      <Field label={t('addProjectCli')}>
        <Input spellCheck={false} required value={cli} onChange={event => setCli(event.target.value)} />
      </Field>
      {provider === 'gitlab' && <Field label={t('addProjectConfigDir')}>
        <Input spellCheck={false} placeholder={t('addProjectConfigDirPlaceholder')} value={configDir}
          onChange={event => setConfigDir(event.target.value)} />
      </Field>}
      <div className="dt-switch-row">
        <div className="dt-field-head">{t('addProjectEnableNow')}</div>
        <Switch checked={enabled} onChange={setEnabled} label={t('addProjectEnableNow')} />
      </div>
      {error && <p className="dt-error" role="alert">{error}</p>}
      <div className="dt-actions dt-modal-actions">
        <Button variant="ghost" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
        <Button variant="primary" type="submit" disabled={busy}>{t('addProjectSubmit')}</Button>
      </div>
    </form>
  </Modal>
}

function SourceCard({ source, focus }: { source: SourceView; focus: boolean }) {
  const { t, call } = usePanel()
  const { running } = usePanelData()
  const { reload } = useSettings()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const refreshLabels = async () => { const { added } = await call('POST sources/:id/labels',
    { id: source.id }); await reload(); return added }
  const draft = useBlockDraft(`source:${source.id}`, source.value, source.revision)
  const value = draft.value
  const { problem, value: saved } = source
  const isRepo = source.kind === 'github' || source.kind === 'gitlab'
  const savedRepo = typeof saved.config.repository === 'string' ? saved.config.repository.trim() : ''
  const draftRepo = typeof value.config.repository === 'string' ? value.config.repository.trim() : ''
  const host = typeof value.config.host === 'string' ? value.config.host.trim() : ''
  const repoSubtitle = isRepo && draftRepo ? (host && host !== 'github.com' && host !== 'gitlab.com' ? `${host}/${draftRepo}` : draftRepo) : ''
  const unconfigured = isRepo && !savedRepo && !draftRepo
  const collapsible = unconfigured && !problem && !focus
  const [expanded, setExpanded] = useState(() => !collapsible)
  useEffect(() => { if (focus || problem || draftRepo) setExpanded(true) }, [focus, problem, draftRepo])
  const changed = (key: string) => String(value.config[key] ?? '') !== String(saved.config[key] ?? '')
  // Saving a modified setup-sensitive field restarts dsh-superagent, interrupting running Assignments.
  const restarts = draft.dirty && source.restarts.some(changed)
  const description = localized(t, source.description)
  // Hide derived facts for unsaved field edits until the new value is saved.
  const field = (spec: FieldSpec) => <SourceField key={spec.key} field={spec} value={value.config[spec.key]} saved={saved.config[spec.key]}
    labels={source.labels}
    refreshLabels={refreshLabels} fact={spec.type === 'fact' || !changed(spec.key) ? source.facts[spec.key] : undefined}
    onChange={next => draft.edit({ ...value, config: { ...value.config, [spec.key]: next } })} />
  const advanced = source.fields.filter(spec => spec.advanced)
  return <form id={`dt-source-${source.id}`} className="dt-card" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <div className="dt-card-head">
        <div className="dt-row-main">
          <div className="dt-row-title">
            <span className="dt-card-title">{localized(t, source.title)}</span>
            {repoSubtitle && <span className="dt-card-sub">{repoSubtitle}</span>}
            {unconfigured && <Tag tone="neutral">{t('sourceUnconfigured')}</Tag>}
            {description && <InfoTip text={description} />}
            {!source.installed && <Tag tone="warning">{t('sourceNotInstalled')}</Tag>}
          </div>
        </div>
        {collapsible && <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>
          {t(expanded ? 'sourceCollapseConfig' : 'sourceExpandConfig')}
        </Button>}
        {source.installed && <Switch checked={value.enabled} onChange={enabled => draft.edit({ ...value, enabled })}
          label={t('sourceEnable', { name: localized(t, source.title) })} />}
      </div>
      {problem && <div className="dt-row-buttons">
        <p className="dt-error" role="status"><SetupMessage problem={problem} lead /></p><CheckSetupButton />
      </div>}
      {!source.installed && <Hint>{t('sourceNotInstalledHint')}</Hint>}
      {source.installed && expanded && source.fields.filter(spec => !spec.advanced).map(field)}
      {source.installed && expanded && source.kind === 'feishu' && <FeishuBindingProblems source={source} />}
      {source.installed && expanded && advanced.length > 0 && <DisclosureRow icon={<Icon name="settings" />} title={t('advanced')} open={advancedOpen}
        onToggle={() => setAdvancedOpen(!advancedOpen)}>
        <div className="dt-disclosure-body">{advanced.map(field)}</div>
      </DisclosureRow>}
    </Fields>
    <SaveBar {...draft} status={restarts && running > 0 ? t('restartInterrupts', { count: running }) : undefined}
      onDiscard={draft.discard} />
  </form>
}

export function SourceSettings({ focus }: { focus?: string }) {
  const { t, notify, restart } = usePanel()
  const { settings: { sources }, reload } = useSettings()
  const [addOpen, setAddOpen] = useState(false)
  useEffect(() => { if (focus) document.getElementById(`dt-source-${focus}`)?.scrollIntoView?.({ block: 'start' }) }, [focus])
  const repos = sources.filter(source => source.kind === 'github' || source.kind === 'gitlab')
  const channels = sources.filter(source => source.kind !== 'github' && source.kind !== 'gitlab')
  return <div className="dt-form">
    {channels.length > 0 && <Section title={t('channelsSectionTitle')} count={channels.length}>
      <div className="dt-form">{channels.map(source => <SourceCard key={source.id} source={source} focus={focus === source.id} />)}</div>
    </Section>}
    <Section title={t('reposSectionTitle')} count={repos.length} action={<Button variant="outline" size="sm" icon={<Icon name="plus" />}
      onClick={() => setAddOpen(true)}>{t('addProject')}</Button>}>
      <div className="dt-form">{repos.map(source => <SourceCard key={source.id} source={source} focus={focus === source.id} />)}</div>
    </Section>
    <AddProjectModal open={addOpen} onClose={() => setAddOpen(false)} onAdded={async restarting => {
      notify(t(restarting ? 'savedRestarting' : 'saved'))
      if (restarting) restart()
      await reload()
    }} />
    <ConfigHistory blocks={['source:']} />
  </div>
}

function DroppedReplies({ items }: { items: DroppedReply[] }) {
  const { t, navigate } = usePanel()
  const [open, setOpen] = useState(false)
  // Link to the message's Ticket, or fall back to its Thread for messages queued before receipts recorded `ticketId`.
  const target = (item: DroppedReply): { route: Route; name: string } | undefined => item.ticket
    ? { route: { page: 'execution', id: item.ticket.id }, name: item.ticket.title }
    : item.thread ? { route: { page: 'trigger', id: item.thread }, name: t('term.thread') } : undefined
  return <DisclosureRow icon={<Icon name="dismiss" />} title={<>{t('sourceDroppedTitle')} <span
    className="dt-count">{items.length}</span></>} open={open}
    onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('sourceDroppedHint')}</Hint>
      <ul className="dt-list">{items.map(item => {
        const link = target(item)
        return <li key={item.id} className="dt-row"><Dot state="idle" /><div className="dt-row-main">
          <div className="dt-row-title dt-line">{readableMarkers(t, item.preview) || t('empty')}</div>
          <div className="dt-row-meta">
            <Tag tone="neutral">{reasonLabel(t, item.dropped.reason)}</Tag><When at={item.dropped.at} />
            {link && <button type="button" className="dt-textlink" onClick={() => navigate(link.route)}>{link.name}</button>}
          </div>
        </div></li>
      })}</ul>
    </div>
  </DisclosureRow>
}
function SourceRow({ source, repo }: { source: SourceStatusRow; repo?: string }) {
  const { t, navigate } = usePanel()
  const { setup } = usePanelData()
  const [filteredOpen, setFilteredOpen] = useState(false)
  const { problem, dropped } = source
  const { dot, label: state } = sourceMark(t, source.state)
  const { received, filtered, lastAt } = source.stats
  // Omit healthy parts and suppress per-part notes when a setup problem already explains why the Source is stopped.
  const notes = source.enabled && !problem && !setup?.problem ? source.health.filter(item => item.state === 'error'
    || item.state === 'paused') : []
  return <li className="dt-row">
    <Dot state={dot} label={state} />
    <div className="dt-row-main">
      <div className="dt-row-title">
        <span className="dt-row-name">{localized(t, source.title)}</span>
        {repo && <span className="dt-card-sub">{repo}</span>}
        <span className="dt-status-text" data-state={dot}>{state}</span>
      </div>
      <div className="dt-row-meta">
        {received > 0 && <LabelValue label={t('sourceReceivedLabel')}
          value={received} />}{filtered > 0 && <LabelValue label={t('sourceFilteredLabel')} value={filtered} />}
        {lastAt && <LabelValue label={t('sourceLatestLabel')} value={when(lastAt, t('lang'))} />}
      </div>
      {problem && <p className="dt-error">
        <SetupMessage problem={problem} lead /> <button type="button" className="dt-textlink"
          onClick={() => navigate(settingsRoute('source', { source: source.id }))}>
          {t('sourceOpenSettings')}
        </button>
      </p>}
      {notes.map(item => <p key={item.name} className={item.state === 'error' ? 'dt-error dt-clamp' : 'dt-hint dt-clamp'}>
        {valueLabel(t, 'health', item.name)}{t('labelSeparator')}<span className={item.code ? undefined : 'dt-mono'}>{healthText(t,
          item)}</span>
      </p>)}
      {source.filtered.length > 0 && <DisclosureRow icon={<Icon name="filter" />} title={t('sourceFilteredTitle')} open={filteredOpen}
        onToggle={() => setFilteredOpen(!filteredOpen)}>
        <div className="dt-disclosure-body">
          <ul className="dt-list">{source.filtered.map(item => <li key={item.id} className="dt-row"><Dot state="idle" /><div
            className="dt-row-main">
            <div className="dt-row-title">{actorName(t, item.actor)}{t('labelSeparator')}{readableMarkers(t, item.preview)
              || t('empty')}</div>
            <div className="dt-row-meta"><Tag tone="neutral">{reasonLabel(t, item.reason)}</Tag><When at={item.at} /></div>
          </div></li>)}</ul>
        </div>
      </DisclosureRow>}
      {dropped.length > 0 && <DroppedReplies items={dropped} />}
    </div>
  </li>
}

export function SourceStatus() {
  const { t, call, navigate } = usePanel()
  const { state, setup } = usePanelData()
  const { data, error } = usePoll(() => call('GET sources'), [])
  const projects = state?.project_orchestrators ?? []
  const repoOf = (id: string) => {
    const label = sourceLabel(t, id, projects)
    return label && label !== 'GitHub' && label !== 'GitLab' && label !== '飞书' && label !== 'Feishu' && label !== id ? label : undefined
  }
  // Global deployment setup problems halt all Sources and show at the top; Source-specific setup problems show on that Source's row.
  const elsewhere = setup?.problem?.place === 'deployment' ? setup.problem : undefined
  return <div className="dt-form">
    <StatusHead hint={t('sourceStatusIntro')} settings="source" />
    {elsewhere && <p className="dt-error">
      <SetupMessage problem={elsewhere} lead /> <button type="button" className="dt-textlink"
        onClick={() => navigate(setupPage(elsewhere.place))}>{t('setupFixLink')}</button>
    </p>}
    <LoadState error={error} loading={!data} />
    {data && <ul className="dt-list">{data.map(source => <SourceRow key={source.id} source={source} repo={repoOf(source.id)} />)}</ul>}
    <ProjectOrchestrators items={projects} />
  </div>
}
