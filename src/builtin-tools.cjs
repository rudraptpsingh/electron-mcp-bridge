'use strict'

const { createImageContent } = require('./protocol.cjs')

/**
 * Creates the set of universal Electron tools for triaging, analysis, and benchmarking.
 */
function createBuiltinTools(context) {
  const { app, BrowserWindow, ipcMain, guardrails, getWorkflowObserver, diagnosticsBuffer } = context

  return [
    {
      name: 'app:get_app_info',
      description: 'Get application metadata: versions, PID, paths, process uptime, and environment flags',
      schema: { type: 'object', properties: {} },
      tier: 'query',
      handler: async () => {
        return {
          appName: app && typeof app.getName === 'function' ? app.getName() : 'electron-app',
          version: app && typeof app.getVersion === 'function' ? app.getVersion() : '0.0.0',
          locale: app && typeof app.getLocale === 'function' ? app.getLocale() : 'en-US',
          isPackaged: app && 'isPackaged' in app ? app.isPackaged : false,
          platform: process.platform,
          arch: process.arch,
          pid: process.pid,
          uptimeSeconds: Math.round(process.uptime ? process.uptime() : 0),
          versions: {
            node: process.version,
            electron: process.versions ? process.versions.electron : undefined,
            chrome: process.versions ? process.versions.chrome : undefined,
            v8: process.versions ? process.versions.v8 : undefined,
          },
        }
      },
    },

    {
      name: 'app:list_windows',
      description: 'Enumerate all open BrowserWindow instances with IDs, titles, bounds, visibility, and URLs',
      schema: { type: 'object', properties: {} },
      tier: 'query',
      handler: async () => {
        if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') {
          return { count: 0, windows: [] }
        }
        const windows = BrowserWindow.getAllWindows().map((win) => {
          const webContents = win.webContents
          return {
            id: win.id,
            title: typeof win.getTitle === 'function' ? win.getTitle() : '',
            bounds: typeof win.getBounds === 'function' ? win.getBounds() : {},
            isFocused: typeof win.isFocused === 'function' ? win.isFocused() : false,
            isVisible: typeof win.isVisible === 'function' ? win.isVisible() : true,
            isMinimized: typeof win.isMinimized === 'function' ? win.isMinimized() : false,
            url: webContents && typeof webContents.getURL === 'function' ? webContents.getURL() : null,
            isLoading: webContents && typeof webContents.isLoading === 'function' ? webContents.isLoading() : false,
            isCrashed: webContents && typeof webContents.isCrashed === 'function' ? webContents.isCrashed() : false,
          }
        })
        return { count: windows.length, windows }
      },
    },

    {
      name: 'app:inspect_ipc',
      description: 'List registered ipcMain channels and invocation metrics (count, avg latency, failures)',
      schema: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Optional channel name substring filter' },
        },
      },
      tier: 'query',
      handler: async (args) => {
        const filter = args && args.filter ? args.filter.toLowerCase() : null
        const registered = []

        if (ipcMain && ipcMain._invokeHandlers instanceof Map) {
          for (const channel of ipcMain._invokeHandlers.keys()) {
            if (!filter || channel.toLowerCase().includes(filter)) {
              registered.push({ channel, type: 'handle' })
            }
          }
        }

        if (ipcMain && typeof ipcMain.eventNames === 'function') {
          for (const event of ipcMain.eventNames()) {
            const channel = String(event)
            if (!filter || channel.toLowerCase().includes(filter)) {
              if (!registered.some((r) => r.channel === channel)) {
                registered.push({ channel, type: 'on' })
              }
            }
          }
        }

        const metrics = diagnosticsBuffer ? diagnosticsBuffer.getChannelStats(filter) : []

        return {
          totalRegistered: registered.length,
          channels: registered,
          activityMetrics: metrics,
        }
      },
    },

    {
      name: 'app:inspect_ipc_channel',
      description: 'Deep-dive inspection of a specific IPC channel: total calls, failure rate, and slow call traces',
      schema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Exact IPC channel name' },
        },
        required: ['channel'],
      },
      tier: 'query',
      handler: async ({ channel }) => {
        let isRegistered = false
        let handlerType = null

        if (ipcMain && ipcMain._invokeHandlers instanceof Map) {
          if (ipcMain._invokeHandlers.has(channel)) {
            isRegistered = true
            handlerType = 'handle'
          }
        }
        if (!isRegistered && ipcMain && typeof ipcMain.eventNames === 'function') {
          if (ipcMain.eventNames().map(String).includes(channel)) {
            isRegistered = true
            handlerType = 'on'
          }
        }

        const stats = diagnosticsBuffer ? diagnosticsBuffer.getChannelStats(channel) : []
        const channelStat = stats.find((s) => s.channel === channel) || null

        return {
          channel,
          isRegistered,
          handlerType,
          stats: channelStat || { invocations: 0, avgMs: 0, maxMs: 0, failures: 0 },
        }
      },
    },

    {
      name: 'app:invoke_ipc',
      description: 'Invoke an ipcMain.handle() channel with arguments and record execution latency',
      schema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Name of the IPC channel' },
          args: { type: 'array', description: 'Arguments to pass to the handler' },
        },
        required: ['channel'],
      },
      tier: 'action',
      handler: async (params) => {
        const { channel, args = [] } = params
        const perm = guardrails.checkPermission('action', channel)
        if (!perm.allowed) throw new Error(perm.reason)

        const start = performance.now()
        let result
        let success = true

        try {
          if (ipcMain && ipcMain._invokeHandlers instanceof Map) {
            const handler = ipcMain._invokeHandlers.get(channel)
            if (typeof handler === 'function') {
              const fakeEvent = {
                sender: { id: 0, getURL: () => 'app://internal-mcp' },
                frameId: 0,
              }
              result = await handler(fakeEvent, ...(Array.isArray(args) ? args : [args]))
              return guardrails.sanitize(result)
            }
          }

          if (BrowserWindow && typeof BrowserWindow.getAllWindows === 'function') {
            const windows = BrowserWindow.getAllWindows()
            const win = windows.find((w) => w.isFocused()) || windows[0]
            if (win && win.webContents) {
              const script = `
                (async () => {
                  if (window.electronAPI && typeof window.electronAPI['${channel}'] === 'function') {
                    return await window.electronAPI['${channel}'](...${JSON.stringify(args)});
                  }
                  const { ipcRenderer } = require ? require('electron') : window.require('electron');
                  return await ipcRenderer.invoke('${channel}', ...${JSON.stringify(args)});
                })()
              `
              result = await win.webContents.executeJavaScript(script)
              return guardrails.sanitize(result)
            }
          }

          throw new Error(`IPC channel '${channel}' not found or no active window available`)
        } catch (err) {
          success = false
          throw err
        } finally {
          const duration = Math.round(performance.now() - start)
          if (diagnosticsBuffer) {
            diagnosticsBuffer.recordIpcCall(channel, duration, success)
          }
        }
      },
    },

    {
      name: 'app:get_ui_tree',
      description: 'Extract semantic UI hierarchy: buttons, inputs, active headings, and data-testid elements from renderer',
      schema: {
        type: 'object',
        properties: {
          windowId: { type: 'number', description: 'Window ID (defaults to focused window)' },
        },
      },
      tier: 'query',
      handler: async (params = {}) => {
        if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') {
          throw new Error('BrowserWindow is not available')
        }

        const windows = BrowserWindow.getAllWindows()
        const win = params.windowId
          ? windows.find((w) => w.id === params.windowId)
          : windows.find((w) => w.isFocused()) || windows[0]

        if (!win || !win.webContents) {
          throw new Error('No active window found')
        }

        const script = `
          (() => {
            const elements = []
            const nodes = document.querySelectorAll(
              'button, a, input, select, textarea, [data-testid], h1, h2, h3, [role="button"], [role="tab"]'
            )
            for (const el of nodes) {
              const rect = el.getBoundingClientRect()
              if (rect.width === 0 && rect.height === 0) continue
              const testId = el.getAttribute('data-testid')
              const role = el.getAttribute('role') || el.tagName.toLowerCase()
              const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80)
              elements.push({
                tag: el.tagName.toLowerCase(),
                testId: testId || undefined,
                role,
                text: text || undefined,
                bounds: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
                disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' ? true : undefined,
              })
            }
            return {
              title: document.title,
              location: window.location.href,
              activeElement: document.activeElement ? {
                tag: document.activeElement.tagName.toLowerCase(),
                testId: document.activeElement.getAttribute('data-testid') || undefined,
                text: (document.activeElement.innerText || document.activeElement.value || '').slice(0, 40),
              } : null,
              totalInteractiveElements: elements.length,
              elements: elements.slice(0, 100),
            }
          })()
        `
        const tree = await win.webContents.executeJavaScript(script)
        return guardrails.sanitize(tree)
      },
    },

    {
      name: 'app:get_error_logs',
      description: 'Fetch recent uncaught errors, unhandled rejections, and diagnostic warnings for triaging',
      schema: { type: 'object', properties: {} },
      tier: 'query',
      handler: async () => {
        const errors = diagnosticsBuffer ? diagnosticsBuffer.errors : []
        return {
          totalErrors: errors.length,
          errors: errors.slice(-50), // Last 50 entries
        }
      },
    },

    {
      name: 'app:get_performance_profile',
      description: 'Fetch V8 heap metrics, detached contexts (leak canary), process CPU, and stall alerts',
      schema: { type: 'object', properties: {} },
      tier: 'query',
      handler: async () => {
        const memory = process.memoryUsage ? process.memoryUsage() : {}
        const cpu = process.cpuUsage ? process.cpuUsage() : {}
        const heap = diagnosticsBuffer ? diagnosticsBuffer.getV8HeapMetrics() : {}

        let observerMetrics = null
        if (typeof getWorkflowObserver === 'function') {
          const obs = getWorkflowObserver()
          if (obs && typeof obs.getSummary === 'function') {
            observerMetrics = obs.getSummary()
          }
        }

        return {
          timestamp: Date.now(),
          memoryRssMb: Math.round((memory.rss || 0) / (1024 * 1024)),
          v8Heap: heap,
          cpu,
          workflowObserver: observerMetrics || { status: 'not-active' },
        }
      },
    },

    {
      name: 'app:benchmark_ipc',
      description: 'Run micro-benchmarking on an IPC channel over N iterations and return p50, p95, p99 latency stats',
      schema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'IPC channel to benchmark' },
          args: { type: 'array', description: 'Arguments to pass' },
          iterations: { type: 'number', description: 'Number of test runs (default: 10, max: 100)' },
        },
        required: ['channel'],
      },
      tier: 'action',
      handler: async (params) => {
        const { channel, args = [], iterations = 10 } = params
        const count = Math.min(Math.max(1, iterations), 100)

        const invokeTool = createBuiltinTools(context).find((t) => t.name === 'app:invoke_ipc')
        if (!invokeTool) throw new Error('invoke_ipc tool unavailable')

        const latencies = []
        let failures = 0

        for (let i = 0; i < count; i++) {
          const start = performance.now()
          try {
            await invokeTool.handler({ channel, args })
            const elapsed = performance.now() - start
            latencies.push(elapsed)
          } catch {
            failures++
          }
        }

        latencies.sort((a, b) => a - b)
        const total = latencies.reduce((sum, v) => sum + v, 0)
        const mean = latencies.length > 0 ? total / latencies.length : 0
        const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0
        const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0
        const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0

        return {
          channel,
          iterations: count,
          successfulRuns: latencies.length,
          failures,
          latencyMs: {
            min: latencies.length > 0 ? Number(latencies[0].toFixed(2)) : 0,
            max: latencies.length > 0 ? Number(latencies[latencies.length - 1].toFixed(2)) : 0,
            mean: Number(mean.toFixed(2)),
            p50: Number(p50.toFixed(2)),
            p95: Number(p95.toFixed(2)),
            p99: Number(p99.toFixed(2)),
          },
          stallDetected: p95 >= 50,
        }
      },
    },

    {
      name: 'app:eval_renderer',
      description: 'Execute JavaScript code inside a window webContents and return the evaluated value',
      schema: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'JavaScript expression to evaluate' },
          windowId: { type: 'number', description: 'Target window ID (defaults to focused window)' },
        },
        required: ['expression'],
      },
      tier: 'action',
      handler: async (params) => {
        const { expression, windowId } = params
        const perm = guardrails.checkPermission('action')
        if (!perm.allowed) throw new Error(perm.reason)

        if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') {
          throw new Error('BrowserWindow is not available')
        }

        const windows = BrowserWindow.getAllWindows()
        const win = windowId
          ? windows.find((w) => w.id === windowId)
          : windows.find((w) => w.isFocused()) || windows[0]

        if (!win || !win.webContents) {
          throw new Error(`Target window ${windowId || '(focused)'} not found`)
        }

        const result = await win.webContents.executeJavaScript(expression)
        return guardrails.sanitize(result)
      },
    },

    {
      name: 'app:capture_screenshot',
      description: 'Capture a screenshot of a BrowserWindow and return as base64 PNG',
      schema: {
        type: 'object',
        properties: {
          windowId: { type: 'number', description: 'Target window ID (defaults to focused window)' },
          rect: {
            type: 'object',
            description: 'Optional sub-rectangle { x, y, width, height } to capture',
          },
        },
      },
      tier: 'query',
      handler: async (params = {}) => {
        const { windowId, rect } = params
        if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') {
          throw new Error('BrowserWindow is not available')
        }

        const windows = BrowserWindow.getAllWindows()
        const win = windowId
          ? windows.find((w) => w.id === windowId)
          : windows.find((w) => w.isFocused()) || windows[0]

        if (!win || !win.webContents) {
          throw new Error(`Target window ${windowId || '(focused)'} not found`)
        }

        const nativeImage = rect
          ? await win.webContents.capturePage(rect)
          : await win.webContents.capturePage()

        const buffer = nativeImage.toPNG ? nativeImage.toPNG() : Buffer.from([])
        return createImageContent(buffer.toString('base64'), 'image/png')
      },
    },

    {
      name: 'app:get_diagnostics',
      description: 'Fetch process memory, uptime, CPU statistics, and electron-workflow-observer performance metrics',
      schema: {
        type: 'object',
        properties: {},
      },
      tier: 'query',
      handler: async () => {
        const memory = process.memoryUsage ? process.memoryUsage() : {}
        const cpu = process.cpuUsage ? process.cpuUsage() : {}
        const uptime = process.uptime ? process.uptime() : 0

        let observerMetrics = null
        if (typeof getWorkflowObserver === 'function') {
          const obs = getWorkflowObserver()
          if (obs && typeof obs.getSummary === 'function') {
            observerMetrics = obs.getSummary()
          }
        }

        return {
          process: {
            pid: process.pid,
            uptimeSeconds: Math.round(uptime),
            nodeVersion: process.version,
            electronVersion: process.versions ? process.versions.electron : undefined,
            memory: {
              rssMb: Math.round((memory.rss || 0) / (1024 * 1024)),
              heapUsedMb: Math.round((memory.heapUsed || 0) / (1024 * 1024)),
              heapTotalMb: Math.round((memory.heapTotal || 0) / (1024 * 1024)),
            },
            cpu,
          },
          workflowObserver: observerMetrics || { status: 'not-active' },
        }
      },
    },
  ]
}

module.exports = {
  createBuiltinTools,
}
