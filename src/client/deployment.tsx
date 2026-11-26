/**
 * Deployment settings view shared between the panel Settings tab and the DSH Plugin Manager config page.
 * Edits host-level plugin configuration limits through DSH `ConfigForm` when writable.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { LIMITS } from '../limits.ts'
import type { SetupView, UpdateCheckResult, UpdateStatusView } from './api.ts'
import { Button, Icon, InfoTip, Input, Tag, type TagTone } from './controls.tsx'
import { SaveBar, useDraft } from './draft.tsx'
import { PanelProvider, usePanel, usePanelData } from './provider.tsx'
import { Field, Fields } from './settings-kit.tsx'
import { errorText, setupText, type T } from './text.ts'
import { CheckSetupButton, Hint, KeyValues, Section, SetupMessage, When } from './widgets.tsx'

export type DeploymentForm = ConfigPageForm | undefined
type Op = Parameters<ConfigPageForm['mutate']>[0][number]

const MACHINE_LIMITS = ['promptMaxChars', 'admissionContextMaxPages', 'admissionContextTimeoutMs'] as const
type Limits = Record<typeof MACHINE_LIMITS[number], string>
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const limitsOf = (values: object | undefined): Limits =>
  Object.fromEntries(MACHINE_LIMITS.map(key => [key, text((values as Record<string, unknown> | undefined)?.[key])])) as Limits

export function usePageForm(form: ConfigForm<Record<string, unknown>> | undefined): DeploymentForm {
  const subscribe = useCallback((listener: () => void) => form ? form.subscribe(listener) : () => {}, [form])
  const state = useSyncExternalStore(subscribe, () => form?.getSnapshot())
  return useMemo(() => form && state ? { state, mutate: form.mutate.bind(form) } : undefined, [form, state])
}

/** Deployment configuration form; falls back to read-only display when DSH config forms are unavailable or read-only. */
export function DeploymentPage({ setup, form, accounts: showAccounts }: { setup: SetupView; form: DeploymentForm; accounts?: boolean }) {
  const { t, notify } = usePanel()
  const snapshot = form?.state
  const editable = snapshot?.status === 'ready' && snapshot.writable
  // Pass `revision` only while DSH serves writable values so a draft started before `ready` rebases once writable.
  const draft = useDraft({ saved: limitsOf(editable ? snapshot.value : setup.machine), revision: editable ? snapshot.revision : undefined,
    reload: async () => {},
    save: async (value, revision, base) => {
      const ops: Op[] = MACHINE_LIMITS.filter(key => value[key].trim() !== base[key].trim())
        .map(key => value[key].trim() ? { op: 'set', path: [key], value: Number(value[key]) } : { op: 'unset', path: [key] })
      if (!form || !await form.mutate(ops, revision)) throw new Error(t('deploymentRefused'))
      notify(t('saved'))
      return { revision: revision + 1, restarting: false }
    } })
  const accounts = setup.accounts
  // Remote browsers (`memory` mode) are read-only; `unavailable` indicates `dsh-superagent` is still starting.
  const readOnlyHint = !form ? t('deploymentNoForms') : snapshot?.mode === 'memory' ? t('deploymentReadOnly')
    : snapshot?.status === 'loading' ? t('loading') : snapshot?.status === 'unavailable' ? t('deploymentUnavailable')
    : !editable ? t('deploymentReadOnly') : undefined
  const limit = (key: typeof MACHINE_LIMITS[number], label: string) => <Field label={label}>
    <Input type="number" min={LIMITS[key].min} max={LIMITS[key].max} step={1} value={draft.value[key]} disabled={!editable}
      onChange={event => draft.edit({ ...draft.value, [key]: event.target.value })} />
  </Field>
  const feishu = accounts?.feishu ? accounts.feishu.name || accounts.feishu.botId
    : setup.feishuProblem ? setupText(t, setup.feishuProblem) : t('deploymentFeishuNone')
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <Hint>{t('deploymentIntro')}</Hint>
        {setup.problem && <div className="dt-row-buttons">
          <p className="dt-error" role="status"><SetupMessage problem={setup.problem} lead /></p><CheckSetupButton />
        </div>}
        {showAccounts && <Section title={t('deploymentDerived')} hint={t('deploymentDerivedHint')}>
          <KeyValues rows={[[t('deploymentRepository'), accounts?.repository ?? '—'],
            [t('deploymentAgent'), accounts ? `@${accounts.agent}` : '—'], [t('deploymentFeishu'), feishu]]} />
          <Hint>{t('deploymentAccountsWhere')}</Hint>
        </Section>}
        <Section title={t('deploymentMachine')}>
          {readOnlyHint && <Hint>{readOnlyHint}</Hint>}
          <div className="dt-field">
            <span className="dt-field-head">{t('deploymentStateDir')}<InfoTip text={t('deploymentStateDirHint')} /></span>
            <span className="dt-mono">{setup.machine.stateDir}</span>
          </div>
        </Section>
        <Section title={t('deploymentLimits')} hint={t('deploymentLimitsHint')}>
          {limit('promptMaxChars', t('deploymentPromptMaxChars'))}
          {limit('admissionContextMaxPages', t('deploymentContextPages'))}
          {limit('admissionContextTimeoutMs', t('deploymentContextTimeout'))}
        </Section>
      </Fields>
      {editable && <SaveBar {...draft} onDiscard={draft.discard} />}
    </form>
    <UpdateSection />
  </div>
}

