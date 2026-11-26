/** Source status view (health, project orchestrators, filtered/dropped messages) and Repository-scoped Settings workspace. */
import { useEffect, useState, type FormEvent } from 'react'
import type { FieldSpec } from '../sources/kind.ts'
import { usePoll, type DroppedReply, type ProjectOrchestratorView, type SourceStatusRow, type SourceView } from './api.ts'
import { Button, DisclosureRow, Dot, Icon, InfoTip, Input, Modal, SegmentedControl, Switch, Tag } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { SourcePart } from './eval.tsx'
import { sourceMark } from './marks.ts'
import { usePanel, usePanelData } from './provider.tsx'
import { setupPage, settingsRoute, type Route } from './route.ts'
import { ConfigHistory, Field, Fields, SourceField, useBlockDraft, useSettings } from './settings-kit.tsx'
import { actorName, errorText, healthText, localized, readableMarkers, reasonLabel, sourceLabel, valueLabel, when } from './text.ts'
import { CheckSetupButton, Hint, LabelValue, LoadState, Section, SessionButton, SetupMessage, StatusHead, When } from './widgets.tsx'

type FeishuChat = { chatId?: string; projectSourceId?: string; listen?: 'mentions' | 'all' }

function isRepoSource(source: SourceView): boolean {
  return source.kind === 'github' || source.kind === 'gitlab'
}

function sourceRepoPath(source: SourceView): string {
  const repo = typeof source.value.config.repository === 'string' ? source.value.config.repository.trim() : ''
  const host = typeof source.value.config.host === 'string' ? source.value.config.host.trim() : ''
  if (!repo) return ''
  return host && host !== 'github.com' && host !== 'gitlab.com' ? `${host}/${repo}` : repo
}

function sourceScopeName(t: ReturnType<typeof usePanel>['t'], source: SourceView): string {
  return sourceRepoPath(source) || localized(t, source.title)
}

function orchestratorStateKey(item: ProjectOrchestratorView) {
  return !item.enabled ? 'projectSessionDisabled' as const
    : !item.ready ? 'projectSessionNotReady' as const
      : item.status === 'running' ? 'projectSessionRunning' as const
        : item.status === 'error' ? 'projectSessionError' as const
          : item.status === 'missing' ? 'projectSessionMissing' as const : 'projectSessionIdle' as const
}

function orchestratorDotState(item?: ProjectOrchestratorView): 'done' | 'ongoing' | 'warning' | 'error' {
  if (!item || !item.enabled || !item.ready) return 'warning'
  if (item.status === 'error') return 'error'
  if (item.status === 'running') return 'ongoing'
  return 'done'
}

function ProjectOrchestrators({ items }: { items: ProjectOrchestratorView[] }) {
  const { t } = usePanel()
  return <Section title={t('projectOrchestratorsTitle')} count={items.length} hint={t('projectOrchestratorsHint')}>
    {items.length ? <ul className="dt-list">{items.map(item => <li key={item.project_source_id} className="dt-row">
      <Dot state={orchestratorDotState(item)} />
      <div className="dt-row-main">
        <div className="dt-row-title" title={item.project_source_id}>
          <span>{item.host && item.host !== 'github.com' ? `${item.host}/` : ''}{item.repository}</span>
        </div>
        <div className="dt-row-meta">
          <Tag tone={!item.enabled || !item.ready || item.status === 'error' ? 'warning' : 'neutral'}>{t(orchestratorStateKey(item))}</Tag>
          {item.error && <span className="dt-error dt-clamp">{item.error}</span>}
        </div>
      </div>
      <div className="dt-row-actions">
        <SessionButton sessionId={item.session_id} label={t('openProjectSession')} variant="outline" />
      </div>
    </li>)}</ul> : <Hint>{t('projectOrchestratorsEmpty')}</Hint>}
  </Section>
}

function FeishuBindingProblems({ source, repoId }: { source: SourceView; repoId?: string }) {
  const { t } = usePanel()
  const problems = (source.projectBindings ?? []).filter(row => row.problem && (!repoId || row.project_source_id === repoId))
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
          {!repoId && row.project_label && <LabelValue label={t('projectBindingProject')} value={row.project_label} />}
          <Tag tone="warning">{problemLabel(row.problem!)}</Tag>
        </div>
      </div>
    </li>)}</ul>
  </Section>
}

