/** Local Reporter protocol, durability, Oracle, reviewer, and deterministic replay contracts. */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { DomainEvent, OutboundMessage, Trigger } from '../src/core/index.ts'
import { createLocalReporter, ReporterError, REPORTER_LIMITS } from '../src/reporter/local-reporter.ts'
import type { ReporterRuntimeSnapshot } from '../src/reporter/protocol.ts'
import { runReporterScript } from '../src/reporter/script.ts'

let directories: string[] = []
afterEach(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); directories = [] })
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'local-reporter-')); directories.push(path); return path }
const project = { id: 'github-0123456789abcdef01234567', provider: 'github' as const, host: 'github.com', project: 'acme/widgets' }
const baseScenario = (overrides: Record<string, unknown> = {}) => ({ id: 'scenario-basic', version: 1, project_source_id: project.id,
  thread_id: '17', thread_kind: 'issue', visible: { persona: 'A maintainer', goal: 'Ask the agent to fix a bug', instructions: [] },
  actors: [{ id: 'alice', role: 'person' }], oracle: { assertions: [{ kind: 'ticket-count', count: 0 }] }, ...overrides })
const envelope = (overrides: Record<string, unknown> = {}) => ({ scenario_id: 'scenario-basic', scenario_version: 1, sequence: 1,
  idempotency_key: 'step-1', simulated_at: '2026-10-01T12:00:00.000Z', actor_id: 'alice', project_source_id: project.id,
  thread_id: '17', action: { kind: 'message', text: 'Please fix this bug.' }, ...overrides })
const snapshot = (tickets: ReporterRuntimeSnapshot['tickets'] = []): ReporterRuntimeSnapshot => ({ triggers: [], decisions: [], tickets })
const expectReporterError = (run: () => unknown, code: string) => {
  let error: unknown
  try { run() } catch (caught) { error = caught }
  expect(error).toMatchObject({ code })
}
function reporter(options: { stateDir?: string; receive?: (trigger: Trigger) => 'stored' | 'duplicate' | 'filtered'; lookup?: (id: string) => 'stored' | 'filtered' | undefined;
  snapshot?: (scenario: string, ids: string[]) => ReporterRuntimeSnapshot; enabled?: boolean } = {}) {
  return createLocalReporter({ stateDir: options.stateDir ?? directory(), enabled: options.enabled ?? true, resolveProject: id => id === project.id ? project : undefined,
    receive: options.receive ?? (() => 'stored'), ...(options.lookup ? { lookup: options.lookup } : {}),
    snapshot: options.snapshot ?? (() => snapshot()) })
}

it('registers a scenario without exposing hidden oracle expectations to its simulator view', () => {
  const service = reporter()
  const simulator = service.registerScenario(baseScenario({ oracle: { assertions: [{ kind: 'ticket-count', count: 9 }, { kind: 'forbid-output', output: 'reply' }] } }))
  expect(simulator).toEqual(expect.objectContaining({ id: 'scenario-basic', visible: expect.any(Object), actors: expect.any(Array) }))
  expect(simulator).not.toHaveProperty('oracle')
  expect(() => service.registerScenario(baseScenario({ id: '../path' }))).toThrow(ReporterError)
  expectReporterError(() => service.registerScenario(baseScenario({ project_source_id: 'github-ffffffffffffffffffffffff' })), 'project_mismatch')
})

it('submits a normal project-scoped Trigger with a scenario-isolated thread and local-only output channel', () => {
  const receive = vi.fn((trigger: Trigger) => { expect(trigger.source).toBe(project.id); return 'stored' as const })
  const service = reporter({ receive })
  service.registerScenario(baseScenario())
  const ack = service.submit(envelope())
  const trigger = receive.mock.calls[0]![0]
  expect(ack).toMatchObject({ disposition: 'stored', duplicate: false, sequence: 1 })
  expect(trigger).toMatchObject({ source: project.id, actor: { source: project.id, id: 'alice' }, human: true,
    threads: [{ source: project.id, id: 'reporter:scenario-basic:17' }], channel: { source: 'local-reporter' },
    meta: { kind: 'issue', number: 17, isPr: false, reporter: { scenarioId: 'scenario-basic', sequence: 1 } } })
  expect(JSON.stringify(trigger.meta)).not.toContain('ticket-count')
  expectReporterError(() => service.submit(envelope({ sequence: 3, idempotency_key: 'step-3' })), 'sequence_out_of_order')
  expect(service.submit(envelope())).toMatchObject({ duplicate: true, disposition: 'stored' })
  expectReporterError(() => service.submit(envelope({ action: { kind: 'message', text: 'different content' } })), 'idempotency_conflict')
  expect(receive).toHaveBeenCalledOnce()
})

it('uses write-ahead input reservations to recover a crash after Runtime accepted a Trigger', () => {
  const stateDir = directory(), received = new Map<string, Trigger>()
  let first = true, receiveCalls = 0
  const make = () => reporter({ stateDir, receive: trigger => {
    receiveCalls++
    received.set(trigger.id, trigger)
    if (first) { first = false; throw new Error('simulated crash after commit') }
    return 'stored'
  }, lookup: id => received.has(id) ? 'stored' : undefined })
  const firstReporter = make()
  firstReporter.registerScenario(baseScenario())
  expectReporterError(() => firstReporter.submit(envelope()), 'receive_failed')
  const nextReporter = make()
  expect(nextReporter.submit(envelope())).toMatchObject({ disposition: 'stored', duplicate: false })
  expect(receiveCalls).toBe(1)
  expect(nextReporter.scenario('scenario-basic')?.inputs).toHaveLength(1)
})