function hostActionTone(action: NonNullable<UpdateStatusView['hostStatus']>['action'], upToDate: boolean | null): TagTone {
  if (action === 'updated' || action === 'noop' || (action === 'check' && upToDate === true)) return 'success'
  if (action === 'deferred') return 'warning'
  if (action === 'rolled_back' || action === 'rollback_failed' || action === 'failed') return 'danger'
  return 'info'
}

/** Read-only current build version, host auto-update status, and manual GHCR update check section. */
function UpdateSection() {
  const { t, call, notify } = usePanel()
  const [status, setStatus] = useState<UpdateStatusView>()
  const [loadError, setLoadError] = useState<string>()
  const [imageInput, setImageInput] = useState('')
  const edited = useRef(false)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string>()
  const [result, setResult] = useState<UpdateCheckResult>()

  useEffect(() => {
    let active = true
    call('GET update').then(
      value => {
        if (!active) return
        setStatus(value)
        setLoadError(undefined)
        if (!edited.current && value.current.image) setImageInput(value.current.image)
      },
      failure => { if (active) setLoadError(errorText(failure)) },
    )
    return () => { active = false }
  }, [call])

  const runCheck = async () => {
    if (checking) return
    setChecking(true)
    setCheckError(undefined)
    try {
      const target = imageInput.trim()
      const [checked, refreshed] = await Promise.all([
        call('POST update/check', { body: target ? { image: target } : {} }),
        call('GET update').catch(() => undefined),
      ])
      setResult(checked)
      if (refreshed) setStatus(refreshed)
    } catch (failure) {
      setCheckError(errorText(failure))
    } finally {
      setChecking(false)
    }
  }

  const targetImage = imageInput.trim() || status?.current.image || 'ghcr.io/owner/dsh-superagent-prototype:edge'
  const hostCommand = `DSH_SUPERAGENT_IMAGE=${targetImage} python3 scripts/docker-auto-update update`
  const copyCommand = async () => {
    try {
      await navigator.clipboard?.writeText(hostCommand)
      notify(t('copied'))
    } catch { /* Clipboard permission may be absent in non-secure or test contexts. */ }
  }

  const hostStatus = status?.hostStatus
  return <Section title={t('deploymentUpdate')} hint={t('deploymentUpdateHint')}>
    {loadError && <p className="dt-error" role="alert">{loadError}</p>}
    {status && <KeyValues rows={[
      [t('deploymentUpdateVersion'), <span className="dt-mono">v{status.current.version}</span>],
      [t('deploymentUpdateCommit'), status.current.commit
        ? <span className="dt-mono">{status.current.commit.slice(0, 12)}</span>
        : <span className="dt-hint">{t('deploymentUpdateUnknown')}</span>],
      [t('deploymentUpdateBuildTime'), status.current.buildTime ? <When at={status.current.buildTime} /> : '—'],
      [t('deploymentUpdateImage'), status.current.image
        ? <span className="dt-mono">{status.current.image}</span>
        : <span className="dt-hint">{t('deploymentUpdateImageUnset')}</span>],
    ]} />}
    {hostStatus ? <div className="dt-card">
      <KeyValues rows={[
        [t('deploymentUpdateHostLast'), <When at={hostStatus.checkedAt} />],
        [t('deploymentUpdateHostResult'), <Tag tone={hostActionTone(hostStatus.action, hostStatus.upToDate)}>
          {t(`hostUpdateAction.${hostStatus.action}`)}</Tag>],
        ...hostStatus.runningWorkers !== null
          ? [[t('deploymentUpdateHostWorkers'), String(hostStatus.runningWorkers)] as [string, string]] : [],
        ...hostStatus.rollbackTag
          ? [[t('deploymentUpdateHostRollback'), <span className="dt-mono">{hostStatus.rollbackTag}</span>] as [string, ReactNode]] : [],
        ...hostStatus.error
          ? [[t('deploymentUpdateHostError'), <span className="dt-error">{hostStatus.error}</span>] as [string, ReactNode]] : [],
      ]} />
    </div> : status ? <Hint>{t('deploymentUpdateHostNone')}</Hint> : null}
    <Field label={t('deploymentUpdateImageField')}>
      <Input value={imageInput} placeholder="ghcr.io/owner/dsh-superagent-prototype:edge"
        onChange={event => { edited.current = true; setImageInput(event.target.value) }} />
    </Field>
    <div className="dt-actions">
      <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />}
        className={checking ? 'dt-btn-busy' : undefined} disabled={checking} onClick={() => { void runCheck() }}>
        {checking ? t('deploymentUpdateChecking') : t('deploymentUpdateCheck')}
      </Button>
    </div>
    {checkError && <p className="dt-error" role="alert">{checkError}</p>}
    {result && <UpdateCheckBanner result={result} hostCommand={hostCommand} onCopy={() => { void copyCommand() }} />}
  </Section>
}

