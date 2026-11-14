/** 仅供本地 Reporter 使用的、受限的管理页浏览器通道。 */
import type { Browser, BrowserContext, Locator, Page } from 'playwright'
import { z } from 'zod'

const fieldRole = z.enum(['textbox', 'searchbox', 'combobox'])
const pressKey = z.enum(['Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'Space'])
const name = z.string().trim().min(1).max(160)

/** 模型只能选择控件语义，不能提供 URL、CSS/XPath 或脚本。 */
export const ReporterBrowserActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('snapshot') }).strict(),
  z.object({ kind: z.literal('click'), role: z.enum(['button', 'tab']), name }).strict(),
  z.object({ kind: z.literal('fill'), role: fieldRole, name, value: z.string().max(2_000) }).strict(),
  z.object({ kind: z.literal('press'), role: fieldRole, name, key: pressKey }).strict(),
  z.object({ kind: z.literal('back') }).strict(),
])
export type ReporterBrowserAction = z.infer<typeof ReporterBrowserActionSchema>

export interface ReporterBrowserObservation {
  /** 只有路径会交给模型；query、hash、cookie 和完整 origin 不会进入观察结果。 */
  path: string
  title: string
  accessibility_snapshot: string
  snapshot_truncated: boolean
  page_errors: number
  /** 被安全边界拦截的唯一路径摘要，不含 host、query、body、header。 */
  blocked_requests: { method: string; pathname: string }[]
  /** 排除浏览器自身报告的 ERR_BLOCKED_BY_CLIENT 后的控制台错误数。 */
  console_errors: number
  blocked_console_errors: number
}

export interface ReporterBrowserDriver {
  observe(signal: AbortSignal): Promise<ReporterBrowserObservation>
  act(action: ReporterBrowserAction, signal: AbortSignal): Promise<{ result: 'completed'; observation: ReporterBrowserObservation }>
  close(): Promise<void>
}

/** 将管理页浏览器的安全边界和操作失败转换为稳定错误代码。 */
export class ReporterBrowserError extends Error {
  constructor(readonly code: 'browser_unavailable' | 'browser_auth_url_invalid' | 'browser_navigation_failed'
    | 'browser_panel_not_found' | 'browser_observation_failed' | 'browser_action_invalid' | 'browser_action_not_unique'
    | 'browser_action_failed' | 'browser_origin_changed') {
    super(code)
    this.name = 'ReporterBrowserError'
  }
}

const MAX_SNAPSHOT_CHARS = 12_000
const ACTION_TIMEOUT_MS = 5_000
const NAVIGATION_TIMEOUT_MS = 20_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const READ_ONLY_RPC_ENDPOINTS = new Set([
  'session/list', 'session/page', 'session/modelCatalog', 'settings/describe', 'credentials/describe',
  'llm/listProviders', 'llm/listConfigurableProviders',
])

export interface ReporterBrowserRequestFacts {
  url: string
  method: string
  resourceType: string
  body?: unknown
}

function isKnownPreviewAcknowledgement(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  const message = body as { type?: unknown; method?: unknown; payload?: { args?: { ns?: unknown; ops?: unknown; expectedRevision?: unknown } } }
  const args = message.payload?.args
  if (message.type !== 'client-request' || message.method !== 'settings/mutate' || args?.ns !== 'ui-settings-general' || !Array.isArray(args.ops)
    || args.ops.length !== 1 || (args.expectedRevision !== undefined
      && (!Number.isSafeInteger(args.expectedRevision) || (args.expectedRevision as number) < 0))) return false
  const [operation] = args.ops as { op?: unknown; path?: unknown; value?: unknown }[]
  return operation?.op === 'set' && Array.isArray(operation.path) && operation.path.length === 1
    && operation.path[0] === 'welcomeNoticeVersion' && operation.value === '2026-09-28.1'
}

/**
 * DSH 页面会用 POST 执行只读 RPC。仅允许已核验的只读接口和一次性预览说明确认；
 * 应用设置写入、Reporter 路由、外部请求及未知 RPC 均会被拦截。
 */