it('captures a local output idempotently and never accepts another channel as a local result', () => {
  const service = reporter()
  service.registerScenario(baseScenario())
  const ack = service.submit(envelope())
  const address = { scenario_id: 'scenario-basic', scenario_version: '1', sequence: '1', trigger_id: ack.trigger_id,
    project_source_id: project.id, thread_id: '17' }
  const output: OutboundMessage = { id: 'reply-1', channel: { source: 'local-reporter', thread: 'scenario:scenario-basic:17', address }, text: 'I will investigate.', kind: 'acknowledgement' }
  expect(service.capture(output)).toBe(true)
  expect(service.capture(output)).toBe(true)
  expect(service.capture({ ...output, id: 'bogus', channel: { ...output.channel, address: { ...address, trigger_id: 'unknown' } } })).toBe(false)
  expect(service.capture({ ...output, channel: { ...output.channel, source: project.id } })).toBe(false)
  expect(service.scenario('scenario-basic')?.outputs).toHaveLength(1)
})

it('fails closed when the structured Runtime snapshot is unavailable', () => {
  const service = reporter({ snapshot: () => { throw new Error('database unavailable') } })
  service.registerScenario(baseScenario({ oracle: { assertions: [{ kind: 'ticket-count', count: 0 }] } }))
  service.submit(envelope())
  const completed = service.completeScenario('scenario-basic')
  expect(completed).toMatchObject({ snapshot_available: false, behavioral_pass: false, oracle: { passed: false, snapshot_available: false } })
  expect(completed.oracle.checks[0]).toMatchObject({ passed: false, actual: { unavailable: 'snapshot_unavailable' } })
})

it('persists events and can deterministically replay and export them after a restart', () => {
  const stateDir = directory()
  const first = reporter({ stateDir })
  first.registerScenario(baseScenario())
  first.submit(envelope())
  first.completeScenario('scenario-basic')
  const expected = first.replayScenario('scenario-basic')
  const restarted = reporter({ stateDir, receive: vi.fn(() => 'stored' as const) })
  expect(restarted.submit(envelope())).toMatchObject({ duplicate: true, disposition: 'stored' })
  expect(restarted.replayScenario('scenario-basic')).toEqual(expected)
  const exported = restarted.exportScenario('scenario-basic')!
  expect(exported.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(exported.records.at(-1)).toMatchObject({ type: 'scenario.completed' })
  expect(JSON.parse(readFileSync(join(stateDir, 'reporter', readdirSync(join(stateDir, 'reporter'))[0]!), 'utf8').trim().split('\n')[0]!))
    .toMatchObject({ type: 'scenario.registered' })
})

it('records domain events only for the registered reporter thread and actor data', () => {
  const service = reporter()
  service.registerScenario(baseScenario())
  const trigger = service.submit(envelope())
  const relevant: DomainEvent = { type: 'trigger.received', at: '2026-10-01T12:00:00.000Z', data: { triggerId: trigger.trigger_id, threads: [`${project.id}:reporter:scenario-basic:17`] } }
  const unrelated: DomainEvent = { type: 'trigger.received', at: '2026-10-01T12:00:01.000Z', data: { triggerId: 'other', threads: [`${project.id}:reporter:other:17`] } }
  service.observe(relevant); service.observe(unrelated)
  expect(service.scenario('scenario-basic')?.domain_events).toEqual([relevant])
})

it('rejects scenarios without deterministic assertions and exposes explicit storage caps', () => {
  const service = reporter()
  expect(() => service.registerScenario({ ...baseScenario(), oracle: { assertions: [] } })).toThrow(ReporterError)
  expect(REPORTER_LIMITS).toMatchObject({ scenarios: 100, eventsPerScenario: 10_000, outputTextChars: 20_000, totalBytes: 134_217_728 })
})

it('runs a multi-actor, time-ordered script with reviews, CI, stops, duplicate delivery, and expected out-of-order rejection', () => {
  const service = reporter()
  const definition = baseScenario({ thread_kind: 'pull', actors: [{ id: 'alice', role: 'person' }, { id: 'renovate[bot]', role: 'bot' }, { id: 'ci', role: 'ci' }] })
  service.registerScenario(definition)
  const visible = service.simulatorScenario('scenario-basic')!
  const result = runReporterScript({ reporter: service, scenario: visible, simulatedStart: '2026-10-01T12:00:00.000Z', steps: [
    { actor_id: 'alice', action: { kind: 'message', text: 'Please fix this regression.', addressed: 'mention' }, repeat: 2 },
    { actor_id: 'renovate[bot]', action: { kind: 'review', state: 'changes_requested', body: 'The validation is missing.' }, after_ms: 1_000 },
    { actor_id: 'alice', action: { kind: 'approval', state: 'approved', body: '验证后同意合并。' } },
    { actor_id: 'ci', action: { kind: 'ci', name: 'unit-tests', state: 'failure', summary: 'One test failed.' }, after_ms: 4_000 },
    { actor_id: 'alice', action: { kind: 'stop', text: 'Please stop the work.' }, sequence: 9, expect_error: 'sequence_out_of_order' },
    { actor_id: 'alice', action: { kind: 'stop', text: 'Please stop the work.' }, after_ms: 2_000 },
  ] })
  expect(result).toMatchObject({ accepted: 5, duplicate_responses: 1, rejected: 1,
    errors: [{ step: 5, code: 'sequence_out_of_order' }] })
  expect(service.scenario('scenario-basic')?.inputs.map(item => item.trigger)).toEqual(expect.arrayContaining([
    expect.objectContaining({ human: false, meta: expect.objectContaining({ kind: 'review', isPr: true }) }),
    expect.objectContaining({ human: false, meta: expect.objectContaining({ ci: true }) }),
  ]))
})
