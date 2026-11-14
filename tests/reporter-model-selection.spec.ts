import { describe, expect, it } from 'vitest'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { selectReporterModel } from '../src/app/sessions.ts'

function catalog(reasoningEfforts: string[] | undefined, defaults: { effort?: string; selected?: string } = {}): Pick<ModelCatalog, 'default' | 'groups'> {
  return {
    default: { provider: 'codex-custom', model: 'gpt-6.1-sol', ...(defaults.selected ? { reasoningEffort: defaults.selected } : {}) },
    groups: [{ id: 'codex-custom', name: 'Codex', models: [{ id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol', ...(reasoningEfforts ? {
      reasoning: { efforts: reasoningEfforts.map(id => ({ id, name: id })), ...(defaults.effort ? { defaultEffort: defaults.effort } : {}) },
    } : {}) }] }],
  }
}

describe('Reporter DSH model selection', () => {
  it('uses xhigh when the exact DSH route advertises it', () => {
    expect(selectReporterModel(catalog(['low', 'medium', 'high', 'xhigh'], { selected: 'high' })))
      .toEqual({ provider: 'codex-custom', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' })
  })

  it('keeps the DSH-selected effort when xhigh is unavailable', () => {
    expect(selectReporterModel(catalog(['low', 'medium', 'high'], { selected: 'high' })))
      .toEqual({ provider: 'codex-custom', model: 'gpt-6.1-sol', reasoningEffort: 'high' })
  })

  it('falls back to the route-advertised default when the selected effort is unsupported', () => {
    expect(selectReporterModel(catalog(['low', 'medium', 'high'], { effort: 'medium', selected: 'xhigh' })))
      .toEqual({ provider: 'codex-custom', model: 'gpt-6.1-sol', reasoningEffort: 'medium' })
  })

  it('leaves effort unset when DSH publishes no reasoning capability', () => {
    expect(selectReporterModel(catalog(undefined))).toEqual({ provider: 'codex-custom', model: 'gpt-6.1-sol' })
  })

  it('does not reuse an unverified selected effort when the exact model has no reasoning metadata', () => {
    expect(selectReporterModel(catalog(undefined, { selected: 'xhigh' })))
      .toEqual({ provider: 'codex-custom', model: 'gpt-6.1-sol' })
  })
})
