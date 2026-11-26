/** Settings tab shell routing between stage settings (Sources, Eval, Execution), Prompts, and Deployment. */
import type { StateView } from './api.ts'
import { DeploymentPage, type DeploymentForm } from './deployment.tsx'
import { EvalSettings } from './eval.tsx'
import { ExecutionSettings } from './execution.tsx'
import { PromptsPage } from './prompts.tsx'
import { usePanel } from './provider.tsx'
import { SETTINGS_GROUPS, settingsRoute, type SettingsGroup } from './route.ts'
import { SettingsProvider } from './settings-kit.tsx'
import { SourceSettings } from './source.tsx'

const SCOPED_GROUPS: readonly SettingsGroup[] = ['source']
const GLOBAL_GROUPS: readonly SettingsGroup[] = ['eval', 'execution', 'prompts', 'deployment']
export function SettingsPage({ group, query, state, deploymentForm }: {
  group: SettingsGroup; query: { source?: string; version?: string }; state: StateView; deploymentForm: DeploymentForm
}) {
  const { t, navigate } = usePanel()
  const content = (() => {
    switch (group) {
      case 'source': return <SettingsProvider><SourceSettings {...query.source ? { focus: query.source } : {}} /></SettingsProvider>
      case 'eval': return <SettingsProvider><EvalSettings version={query.version} source={query.source} /></SettingsProvider>
      case 'execution': return <SettingsProvider><ExecutionSettings /></SettingsProvider>
      case 'prompts': return <PromptsPage />
      case 'deployment': return <DeploymentPage setup={state.setup} form={deploymentForm} />
    }
  })()
  const navLink = (value: SettingsGroup) => <button key={value} type="button" className="dt-settings-link"
    aria-current={value === group ? 'page' : undefined} onClick={() => navigate(settingsRoute(value), true)}>
    {t(`settingsGroup.${value}`)}
  </button>
  return <div className="dt-settings">
    <nav className="dt-settings-nav" aria-label={t('tab.settings')}>
      <div className="dt-settings-section">{t('settingsSection.scoped')}</div>
      {SCOPED_GROUPS.map(navLink)}
      <div className="dt-settings-section">{t('settingsSection.global')}</div>
      {GLOBAL_GROUPS.map(navLink)}
    </nav>
    <div className="dt-settings-body">
      <h2 className="dt-settings-title">{t(`settingsGroup.${group}`)}</h2>
      {content}
    </div>
  </div>
}
