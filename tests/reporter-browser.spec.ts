import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { renderSessionToolOutput } from '../src/app/sessions.ts'
import { ReporterBrowserActionSchema, ReporterBrowserError, captureReporterScreenshot, createReporterBrowserDriver,
  reporterBrowserOrigin, reporterBrowserPath, reporterBrowserPointAllowed, reporterBrowserRequestAllowed } from '../src/reporter/browser.ts'

const origin = 'http://127.0.0.1:3082'
const rpc = (method: string, args?: unknown) => ({ type: 'client-request', method, rpcId: 'test-id', payload: args === undefined ? {} : { args } })

describe('Reporter browser boundary', () => {
  it('accepts semantic and screenshot-coordinate UI actions without selectors, scripts, or arbitrary URLs', () => {
    expect(ReporterBrowserActionSchema.safeParse({ kind: 'snapshot' }).success).toBe(true)
    expect(ReporterBrowserActionSchema.safeParse({ kind: 'click', role: 'tab', name: '来源' }).success).toBe(true)
    expect(ReporterBrowserActionSchema.safeParse({ kind: 'click_at', x: 20, y: 30 }).success).toBe(true)
    expect(ReporterBrowserActionSchema.safeParse({ kind: 'scroll', x: 20, y: 30, delta_y: 240 }).success).toBe(true)
    expect(ReporterBrowserActionSchema.safeParse({ kind: 'set_viewport', width: 375, height: 812 }).success).toBe(true)
    expect(ReporterBrowserActionSchema.safeParse({ kind: 'show_superagent' }).success).toBe(true)
    expect(ReporterBrowserActionSchema.safeParse({ kind: 'click', role: 'link', name: '外链' }).success).toBe(false)
    expect(ReporterBrowserActionSchema.safeParse({ kind: 'click', role: 'button', name: '提交', selector: 'body' }).success).toBe(false)
    expect(ReporterBrowserActionSchema.safeParse({ kind: 'navigate', url: 'https://example.com' }).success).toBe(false)
    expect(ReporterBrowserActionSchema.safeParse({ kind: 'click_at', x: -1, y: 30 }).success).toBe(false)
    expect(ReporterBrowserActionSchema.safeParse({ kind: 'scroll', x: 20, delta_y: 240 }).success).toBe(false)
    expect(ReporterBrowserActionSchema.safeParse({ kind: 'fill', role: 'textbox', name: '查询', value: 'x'.repeat(2_001) }).success).toBe(false)
  })

  it('keeps coordinate clicks inside the current viewport and visible product panel', () => {
    const viewport = { width: 800, height: 600 }, panel = { x: 120, y: 40, width: 640, height: 520 }
    expect(reporterBrowserPointAllowed(viewport, panel, { x: 120, y: 40 })).toBe(true)
    expect(reporterBrowserPointAllowed(viewport, panel, { x: 759, y: 559 })).toBe(true)
    expect(reporterBrowserPointAllowed(viewport, panel, { x: 119, y: 40 })).toBe(false)
    expect(reporterBrowserPointAllowed(viewport, panel, { x: 760, y: 559 })).toBe(false)
    expect(reporterBrowserPointAllowed(viewport, panel, { x: 800, y: 40 })).toBe(false)
    expect(reporterBrowserPointAllowed(viewport, panel, { x: 120.5, y: 40 })).toBe(false)
  })

  it('saves a viewport PNG through the supplied DSH attachment capability', async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
    const image = { attachmentId: 'reporter-image', mediaType: 'image/png', bytes: png.length, width: 1, height: 1 } as unknown as ImageAttachmentRef
    const screenshot = vi.fn(async (options: unknown) => {
      expect(options).toEqual({ type: 'png', fullPage: false, animations: 'disabled', caret: 'hide' })
      return png
    })
    const attach = vi.fn(async (data: Uint8Array) => {
      expect(Buffer.from(data)).toEqual(png)
      return { status: 'attached' as const, image }
    })
    const result = await captureReporterScreenshot({ screenshot }, attach, new AbortController().signal)
    expect(result).toEqual({ status: 'attached', image })
    expect(screenshot).toHaveBeenCalledOnce()
    expect(attach).toHaveBeenCalledOnce()

    expect(await captureReporterScreenshot({ screenshot }, undefined, new AbortController().signal))
      .toEqual({ status: 'unavailable', reason: 'dsh_attachment_service_unavailable' })

    const blocks = renderSessionToolOutput({ observation: { screenshot: { status: result.status } }, image })
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ type: 'text' })
    const textBlock = blocks.find(block => block.type === 'text')
    expect(textBlock).toBeDefined()
    if (!textBlock || textBlock.type !== 'text') throw new Error('DSH text tool output is missing')
    expect(textBlock.text).not.toContain(image.attachmentId)
    expect(blocks[1]).toEqual({ type: 'image', attachment: image })
  })

  it('reports screenshot capture errors and propagates cancellation', async () => {
    await expect(captureReporterScreenshot({ screenshot: vi.fn().mockRejectedValue(new Error('capture failed')) },
      async () => ({ status: 'unavailable' }), new AbortController().signal)).rejects.toMatchObject({ code: 'browser_screenshot_failed' })
    const controller = new AbortController()
    controller.abort(new DOMException('cancelled', 'AbortError'))
    const screenshot = vi.fn(async () => Buffer.from('png'))
    await expect(captureReporterScreenshot({ screenshot }, async () => ({ status: 'attached' }), controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(screenshot).not.toHaveBeenCalled()
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

describe('Reporter browser GUI', () => {
  it.runIf(process.env.DSH_REPORTER_BROWSER_E2E === '1')('captures, clicks, preserves an inactive panel screenshot, and restores Superagent', async () => {
    let server: Server | undefined
    let driver: Awaited<ReturnType<typeof createReporterBrowserDriver>> | undefined
    const html = `<!doctype html><html><head><title>Superagent</title><style>
      body { margin: 0; font: 16px sans-serif; } #dt-page { position: absolute; left: 100px; top: 50px; width: 900px; height: 700px; background: white; }
      #click-target { position: absolute; left: 30px; top: 50px; width: 180px; height: 40px; }
      #leave-panel { position: absolute; left: 30px; top: 120px; width: 180px; height: 40px; }
      #page-state { position: absolute; left: 30px; top: 200px; }
    </style></head><body>
      <button id="superagent" aria-current="page">Superagent</button>
      <main id="dt-page"><div class="dt-page"><div class="dt-search"><button id="click-target">Run visible action</button></div></div>
        <div class="dt-tabs" role="tablist"><button role="tab">Overview</button></div>
        <button id="leave-panel">Open Reporter Session</button><div id="page-state">Before click</div>
      </main>
      <script>
        document.querySelector('#click-target').addEventListener('click', () => { document.querySelector('#page-state').textContent = 'After coordinate click' })
        document.querySelector('#leave-panel').addEventListener('click', () => {
          document.querySelector('#dt-page').hidden = true; document.querySelector('#superagent').removeAttribute('aria-current'); document.title = 'DSH Session'
        })
        document.querySelector('#superagent').addEventListener('click', () => {
          document.querySelector('#dt-page').hidden = false; document.querySelector('#superagent').setAttribute('aria-current', 'page'); document.title = 'Superagent'
        })
      </script></body></html>`
    await new Promise<void>(resolve => {
      const httpServer = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html)
      })
      server = httpServer.listen(0, '127.0.0.1', resolve)
    })
    const activeServer = server!
    const address = activeServer.address() as AddressInfo
    const origin = `http://127.0.0.1:${address.port}`
    const attachments: { bytes: Uint8Array; image: object }[] = []
    const attachScreenshot = async (bytes: Uint8Array) => {
      const image = { attachmentId: `image-${attachments.length}`, mediaType: 'image/png', bytes: bytes.byteLength, width: 1365, height: 900 } as unknown as ImageAttachmentRef
      attachments.push({ bytes: Uint8Array.from(bytes), image })
      return { status: 'attached' as const, image }
    }
    try {
      driver = await createReporterBrowserDriver({ expectedOrigin: origin, getAuthenticatedUrl: () => `${origin}/?token=private`,
        attachScreenshot, launchBrowser: () => chromium.launch({ headless: true }) })
      const first = await driver.observe(new AbortController().signal)
      expect(first.observation).toMatchObject({ path: '/', panel_status: 'active', screenshot: { status: 'attached' } })
      expect(first.image).toEqual(attachments[0]!.image)
      expect(Buffer.from(attachments[0]!.bytes).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))

      const resized = await driver.act({ kind: 'set_viewport', width: 800, height: 600 }, new AbortController().signal)
      expect(resized.observation.viewport).toEqual({ width: 800, height: 600 })
      expect(resized.image).toEqual(attachments[1]!.image)

      const clicked = await driver.act({ kind: 'click_at', x: 200, y: 115 }, new AbortController().signal)
      expect(clicked.observation.accessibility_snapshot).toContain('After coordinate click')
      expect(clicked.image).toEqual(attachments[2]!.image)

      const scrolled = await driver.act({ kind: 'scroll', x: 250, y: 300, delta_x: 0, delta_y: 120 }, new AbortController().signal)
      expect(scrolled.observation).toMatchObject({ viewport: { width: 800, height: 600 }, screenshot: { status: 'attached' } })
      expect(scrolled.image).toEqual(attachments[3]!.image)

      const inactive = await driver.act({ kind: 'click', role: 'button', name: 'Open Reporter Session' }, new AbortController().signal)
      expect(inactive.observation).toMatchObject({ path: '/', title: 'DSH Session', panel_status: 'inactive', screenshot: { status: 'attached' } })
      expect(inactive.observation.accessibility_snapshot).toContain('面板当前不是活动面板')
      expect(inactive.image).toEqual(attachments[4]!.image)

      const restored = await driver.act({ kind: 'show_superagent' }, new AbortController().signal)
      expect(restored.observation).toMatchObject({ title: 'Superagent', panel_status: 'active', screenshot: { status: 'attached' } })
      expect(restored.image).toEqual(attachments[5]!.image)
      expect(attachments).toHaveLength(6)
    } finally {
      await driver?.close()
      await new Promise<void>((resolve, reject) => activeServer.close(error => error ? reject(error) : resolve()))
    }
  })
})
