import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { decisionMark, reportDot, sourceMark, threadMark, ticketMark } from '../src/client/marks.ts'
import { translator } from './fixtures/panel.tsx'

const t = translator(zh)

it('marks each Ticket stage by whom it waits for, and an ended Ticket by its outcome', () => {
  const marks = [{ stage: 'person', action: 'answer' }, { stage: 'person', action: 'review' }, { stage: 'person', action: 'blocked' },
    { stage: 'person', action: 'failed' }, { stage: 'person', action: 'delivery' }, { stage: 'working', action: 'queued' },
    { stage: 'working' }, { stage: 'idle' }] as const
  expect(marks.map(stage => { const { label, tone, dot, icon } = ticketMark(t, { ...stage, ended: undefined }); return [label, tone, dot,
    icon] })).toEqual([
    [zh['stage.answer'], 'warning', 'warning', 'ask'], [zh['stage.review'], 'warning', 'warning', 'review'], [zh['stage.blocked'], 'warning', 'warning', 'blocked'],
    [zh['stage.failed'], 'danger', 'error', 'alert'], [zh['stage.delivery'], 'warning', 'warning', 'inbox'], [zh['stage.queued'], 'neutral', 'idle', 'queue'],
    [zh['stage.working'], 'info', 'ongoing', 'running'], [zh['stage.idle'], 'neutral', 'idle', 'clock']])
  const ended = (['completed', 'merged', 'closed', 'dropped', 'stopped'] as const).map(outcome => ticketMark(t, { stage: 'ended',
    ended: { at: '', by: outcome === 'stopped' ? 'human' : 'executor', outcome } }))
  expect(ended.map(mark => mark.label)).toEqual([zh['outcome.completed'], zh['outcome.merged'], zh['outcome.closed'], zh['outcome.dropped'], zh['outcome.stopped']])
  expect(new Set(ended.map(({ tone, dot, icon }) => `${tone} ${dot} ${icon}`))).toEqual(new Set(['neutral idle stop']))
  expect(['failed', 'blocked', 'waiting', 'ready', 'progress', undefined].map(reportDot)).toEqual(['error', 'warning', 'warning', 'done',
    'ongoing', 'ongoing'])
})

it('marks each Thread stage, Source state and Decision outcome', () => {
  const threads = (['error', 'evaluating', 'queued', 'subscribed', 'dormant', 'unsubscribed'] as const).map(stage => threadMark(t,
    { stage, pending: 2 }))
  expect(threads.map(({ label, dot, icon }) => [label, dot, icon])).toEqual([[zh.threadPollFailed, 'error', 'alert'], [zh.threadEvaluating, 'ongoing', 'running'],
    ['排队 2', 'warning', 'queue'], [zh.threadSubscribed, 'done', 'inbox'], [zh.threadDormantShort, 'idle', 'clock'], [zh.threadUnsubscribed, 'idle', 'hash']])
  const sources = (['missing', 'off', 'error', 'setup', 'starting', 'paused', 'ready'] as const).map(state => sourceMark(t, state))
  expect(sources.map(({ label, dot }) => [label, dot])).toEqual([[zh.sourceNotInstalled, 'idle'], [zh.sourceOff, 'idle'], [zh['sourceState.error'], 'error'],
    [zh['sourceState.setup'], 'idle'], [zh['sourceState.ongoing'], 'ongoing'], [zh['sourceState.warning'], 'warning'], [zh['sourceState.done'], 'done']])
  const decisions = (['accept', 'reopen', 'stop', 'ignore', 'unavailable', 'wouldAccept'] as const).map(outcome => decisionMark(t, outcome))
  expect(decisions.map(({ label, tone, dot, icon }) => [label, tone, dot, icon])).toEqual([[zh['decision.accept'], 'success', 'done', 'decision'],
    [zh['decision.reopen'], 'success', 'done', 'refresh'], [zh['decision.stop'], 'danger', 'idle', 'stop'], [zh['decision.ignore'], 'neutral', 'idle', 'dismiss'],
    [zh['decision.unavailable'], 'warning', 'warning', 'alert'], [zh.wouldAccept, 'warning', 'idle', 'dismiss']])
})
