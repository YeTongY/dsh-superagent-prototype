import { expect, it } from 'vitest'
import { z } from 'zod'
import { registerHttp } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'
import { ReporterAutonomousRunError } from '../src/reporter/autonomous.ts'

it('exposes only a read-only Reporter management projection and protects autonomous run operations', async () => {
  const token = 'reporter-test-capability-with-32-characters'
  const view = { id: 'auto-1', status: 'running', phase: '发现可测试行为' }
  const calls: unknown[] = []
  const call = serve({ reporter: { token, client: { registerScenario: () => ({ registered: true }), submit: () => ({ stored: true }) } },
    reporterRuns: {
      start: async (input: unknown) => { calls.push(['start', input]); return view },
      list: () => [view], get: (id: string) => id === 'auto-1' ? view : undefined,
      cancel: (id: string) => { calls.push(['cancel', id]); if (id !== 'auto-1') throw new ReporterAutonomousRunError(404, 'run_not_found', 'Reporter 运行不存在'); return view },
    } })
  expect(await call('GET', 'reporter')).toEqual({ status: 200, body: { enabled: true, runs: [view] } })
  expect(await call('POST', '../reporter/runs', { idempotency_key: 'one' })).toMatchObject({ status: 401 })
  expect(await call('GET', '../reporter/runs', undefined, { authorization: `Bearer ${token}`, origin: 'http://evil.example' })).toMatchObject({ status: 403 })
  expect(await call('POST', '../reporter/runs', { idempotency_key: 'one' }, { authorization: `Bearer ${token}` }))
    .toEqual({ status: 202, body: view })
  expect(await call('GET', '../reporter/runs', undefined, { authorization: `Bearer ${token}` }))
    .toEqual({ status: 200, body: [view] })
  expect(await call('GET', '../reporter/runs/auto-1', undefined, { authorization: `Bearer ${token}` }))
    .toEqual({ status: 200, body: view })
  expect(await call('POST', '../reporter/runs/auto-1/cancel', undefined, { authorization: `Bearer ${token}` }))
    .toEqual({ status: 200, body: view })
  expect(await call('GET', '../reporter/runs/missing', undefined, { authorization: `Bearer ${token}` }))
    .toEqual({ status: 404, body: { error: 'Reporter run not found' } })
  expect(await call('POST', '../reporter/runs/missing/cancel', undefined, { authorization: `Bearer ${token}` }))
    .toEqual({ status: 404, body: { error: 'Reporter 运行不存在', code: 'run_not_found' } })
  expect(calls).toEqual([['start', { idempotency_key: 'one' }], ['cancel', 'auto-1'], ['cancel', 'missing']])
})

it('reports Reporter as disabled without exposing run data when autonomous runs are unavailable', async () => {
  expect(await serve({})('GET', 'reporter')).toEqual({ status: 200, body: { enabled: false, runs: [] } })
})

it('requires both the local request boundary and Reporter capability before accepting a scenario or event', async () => {
  const calls: unknown[] = []
  const token = 'reporter-test-capability-with-32-characters'
  const call = serve({ reporter: { token, client: {
    submit: (input: unknown) => { calls.push(input); return { stored: true } },
    registerScenario: (input: unknown) => { calls.push(input); return { registered: true } },
    scenario: () => undefined, exportScenario: () => ({ events: [] }),
  } } })
  expect(await call('POST', '../reporter/events', {})).toMatchObject({ status: 401, body: { code: 'unauthorized' } })
  expect(await call('POST', '../reporter/events', {}, { authorization: 'Bearer incorrect' })).toMatchObject({ status: 401 })
  expect(await call('POST', '../reporter/events', {}, { authorization: `Bearer ${token}`, origin: 'http://evil.example' })).toMatchObject({ status: 403 })
  expect(calls).toEqual([])
  expect(await call('POST', '../reporter/events', { sequence: 1 }, { authorization: `Bearer ${token}` })).toMatchObject({ status: 200 })
  expect(calls).toEqual([{ sequence: 1 }])
  expect(await call('GET', '../reporter/scenarios/missing', undefined, { authorization: `Bearer ${token}` })).toMatchObject({ status: 404 })
  expect(await call('POST', '../reporter/events', { text: 'x'.repeat(65_536) }, { authorization: `Bearer ${token}` })).toMatchObject({ status: 400 })
  expect(calls).toHaveLength(1)
  const disabled = serve({})
  expect(await disabled('POST', '../reporter/events', {})).toMatchObject({ status: 404 })
})

it('passes project creation through the validated management service', async () => {
  const calls: unknown[] = []
  const call = serve({ settings: { createProject: async (...args: unknown[]) => {
    calls.push(args); return { id: 'gitlab-project', revision: 1, restarting: true }
  } } })
  expect(await call('POST', 'projects', { provider: 'gitlab', config: { host: 'gitlab.internal', repository: 'group/app' } })).toMatchObject({ status: 200 })
  expect(calls).toEqual([['gitlab', { host: 'gitlab.internal', repository: 'group/app' }, true]])
  expect(await call('POST', 'projects', { provider: 'other', config: {} })).toMatchObject({ status: 400 })
  expect(calls).toHaveLength(1)
})

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})
