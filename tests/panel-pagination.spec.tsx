// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { all, at, click, mount, settle, usePanel } from './fixtures/panel.tsx'
import { acceptDecision, server, threadSummary, ticketSummary } from './fixtures/panel-server.ts'

usePanel()

const names = (prefix: string, count: number) => Array.from({ length: count }, (_, n) => `${prefix}-${n}`)
const shown = () => all('#dt-page .dt-list .dt-open').map(row => row.textContent)
const more = () => all('#dt-page button').find(button => button.textContent === zh.loadMore)
const requests = (path: string, from = 0) => server.requests.slice(from).filter(request => request.path.startsWith(`${path}?`))
  .map(request => new URL(request.path, 'http://panel.test').searchParams)
const decisions = (titles: string[]) => { server.decisions = titles.map(id => ({ ...acceptDecision(), id, preview: id })) }
const threads = (titles: string[]) => { server.threads = titles.map(key => threadSummary({ key, title: key, tickets: [], facts: {} })) }
const tickets = (titles: string[]) => { server.tickets.open = titles.map(id => ticketSummary({ id, title: id, threads: [] })) }

function clock() {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
}
async function poll() {
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  await settle()
}
function expectRows(expected: string[]) {
  const actual = shown()
  expect(actual).toEqual(expected)
  expect(new Set(actual).size).toBe(expected.length)
}

const lists = [
  { page: 'eval', path: 'decisions', step: 30, cap: 200, count: 401, setRows: decisions, setFiltered: decisions,
    filter: zh['decisionFilter.unavailable'], initial: { kind: 'accept,reopen', window: '24h' },
    filtered: { kind: 'unavailable', window: '24h' } },
  { page: 'trigger', path: 'threads', step: 20, cap: 1000, count: 1001, setRows: threads, setFiltered: threads,
    filter: zh['threadFilter.evaluating'], initial: { filter: 'subscribed' }, filtered: { filter: 'evaluating' } },
  { page: 'execution', path: 'tickets', step: 20, cap: 1000, count: 1001, setRows: tickets,
    setFiltered: (titles: string[]) => { server.tickets.ended = titles.map(id => ticketSummary({ id, title: id, state: 'ended',
      threads: [] }, { stage: 'ended' })) },
    filter: zh['ticket.ended'], initial: { state: 'open' }, filtered: { state: 'ended' } },
] as const

// 对照 HTTP 的 200/1000 上限，检查真实列表而非 mock 掉 loadList。
for (const list of lists) it(`${list.page} loads past the server cap, rebuilds on polls, and resets pagination with its filter`, async () => {
  clock()
  const original = names(list.path, list.count)
  list.setRows(original)
  at({ page: list.page, ...list.page === 'eval' ? { query: { window: '24h' } } : {} })
  await mount()
  expectRows(original.slice(0, list.step))
  for (let visible = list.step; visible < original.length; visible += list.step) {
    expect(more()).toBeDefined()
    await click(more()!)
    expect(shown()).toHaveLength(Math.min(visible + list.step, original.length))
  }
  expectRows(original)
  expect(shown().at(-1)).toBe(original.at(-1))
  expect(more()).toBeUndefined()
  const initial = requests(list.path)
  expect(initial.some(query => query.get('offset') === String(list.cap))).toBe(true)
  if (list.page === 'eval') expect(initial.some(query => query.get('offset') === '400')).toBe(true)
  for (const query of initial) for (const [key, value] of Object.entries(list.initial)) expect(query.get(key)).toBe(value)

  // 新记录进入头部、旧记录跨页删除后，每次轮询都重建同一个完整前缀。
  const inserted = [`${list.path}-inserted`, ...original]
  list.setRows(inserted)
  await poll()
  expectRows(inserted)
  const removed = inserted.filter(id => id !== original[0] && id !== original[list.cap - 1])
  list.setRows(removed)
  await poll()
  expectRows(removed)
  expect(more()).toBeUndefined()

  const filtered = names(`${list.path}-filtered`, list.step + 1)
  list.setFiltered(filtered)
  const beforeFilter = server.requests.length
  await click(list.filter)
  expectRows(filtered.slice(0, list.step))
  expect(more()).toBeDefined()
  const changed = requests(list.path, beforeFilter)
  expect(changed[0]!.get('limit')).toBe(String(list.step))
  expect(changed[0]!.has('offset')).toBe(false)
  await click(more()!)
  expectRows(filtered)
  expect(more()).toBeUndefined()
  for (const query of requests(list.path, beforeFilter)) {
    for (const [key, value] of Object.entries(list.filtered)) expect(query.get(key)).toBe(value)
  }
  if (list.page === 'eval') {
    const beforeWindow = server.requests.length
    await click(zh.lastDayOnly)
    expectRows(filtered)
    const query = requests(list.path, beforeWindow).at(-1)!
    expect(query.get('kind')).toBe('unavailable')
    expect(query.has('window')).toBe(false)
  }
}, 60_000)

it('keeps the last complete visible prefix when a later page fails and recovers on the next poll', async () => {
  clock()
  const original = names('decision', 401)
  decisions(original)
  at({ page: 'eval', query: { window: '24h' } })
  await mount()
  for (let visible = 30; visible < 390; visible += 30) await click(more()!)
  expectRows(original.slice(0, 390))

  const fetchPage = globalThis.fetch
  let fail = true
  const failed: URLSearchParams[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const address = new URL(String(input), 'http://panel.test')
    const response = await fetchPage(input, init)
    if (fail && address.pathname.endsWith('/decisions') && address.searchParams.get('offset') === '400') {
      // 消费原始夹具响应，保持 pending 计数准确，再替换为后续页的失败。
      await response.text()
      failed.push(address.searchParams)
      return new Response(JSON.stringify({ error: 'Later page unavailable' }), { status: 500 })
    }
    return response
  }))
  await click(more()!)
  expect(failed).toHaveLength(1)
  expect(failed[0]!.get('kind')).toBe('accept,reopen')
  expect(failed[0]!.get('window')).toBe('24h')
  expect(failed[0]!.get('limit')).toBe('20')
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Later page unavailable')
  expectRows(original.slice(0, 390))
  expect(more()).toBeDefined()

  const updated = ['decision-inserted', ...original.filter(id => id !== original[199])]
  decisions(updated)
  fail = false
  await poll()
  expectRows(updated)
  expect(document.querySelector('[role="alert"]')).toBeNull()
  expect(more()).toBeUndefined()
  expect(requests('decisions').slice(-3).map(query => [query.get('offset'), query.get('limit')]))
    .toEqual([[null, '420'], ['200', '220'], ['400', '20']])
}, 30_000)