function AddProjectModal({ open, onClose, onAdded }: {
  open: boolean; onClose: () => void; onAdded: (created: { id: string; restarting: boolean }) => Promise<void>
}) {
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
      await onAdded({ id: result.id, restarting: result.restarting })
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
      <p className="dt-hint">{t('addProjectAutoBindHint')}</p>
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

function SourceCard({ source, focus, inScope }: { source: SourceView; focus: boolean; inScope?: boolean }) {
  const { t, call } = usePanel()
  const { running } = usePanelData()
  const { reload } = useSettings()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const refreshLabels = async () => { const { added } = await call('POST sources/:id/labels',
    { id: source.id }); await reload(); return added }
  const draft = useBlockDraft(`source:${source.id}`, source.value, source.revision)
  const value = draft.value
  const { problem, value: saved } = source
  const isRepo = isRepoSource(source)
  const savedRepo = typeof saved.config.repository === 'string' ? saved.config.repository.trim() : ''
  const draftRepo = typeof value.config.repository === 'string' ? value.config.repository.trim() : ''
  const repoSubtitle = sourceRepoPath(source)
  const unconfigured = isRepo && !savedRepo && !draftRepo
  const collapsible = unconfigured && !problem && !focus && !inScope
  const [expanded, setExpanded] = useState(() => !collapsible)
  useEffect(() => { if (focus || problem || draftRepo || inScope) setExpanded(true) }, [focus, problem, draftRepo, inScope])
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

function RepoOrchestratorCard({ source, repoName }: { source: SourceView; repoName: string }) {
  const { t } = usePanel()
  const { settings: { project_orchestrators } } = useSettings()
  const item = project_orchestrators?.find(entry => entry.project_source_id === source.id)
  const repoConfigured = !!sourceRepoPath(source)
  const canOpen = !!item && item.enabled && item.ready && (item.status === 'idle' || item.status === 'running')
  const stateLabel = item ? t(orchestratorStateKey(item))
    : repoConfigured ? t('projectSessionMissing') : t('sourceUnconfigured')
  const dot = orchestratorDotState(item)
  return <div className="dt-card">
    <div className="dt-card-head">
      <div className="dt-row-main">
        <div className="dt-row-title">
          <span className="dt-card-title">{t('repoOrchestratorTitle')}</span>
          <Tag tone="info">{t('repoOrchestratorAutoTag')}</Tag>
        </div>
      </div>
      {canOpen && <SessionButton sessionId={item!.session_id} label={t('openProjectSession')} variant="outline" />}
      {!canOpen && repoConfigured && !source.problem && <CheckSetupButton />}
    </div>
    <Hint>{t('repoOrchestratorAutoBindHint')}</Hint>
    <div className="dt-row-meta">
      <Dot state={dot} />
      <Tag tone={!item || !item.enabled || !item.ready || item.status === 'error' ? 'warning' : 'neutral'}>{stateLabel}</Tag>
      {repoConfigured && <LabelValue label={t('repoOrchestratorSidebarLabel')} value={`编排 · ${repoName}`} />}
      {item?.error && <span className="dt-error dt-clamp">{item.error}</span>}
    </div>
  </div>
}

function RepoFeishuCard({ repoSource, feishuSource, allSources, onSelectScope }: {
  repoSource: SourceView; feishuSource?: SourceView; allSources: SourceView[]; onSelectScope: (id: string) => void
}) {
  const { t, call, notify, restart } = usePanel()
  const { reload } = useSettings()
  const [selectedChat, setSelectedChat] = useState('')
  const [manualChatId, setManualChatId] = useState('')
  const [listen, setListen] = useState<'mentions' | 'all'>('mentions')
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [bindError, setBindError] = useState<string>()

  const rawChats = Array.isArray(feishuSource?.value.config.chats)
    ? (feishuSource.value.config.chats as FeishuChat[]).filter(chat => typeof chat.chatId === 'string' && chat.chatId)
    : []
  const bindingMap = new Map((feishuSource?.projectBindings ?? []).map(binding => [binding.chat_id, binding]))
  const boundToRepo = (chat: FeishuChat) => {
    const id = chat.chatId ?? ''
    return chat.projectSourceId === repoSource.id || bindingMap.get(id)?.project_source_id === repoSource.id
  }
  const boundChats = rawChats.filter(boundToRepo)
  const otherRepoLabel = (id: string | undefined) => {
    if (!id || id === repoSource.id) return undefined
    const target = allSources.find(source => source.id === id)
    return target ? sourceScopeName(t, target) : id
  }
  const knownChoices = feishuSource
    ? Object.entries(feishuSource.labels)
      .filter(([chatId]) => !boundChats.some(chat => chat.chatId === chatId))
      .map(([chatId, name]) => {
        const current = rawChats.find(chat => chat.chatId === chatId)
        const owner = otherRepoLabel(current?.projectSourceId ?? bindingMap.get(chatId)?.project_source_id)
        return { chatId, name: name || chatId, owner }
      })
    : []

  const saveFeishuChats = async (nextChats: FeishuChat[], toastKey: 'repoFeishuBoundSaved' | 'repoFeishuUnboundSaved') => {
    if (!feishuSource) return
    setBusy(true); setBindError(undefined)
    try {
      const result = await call('PUT settings/:block', {
        block: `source:${feishuSource.id}`,
        body: { value: { enabled: feishuSource.value.enabled, config: { ...feishuSource.value.config, chats: nextChats } }, revision: feishuSource.revision },
      })
      if (result.restarting) restart()
      await reload()
      notify(t(toastKey))
    } catch (failure) {
      setBindError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }

  const targetChatId = (knownChoices.length === 0 || selectedChat === '__manual__' ? manualChatId : selectedChat).trim()
  const bindChat = async () => {
    if (!targetChatId) return
    const existingIndex = rawChats.findIndex(chat => chat.chatId === targetChatId)
    const nextEntry: FeishuChat = { chatId: targetChatId, projectSourceId: repoSource.id, listen }
    const nextChats = existingIndex >= 0
      ? rawChats.map((chat, index) => index === existingIndex ? nextEntry : chat)
      : [...rawChats, nextEntry]
    await saveFeishuChats(nextChats, 'repoFeishuBoundSaved')
    setSelectedChat('')
    setManualChatId('')
  }
  const updateListen = async (chatId: string, nextListen: 'mentions' | 'all') => {
    const nextChats = rawChats.map(chat => chat.chatId === chatId ? { ...chat, projectSourceId: repoSource.id, listen: nextListen } : chat)
    await saveFeishuChats(nextChats, 'repoFeishuBoundSaved')
  }
  const unbindChat = async (chatId: string) => {
    await saveFeishuChats(rawChats.filter(chat => chat.chatId !== chatId), 'repoFeishuUnboundSaved')
  }
  const refreshChats = async () => {
    if (!feishuSource) return
    setRefreshing(true); setBindError(undefined)
    try {
      const { added } = await call('POST sources/:id/labels', { id: feishuSource.id })
      await reload()
      notify(added.length ? t('labelsAdded', { names: added.join('、') }) : t('labelsCurrent'))
    } catch (failure) {
      notify(t('labelsFailed', { error: errorText(failure) }))
    } finally {
      setRefreshing(false)
    }
  }

  const botUnavailable = !feishuSource || !feishuSource.installed || !feishuSource.value.enabled || !!feishuSource.problem
  return <div className="dt-card">
    <div className="dt-card-head">
      <div className="dt-row-main">
        <div className="dt-row-title">
          <span className="dt-card-title">{t('repoFeishuTitle')}</span>
          {boundChats.length > 0 && <span className="dt-count">{boundChats.length}</span>}
        </div>
      </div>
      {feishuSource && <Button variant="ghost" size="sm" onClick={() => onSelectScope(feishuSource.id)}>{t('repoFeishuManageGlobal')}</Button>}
    </div>
    <Hint>{t('repoFeishuHint')}</Hint>
    {botUnavailable ? <div className="dt-row-buttons">
      <p className={!feishuSource?.value.enabled ? 'dt-hint' : 'dt-error'}>
        {t(!feishuSource ? 'repoFeishuNeedBot' : !feishuSource.installed ? 'sourceNotInstalledHint' : !feishuSource.value.enabled ? 'repoFeishuNeedBot' : 'problemSetupFeishu')}
      </p>
      {feishuSource?.installed && <Button variant="outline" size="sm" onClick={() => onSelectScope(feishuSource.id)}>
        {t('repoFeishuSetupBot')}
      </Button>}
    </div> : <>
      {boundChats.length > 0 ? <ul className="dt-list">{boundChats.map(chat => {
        const id = chat.chatId!
        const name = feishuSource.labels[id] || id
        const mode = chat.listen === 'all' ? 'all' : 'mentions'
        return <li key={id} className="dt-row">
          <Dot state={bindingMap.get(id)?.problem ? 'warning' : 'done'} />
          <div className="dt-row-main">
            <div className="dt-row-title">
              <span>{name}</span>
              {name !== id && <span className="dt-mono dt-hint">{id}</span>}
            </div>
          </div>
          <div className="dt-row-actions">
            <select className="dt-select dt-inline-select" aria-label={t('repoFeishuListenLabel', { name })} value={mode}
              disabled={busy} onChange={event => { void updateListen(id, event.target.value as 'mentions' | 'all') }}>
              <option value="mentions">{t('repoFeishuListenMentions')}</option>
              <option value="all">{t('repoFeishuListenAll')}</option>
            </select>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void unbindChat(id) }}>{t('repoFeishuUnbind')}</Button>
          </div>
        </li>
      })}</ul> : <Hint>{t('repoFeishuEmpty')}</Hint>}
      <FeishuBindingProblems source={feishuSource} repoId={repoSource.id} />
      <div className="dt-repo-bind-row">
        {knownChoices.length > 0 && <select className="dt-select" aria-label={t('repoFeishuBindChat')} value={selectedChat}
          disabled={busy} onChange={event => setSelectedChat(event.target.value)}>
          <option value="">{t('repoFeishuBindChat')}</option>
          {knownChoices.map(choice => <option key={choice.chatId} value={choice.chatId}>
            {choice.owner ? `${choice.name}（${t('repoFeishuBoundOther', { repo: choice.owner })}）` : choice.name}
          </option>)}
          <option value="__manual__">{t('repoFeishuManualInput')}</option>
        </select>}
        {(knownChoices.length === 0 || selectedChat === '__manual__') && <Input spellCheck={false}
          aria-label={t('repoFeishuChatIdInput')} placeholder={t('repoFeishuChatIdPlaceholder')}
          value={manualChatId} disabled={busy} onChange={event => setManualChatId(event.target.value)} />}
        <select className="dt-select dt-inline-select" aria-label={t('repoFeishuNewListen')} value={listen}
          disabled={busy} onChange={event => setListen(event.target.value as 'mentions' | 'all')}>
          <option value="mentions">{t('repoFeishuListenMentions')}</option>
          <option value="all">{t('repoFeishuListenAll')}</option>
        </select>
        <Button variant="outline" size="sm" disabled={busy || !targetChatId} onClick={() => { void bindChat() }}>
          {t('repoFeishuBindSubmit')}
        </Button>
        <Button variant="ghost" size="sm" icon={<Icon name="refresh" />} className={refreshing ? 'dt-btn-busy' : undefined}
          disabled={busy || refreshing} onClick={() => { void refreshChats() }}>{t('repoFeishuRefreshChats')}</Button>
      </div>
      {bindError && <p className="dt-error" role="alert">{bindError}</p>}
    </>}
  </div>
}

function RepoPolicyCard({ source, titleKey, hintKey }: {
  source: SourceView; titleKey: 'repoPolicyTitle' | 'feishuPolicyTitle'; hintKey: 'repoPolicyHint' | 'feishuPolicyHint'
}) {
  const { t, navigate } = usePanel()
  const { settings: { blocks }, reload } = useSettings()
  const draft = useBlockDraft('policy', blocks.policy.value, blocks.policy.revision)
  const policy = draft.value
  const part = (policy.sources[source.id] ?? { allowed: [] }) as Record<string, unknown>
  return <form className="dt-card dt-form" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <div className="dt-card-head">
        <div className="dt-row-main">
          <div className="dt-row-title"><span className="dt-card-title">{t(titleKey)}</span></div>
        </div>
        <button type="button" className="dt-textlink dt-inline-btn"
          onClick={() => navigate(settingsRoute('eval', { source: source.id }))}>{t('repoPolicyOpenGlobal')}</button>
      </div>
      <Hint>{t(hintKey)}</Hint>
      <SourcePart source={source} part={part} saved={(blocks.policy.value.sources[source.id] ?? {}) as Record<string, unknown>}
        dirty={draft.dirty} reload={reload} onChange={next => draft.edit({
          ...policy,
          sources: { ...policy.sources, [source.id]: next as typeof policy.sources[string] },
        })} />
    </Fields>
    <SaveBar {...draft} onDiscard={draft.discard} />
  </form>
}

function SetupGuide() {
  const { t } = usePanel()
  const steps = [
    ['1', t('repoGuideStep1Title'), t('repoGuideStep1Desc')],
    ['2', t('repoGuideStep2Title'), t('repoGuideStep2Desc')],
    ['3', t('repoGuideStep3Title'), t('repoGuideStep3Desc')],
  ] as const
  return <div className="dt-guide-steps" aria-label={t('repoGuideTitle')}>
    {steps.map(([num, title, desc]) => <div key={num} className="dt-guide-step">
      <div className="dt-guide-step-head"><span className="dt-guide-num">{num}</span><strong>{title}</strong></div>
      <p className="dt-hint">{desc}</p>
    </div>)}
  </div>
}

export function SourceSettings({ focus }: { focus?: string }) {
  const { t, notify, restart } = usePanel()
  const { settings: { sources, project_orchestrators }, reload } = useSettings()
  const [addOpen, setAddOpen] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)

  const repos = sources.filter(isRepoSource)
  const channels = sources.filter(source => !isRepoSource(source))
  const configuredRepos = repos.filter(source => !!sourceRepoPath(source))
  const unconfiguredRepos = repos.filter(source => !sourceRepoPath(source))
  const visibleRepos = configuredRepos.length > 0
    ? repos.filter(source => !!sourceRepoPath(source) || !!source.problem || source.id === focus || showTemplates)
    : repos
  const defaultScope = (focus && sources.some(source => source.id === focus) ? focus : undefined)
    ?? visibleRepos[0]?.id ?? channels[0]?.id ?? ''
  const [selectedId, setSelectedId] = useState(defaultScope)
  useEffect(() => { if (focus && sources.some(source => source.id === focus)) setSelectedId(focus) }, [focus, sources])
  useEffect(() => {
    if (!sources.some(source => source.id === selectedId) && defaultScope) setSelectedId(defaultScope)
  }, [selectedId, sources, defaultScope])

  const current = sources.find(source => source.id === selectedId) ?? visibleRepos[0] ?? channels[0]
  const feishuSource = channels.find(source => source.kind === 'feishu') ?? channels[0]
  const feishuChats = Array.isArray(feishuSource?.value.config.chats)
    ? (feishuSource.value.config.chats as FeishuChat[]) : []
  const feishuBindings = new Map((feishuSource?.projectBindings ?? []).map(item => [item.chat_id, item.project_source_id]))
  const chatCountForRepo = (repoId: string) => feishuChats.filter(chat =>
    chat.projectSourceId === repoId || (chat.chatId ? feishuBindings.get(chat.chatId) === repoId : false)).length
  const orchestratorMap = new Map((project_orchestrators ?? []).map(item => [item.project_source_id, item]))
  const repoDot = (source: SourceView): 'done' | 'ongoing' | 'warning' | 'error' => {
    if (source.problem) return 'error'
    if (!sourceRepoPath(source) || !source.value.enabled) return 'warning'
    return orchestratorDotState(orchestratorMap.get(source.id))
  }
  const channelDot = (source: SourceView): 'done' | 'warning' | 'error' => {
    if (source.problem) return 'error'
    if (!source.value.enabled || (source.projectBindings ?? []).some(item => item.problem)) return 'warning'
    return 'done'
  }
  const currentIsRepo = !!current && isRepoSource(current)
  const currentRepoName = current ? sourceScopeName(t, current) : ''

  return <div className="dt-form">
    <div className="dt-scope-head">
      <div className="dt-row-main">
        <p className="dt-hint">{t('repoScopeSubheading')}</p>
      </div>
      <div className="dt-actions">
        {configuredRepos.length > 0 && unconfiguredRepos.length > 0 && <Button variant="ghost" size="sm"
          onClick={() => setShowTemplates(!showTemplates)}>
          {t(showTemplates ? 'repoHideTemplates' : 'repoShowTemplates', { count: unconfiguredRepos.length })}
        </Button>}
        <Button variant="primary" size="sm" icon={<Icon name="plus" />} onClick={() => setAddOpen(true)}>{t('addProject')}</Button>
      </div>
    </div>
    <SetupGuide />
    <div className="dt-scope-bar" role="tablist" aria-label={t('repoScopeListLabel')}>
      {visibleRepos.map(source => {
        const count = chatCountForRepo(source.id)
        const name = sourceScopeName(t, source)
        const unconfigured = !sourceRepoPath(source)
        return <button key={source.id} type="button" role="tab" aria-selected={current?.id === source.id}
          className="dt-scope-tab" onClick={() => setSelectedId(source.id)}>
          <Dot state={repoDot(source)} />
          <span className="dt-scope-tab-name">{unconfigured ? `${localized(t, source.title)}（${t('sourceUnconfigured')}）` : name}</span>
          {!unconfigured && <Tag tone="neutral">{source.kind === 'gitlab' ? 'GitLab' : 'GitHub'}</Tag>}
          {count > 0 && <Tag tone="info">{t('repoScopeChatCount', { count })}</Tag>}
        </button>
      })}
      {visibleRepos.length > 0 && channels.length > 0 && <span className="dt-scope-divider" aria-hidden />}
      {channels.map(source => <button key={source.id} type="button" role="tab" aria-selected={current?.id === source.id}
        className="dt-scope-tab" onClick={() => setSelectedId(source.id)}>
        <Dot state={channelDot(source)} />
        <span className="dt-scope-tab-name">{localized(t, source.title)}</span>
        <Tag tone="quiet">{t('repoScopeSharedBadge')}</Tag>
      </button>)}
    </div>
    {current && currentIsRepo && <div className="dt-form">
      <div className="dt-scope-banner">
        <Tag tone="info">{current.kind === 'gitlab' ? 'GitLab' : 'GitHub'}</Tag>
        <strong>{currentRepoName}</strong>
        <span className="dt-hint">{t('repoScopeBannerHint')}</span>
      </div>
      <RepoOrchestratorCard source={current} repoName={currentRepoName} />
      <RepoFeishuCard repoSource={current} feishuSource={feishuSource} allSources={sources} onSelectScope={setSelectedId} />
      <SourceCard key={current.id} source={current} focus={focus === current.id} inScope />
      {current.installed && current.policy && <RepoPolicyCard key={`policy-${current.id}`} source={current}
        titleKey="repoPolicyTitle" hintKey="repoPolicyHint" />}
    </div>}
    {current && !currentIsRepo && <div className="dt-form">
      <div className="dt-scope-banner">
        <Tag tone="neutral">{t('repoScopeSharedBadge')}</Tag>
        <strong>{localized(t, current.title)}</strong>
        <span className="dt-hint">{t('feishuScopeBannerHint')}</span>
      </div>
      <SourceCard key={current.id} source={current} focus={focus === current.id} inScope />
      {current.installed && current.policy && <RepoPolicyCard key={`policy-${current.id}`} source={current}
        titleKey="feishuPolicyTitle" hintKey="feishuPolicyHint" />}
    </div>}
    <AddProjectModal open={addOpen} onClose={() => setAddOpen(false)} onAdded={async ({ id, restarting }) => {
      setSelectedId(id)
      notify(t(restarting ? 'savedRestarting' : 'saved'))
      if (restarting) restart()
      await reload()
    }} />
    <ConfigHistory blocks={['source:', 'policy']} />
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
