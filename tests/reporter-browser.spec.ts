import { describe, expect, it } from 'vitest'
import { ReporterBrowserActionSchema, ReporterBrowserError, reporterBrowserOrigin, reporterBrowserPath,
  reporterBrowserRequestAllowed } from '../src/reporter/browser.ts'

const origin = 'http://127.0.0.1:3082'
const rpc = (method: string, args?: unknown) => ({ type: 'client-request', method, rpcId: 'test-id', payload: args === undefined ? {} : { args } })

describe('Reporter browser boundary', () => {
  it('accepts only typed UI actions without selectors, scripts, or URLs', () => {
    expect(ReporterBrowserActionSchema.safeParse({ kind: 'snapshot' }).success).toBe(true)
    expect(ReporterBrowserActionSchema.safeParse({ kind: 'click', role: 'tab', name: '来源' }).success).toBe(true)
    expect(ReporterBrowserActionSchema.safeParse({ kind: 'click', role: 'link', name: '外链' }).success).toBe(false)
    expect(ReporterBrowserActionSchema.safeParse({ kind: 'click', role: 'button', name: '提交', selector: 'body' }).success).toBe(false)
    expect(ReporterBrowserActionSchema.safeParse({ kind: 'navigate', url: 'https://example.com' }).success).toBe(false)
    expect(ReporterBrowserActionSchema.safeParse({ kind: 'fill', role: 'textbox', name: '查询', value: 'x'.repeat(2_001) }).success).toBe(false)
  })

  it('requires a concrete loopback origin and returns only the clean page path', () => {
    expect(reporterBrowserOrigin(origin)).toBe(origin)
    expect(reporterBrowserOrigin('https://localhost:3082')).toBe('https://localhost:3082')
    expect(reporterBrowserOrigin('http://[::1]:3082')).toBe('http://[::1]:3082')
    expect(() => reporterBrowserOrigin('https://example.com')).toThrowError(ReporterBrowserError)
    expect(() => reporterBrowserOrigin('http://127.0.0.1:3082/admin')).toThrowError(ReporterBrowserError)
    expect(reporterBrowserPath(`${origin}/?token=private#secret`, origin)).toBe('/')
    expect(() => reporterBrowserPath('https://example.com/?token=private', origin)).toThrow('browser_origin_changed')
  })

  it('blocks external, write, Reporter-capability, and unknown DSH RPC traffic', () => {
    expect(reporterBrowserRequestAllowed({ url: `${origin}/assets/client.js`, method: 'GET', resourceType: 'script' }, origin)).toBe(true)
    expect(reporterBrowserRequestAllowed({ url: `${origin}/orchestrator/api/overview`, method: 'GET', resourceType: 'fetch' }, origin)).toBe(true)
    expect(reporterBrowserRequestAllowed({ url: 'https://example.com/', method: 'GET', resourceType: 'document' }, origin)).toBe(false)
    expect(reporterBrowserRequestAllowed({ url: `${origin}/outside`, method: 'GET', resourceType: 'document' }, origin)).toBe(false)
    expect(reporterBrowserRequestAllowed({ url: `${origin}/orchestrator/api/settings`, method: 'POST', resourceType: 'fetch' }, origin)).toBe(false)
    expect(reporterBrowserRequestAllowed({ url: `${origin}/orchestrator/reporter/runs`, method: 'GET', resourceType: 'fetch' }, origin)).toBe(false)
    expect(reporterBrowserRequestAllowed({ url: `${origin}/api/session/prompt`, method: 'POST', resourceType: 'fetch',
      body: rpc('session/prompt') }, origin)).toBe(false)
    expect(reporterBrowserRequestAllowed({ url: `${origin}/api/session/list`, method: 'POST', resourceType: 'fetch',
      body: rpc('session/list') }, origin)).toBe(true)
    expect(reporterBrowserRequestAllowed({ url: `${origin}/api/session/list`, method: 'POST', resourceType: 'fetch',
      body: rpc('session/prompt') }, origin)).toBe(false)
  })

  it('allows only the exact DSH preview acknowledgement needed to open a new browser context', () => {
    const exact = rpc('settings/mutate', { ns: 'ui-settings-general', expectedRevision: 0,
      ops: [{ op: 'set', path: ['welcomeNoticeVersion'], value: '2026-09-28.1' }] })
    expect(reporterBrowserRequestAllowed({ url: `${origin}/api/settings/mutate`, method: 'POST', resourceType: 'fetch', body: exact }, origin)).toBe(true)
    const wrongValue = rpc('settings/mutate', { ns: 'ui-settings-general', expectedRevision: 0,
      ops: [{ op: 'set', path: ['welcomeNoticeVersion'], value: 'other' }] })
    expect(reporterBrowserRequestAllowed({ url: `${origin}/api/settings/mutate`, method: 'POST', resourceType: 'fetch', body: wrongValue }, origin)).toBe(false)
    const secondField = rpc('settings/mutate', { ns: 'ui-settings-general', expectedRevision: 0,
      ops: [{ op: 'set', path: ['welcomeNoticeVersion'], value: '2026-09-28.1' }, { op: 'set', path: ['other'], value: true }] })
    expect(reporterBrowserRequestAllowed({ url: `${origin}/api/settings/mutate`, method: 'POST', resourceType: 'fetch', body: secondField }, origin)).toBe(false)
  })
})