function UpdateCheckBanner({ result, hostCommand, onCopy }: {
  result: UpdateCheckResult; hostCommand: string; onCopy: () => void
}) {
  const { t } = usePanel()
  const remoteMeta = <>
    {result.remoteCommit && <span className="dt-hint">
      {t('deploymentUpdateRemoteCommit', { sha: result.remoteCommit.slice(0, 12) })}
      {result.remoteCommitMessage ? ` · ${result.remoteCommitMessage}` : ''}
    </span>}
    {result.remoteDigest && <span className="dt-hint dt-mono">
      {t('deploymentUpdateRemoteDigest', { digest: result.remoteDigest })}
    </span>}
  </>
  if (result.state === 'error') {
    return <p className="dt-error" role="alert">{t('deploymentUpdateCheckError', { detail: result.detail ?? 'unknown' })}</p>
  }
  if (result.state === 'up_to_date') {
    return <div className="dt-card" role="status">
      <div className="dt-actions"><Tag tone="success">{t('deploymentUpdateUpToDate')}</Tag><span className="dt-mono">{result.image}</span></div>
      {remoteMeta}
    </div>
  }
  const title = result.state === 'update_available' ? t('deploymentUpdateAvailable')
    : result.state === 'auth_required' ? t('deploymentUpdateAuthRequired')
    : t('deploymentUpdateCheckUnknown')
  return <div className="dt-banner" role="status">
    <p><strong>{title}</strong></p>
    {remoteMeta}
    <p>{t('deploymentUpdateHostHint')} <code className="dt-code">{hostCommand}</code></p>
    <div className="dt-actions">
      <Button variant="outline" size="sm" icon={<Icon name="copy" size={14} />} onClick={onCopy}>
        {t('deploymentUpdateCopyCmd')}
      </Button>
    </div>
  </div>
}

/** Plugin Manager config page; includes derived repository and accounts because Source settings live in the main panel. */
function PluginPage({ form }: { form: DeploymentForm }) {
  const { t } = usePanel()
  const { state, error } = usePanelData()
  return <div className="dt-embedded">
    {state ? <DeploymentPage setup={state.setup} form={form} accounts />
      : error ? <p className="dt-error" role="alert">{error.message}</p> : <p className="dt-hint">{t('loading')}</p>}
  </div>
}
/** DSH Plugin Manager config view entry; renders nothing in `summary` mode because DSH displays the package description. */
export function PluginConfig({ t, view, form }: { t: T; view: 'page' | 'summary'; form: DeploymentForm }) {
  return view === 'page' ? <PanelProvider t={t} interval={10_000}><PluginPage form={form} /></PanelProvider> : null
}