export function reporterBrowserRequestAllowed(facts: ReporterBrowserRequestFacts, expectedOrigin: string): boolean {
  let url: URL
  try { url = new URL(facts.url) } catch { return false }
  if (url.origin !== expectedOrigin || url.pathname.startsWith('/orchestrator/reporter/')) return false
  const method = facts.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD') {
    if (url.pathname.startsWith('/api/')) return false
    if (facts.resourceType === 'document' && url.pathname !== '/') return false
    return true
  }
  if (method !== 'POST' || !url.pathname.startsWith('/api/')) return false
  const endpoint = url.pathname.slice('/api/'.length)
  if (READ_ONLY_RPC_ENDPOINTS.has(endpoint)) {
    if (typeof facts.body !== 'object' || facts.body === null || (facts.body as { method?: unknown }).method !== endpoint) return false
    return true
  }
  return endpoint === 'settings/mutate' && isKnownPreviewAcknowledgement(facts.body)
}

/** 将认证参数和片段从模型可见的页面路径中移除。 */
export function reporterBrowserPath(input: string, expectedOrigin: string): string {
  try {
    const url = new URL(input)
    if (url.origin !== expectedOrigin) throw new ReporterBrowserError('browser_origin_changed')
    return url.pathname
  } catch (error) {
    if (error instanceof ReporterBrowserError) throw error
    throw new ReporterBrowserError('browser_observation_failed')
  }
}

/** 只接受具体本机 HTTP(S) origin，拒绝 userinfo、path、query 和远端主机。 */
export function reporterBrowserOrigin(input: string): string {
  let parsed: URL
  try { parsed = new URL(input) } catch { throw new ReporterBrowserError('browser_auth_url_invalid') }
  if (!['http:', 'https:'].includes(parsed.protocol) || !LOOPBACK_HOSTS.has(parsed.hostname)
    || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new ReporterBrowserError('browser_auth_url_invalid')
  }
  return parsed.origin
}

function checkedAuthUrl(input: string, expectedOrigin: string): string {
  let parsed: URL
  try { parsed = new URL(input) } catch { throw new ReporterBrowserError('browser_auth_url_invalid') }
  if (parsed.origin !== expectedOrigin || parsed.pathname !== '/' || parsed.username || parsed.password) {
    throw new ReporterBrowserError('browser_auth_url_invalid')
  }
  // 此 URL 含 DSH 短时登录令牌，仅传给 goto，不能写入错误、观察、模型输入或 Reporter 事件。
  return parsed.toString()
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
}

async function withSignal<T>(promise: Promise<T>, signal: AbortSignal, abort: () => Promise<void>): Promise<T> {
  throwIfAborted(signal)
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      void abort().finally(() => reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([promise, aborted]) }
  finally { if (onAbort) signal.removeEventListener('abort', onAbort) }
}

async function uniqueVisible(locator: Locator): Promise<Locator> {
  if (await locator.count() !== 1 || !await locator.isVisible() || !await locator.isEnabled()) {
    throw new ReporterBrowserError('browser_action_not_unique')
  }
  return locator
}

function locatorFor(page: Page, action: Exclude<ReporterBrowserAction, { kind: 'snapshot' | 'back' }>): Locator {
  if (action.kind === 'click' && action.role === 'tab') {
    return page.locator('.dt-tabs').getByRole('tab', { name: action.name, exact: true })
  }
  if (action.kind === 'click') {
    return page.locator('.dt-page .dt-search, #dt-page').getByRole('button', { name: action.name, exact: true })
  }
  if (action.role === 'searchbox') {
    return page.locator('.dt-page .dt-search, #dt-page').getByRole(action.role, { name: action.name, exact: true })
  }
  const root = page.locator('#dt-page')
  return root.getByRole(action.role, { name: action.name, exact: true })
}

/**
 * 启动隔离的 Chromium context。测试可以注入 launchBrowser；生产环境动态加载
 * Playwright，因此默认未安装浏览器的镜像仍可运行其他 Reporter 模式。
 */
export async function createReporterBrowserDriver(options: {
  expectedOrigin: string
  getAuthenticatedUrl: () => string
  signal?: AbortSignal
  launchBrowser?: () => Promise<Browser>
}): Promise<ReporterBrowserDriver> {
  const expectedOrigin = reporterBrowserOrigin(options.expectedOrigin)
  const signal = options.signal ?? new AbortController().signal
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let page: Page | undefined
  let closed = false
  let pageErrors = 0, consoleErrors = 0, blockedConsoleErrors = 0
  const blockedRequests: ReporterBrowserObservation['blocked_requests'] = []
  const blockedRequestKeys = new Set<string>()
  const recordBlockedRequest = (request: { url(): string; method(): string }) => {
    let pathname = '/[invalid-url]'
    try {
      const url = new URL(request.url())
      pathname = url.origin === expectedOrigin ? url.pathname : '/[external-origin]'
    } catch { /* 格式无效的请求只保留稳定且不含敏感信息的标记。 */ }
    const method = request.method().slice(0, 16).toUpperCase()
    const key = `${method} ${pathname}`
    if (!blockedRequestKeys.has(key) && blockedRequests.length < 20) {
      blockedRequestKeys.add(key)
      blockedRequests.push({ method, pathname })
    }
  }
  const close = async () => {
    if (closed) return
    closed = true
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
  }
  try {
    throwIfAborted(signal)
    if (options.launchBrowser) {
      const launching = options.launchBrowser()
      browser = await withSignal(launching, signal, async () => {
        void launching.then(instance => instance.close()).catch(() => {})
      })
    }
    else {
      try {
        const { chromium } = await import('playwright')
        const launching = chromium.launch({ headless: true, timeout: ACTION_TIMEOUT_MS })
        browser = await withSignal(launching, signal, async () => {
          void launching.then(instance => instance.close()).catch(() => {})
        })
      } catch {
        throwIfAborted(signal)
        throw new ReporterBrowserError('browser_unavailable')
      }
    }
    context = await withSignal(browser.newContext({ acceptDownloads: false, locale: 'zh-CN', serviceWorkers: 'block', viewport: { width: 1365, height: 900 } }),
      signal, close)
    await context.route('**/*', async route => {
      const request = route.request()
      let body: unknown
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/settings/mutate') {
        try { body = request.postDataJSON() } catch { /* 格式错误的请求体会在下方按拒绝处理。 */ }
      } else if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/')) {
        try { body = request.postDataJSON() } catch { /* 格式错误的请求体会在下方按拒绝处理。 */ }
      }
      const allowed = reporterBrowserRequestAllowed({ url: request.url(), method: request.method(),
        resourceType: request.resourceType(), ...(body === undefined ? {} : { body }) }, expectedOrigin)
      if (allowed) await route.continue()
      else { recordBlockedRequest(request); await route.abort('blockedbyclient') }
    })
    page = await context.newPage()
    page.on('pageerror', () => { pageErrors++ })
    page.on('console', message => {
      if (message.type() !== 'error') return
      if (message.text().includes('ERR_BLOCKED_BY_CLIENT')) blockedConsoleErrors++
      else consoleErrors++
    })
    page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}) })
    page.on('popup', popup => { void popup.close().catch(() => {}) })
    page.on('download', download => { void download.cancel().catch(() => {}) })
    await context.addInitScript(() => {
      // 每次运行从管理概览页开始，不恢复其他操作者的上次页面。
      sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'overview' }, stack: [] }))
    })
    const authUrl = checkedAuthUrl(options.getAuthenticatedUrl(), expectedOrigin)
    try {
      await withSignal(page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }), signal, close)
      // DSH 0.2.1-rc.3 在新配置下可能显示一个带版本号的预览说明。
      // 只关闭标题和按钮均匹配的该提示，不确认或保存其他界面提示。
      for (const [title, continueLabel] of [['Preview Notice', 'Continue'], ['预览版说明', '继续']] as const) {
        const notice = page.getByRole('dialog', { name: title, exact: true })
        if (await notice.count() === 1 && await notice.isVisible()) {
          await withSignal(notice.getByRole('button', { name: continueLabel, exact: true }).click({ timeout: ACTION_TIMEOUT_MS }), signal, close)
          break
        }
      }
      const panel = page.getByRole('button', { name: 'Superagent', exact: true })
      if (!await panel.count()) throw new ReporterBrowserError('browser_panel_not_found')
      // 打开本产品面板属于固定初始化步骤，不作为模型动作。
      if (await panel.getAttribute('aria-current') !== 'page') {
        await withSignal(panel.click({ timeout: ACTION_TIMEOUT_MS }), signal, close)
      }
      await withSignal(page.locator('#dt-page').waitFor({ state: 'visible', timeout: NAVIGATION_TIMEOUT_MS }), signal, close)
      // DSH 会将一次性登录令牌交换为 HttpOnly Cookie，并重定向到根路径。
      // 立即清理残留查询参数，不读取或保留其中的值。
      await page.evaluate(() => { if (location.search) history.replaceState(history.state, '', location.pathname) })
      if (new URL(page.url()).origin !== expectedOrigin) throw new ReporterBrowserError('browser_origin_changed')
    } catch (error) {
      if (error instanceof ReporterBrowserError) throw error
      throw new ReporterBrowserError('browser_navigation_failed')
    }
  } catch (error) {
    await close()
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
    throw error instanceof ReporterBrowserError ? error : new ReporterBrowserError('browser_unavailable')
  }

  const ensureOpen = (signal: AbortSignal) => {
    throwIfAborted(signal)
    if (closed || !page) throw new ReporterBrowserError('browser_observation_failed')
    if (new URL(page.url()).origin !== expectedOrigin) throw new ReporterBrowserError('browser_origin_changed')
    return page
  }

  const observe = async (signal: AbortSignal): Promise<ReporterBrowserObservation> => {
    const currentPage = ensureOpen(signal)
    try {
      const [search, tabs, main, title] = await withSignal(Promise.all([
        currentPage.locator('.dt-page .dt-search').ariaSnapshot(), currentPage.locator('.dt-tabs').ariaSnapshot(),
        currentPage.locator('#dt-page').ariaSnapshot(), currentPage.title(),
      ]), signal, close)
      const snapshot = `${search}\n${tabs}\n${main}`
      const path = reporterBrowserPath(currentPage.url(), expectedOrigin)
      return { path, title: title.slice(0, 160), accessibility_snapshot: snapshot.slice(0, MAX_SNAPSHOT_CHARS),
        snapshot_truncated: snapshot.length > MAX_SNAPSHOT_CHARS, page_errors: pageErrors, blocked_requests: blockedRequests.slice(),
        console_errors: consoleErrors, blocked_console_errors: blockedConsoleErrors }
    } catch (error) {
      if (error instanceof ReporterBrowserError || signal.aborted) throw error
      throw new ReporterBrowserError('browser_observation_failed')
    }
  }

  const act = async (input: ReporterBrowserAction, signal: AbortSignal) => {
    const currentPage = ensureOpen(signal)
    const parsed = ReporterBrowserActionSchema.safeParse(input)
    if (!parsed.success) throw new ReporterBrowserError('browser_action_invalid')
    const action = parsed.data
    if (action.kind === 'snapshot') return { result: 'completed' as const, observation: await observe(signal) }
    try {
      let target: Locator
      if (action.kind === 'back') {
        target = currentPage.locator('#dt-page .dt-page-head').getByRole('button').first()
      } else {
        target = locatorFor(currentPage, action)
      }
      target = await uniqueVisible(target)
      const result = action.kind === 'click' || action.kind === 'back'
        ? target.click({ timeout: ACTION_TIMEOUT_MS })
        : action.kind === 'fill'
          ? target.fill(action.value, { timeout: ACTION_TIMEOUT_MS })
          : target.press(action.key, { timeout: ACTION_TIMEOUT_MS })
      await withSignal(result, signal, close)
      await withSignal(currentPage.waitForTimeout(150), signal, close)
      return { result: 'completed' as const, observation: await observe(signal) }
    } catch (error) {
      if (error instanceof ReporterBrowserError || signal.aborted) throw error
      throw new ReporterBrowserError('browser_action_failed')
    }
  }

  return { observe, act, close }
}
