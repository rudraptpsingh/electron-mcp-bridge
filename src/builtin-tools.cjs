'use strict'

const { createImageContent } = require('./protocol.cjs')

/**
 * Creates the set of universal Electron tools for triaging, analysis, and benchmarking.
 */
function createBuiltinTools(context) {
  const { app, BrowserWindow, ipcMain, guardrails, getWorkflowObserver, getAppVitals, diagnosticsBuffer } = context

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

    {
      name: 'app:trace_event_loop_stalls',
      description: 'Trace and diagnose main-process event-loop stalls, freeze durations, and active blocker handlers',
      schema: {
        type: 'object',
        properties: {
          thresholdMs: { type: 'number', description: 'Stall duration threshold in ms (default: 50)' },
        },
      },
      tier: 'query',
      handler: async (params = {}) => {
        const threshold = params.thresholdMs || 50
        let stalls = []
        if (typeof getWorkflowObserver === 'function') {
          const obs = getWorkflowObserver()
          if (obs && Array.isArray(obs.events)) {
            stalls = obs.events
              .filter((e) => e.kind === 'main-stall' && (!threshold || e.stallMs >= threshold))
              .map((e) => ({
                stallMs: e.stallMs,
                topBlocker: e.topBlocker || 'main-thread-busy',
                blockerCount: e.blockerCount || 1,
                time: e.monotonicMs,
              }))
          }
        }
        return {
          thresholdMs: threshold,
          stallCount: stalls.length,
          worstStallMs: stalls.length > 0 ? Math.max(...stalls.map((s) => s.stallMs)) : 0,
          stalls: stalls.slice(-20),
        }
      },
    },

    {
      name: 'app:inspect_io_queue',
      description: 'Inspect main-process libuv thread pool, pending I/O tasks, and active handle counts',
      schema: { type: 'object', properties: {} },
      tier: 'query',
      handler: async () => {
        let activeHandles = 0
        let activeRequests = 0
        if (typeof process._getActiveHandles === 'function') {
          activeHandles = process._getActiveHandles().length
        }
        if (typeof process._getActiveRequests === 'function') {
          activeRequests = process._getActiveRequests().length
        }
        const threadPoolSize = Number(process.env.UV_THREADPOOL_SIZE) || 4

        return {
          uvThreadPoolSize: threadPoolSize,
          activeHandles,
          activeRequests,
          concurrencyStatus: activeRequests >= threadPoolSize ? 'saturated' : 'normal',
        }
      },
    },

    {
      name: 'app:inspect_memory_breakdown',
      description: 'Inspect detailed V8 heap statistics, external ArrayBuffers, process RSS, and open window count',
      schema: { type: 'object', properties: {} },
      tier: 'query',
      handler: async () => {
        const v8 = require('node:v8')
        const heapStats = typeof v8.getHeapStatistics === 'function' ? v8.getHeapStatistics() : {}
        const memory = process.memoryUsage ? process.memoryUsage() : {}
        const windows = BrowserWindow && typeof BrowserWindow.getAllWindows === 'function' ? BrowserWindow.getAllWindows() : []

        return {
          processMemory: {
            rssMb: Number(((memory.rss || 0) / (1024 * 1024)).toFixed(2)),
            heapUsedMb: Number(((memory.heapUsed || 0) / (1024 * 1024)).toFixed(2)),
            heapTotalMb: Number(((memory.heapTotal || 0) / (1024 * 1024)).toFixed(2)),
            externalMb: Number(((memory.external || 0) / (1024 * 1024)).toFixed(2)),
            arrayBuffersMb: Number(((memory.arrayBuffers || 0) / (1024 * 1024)).toFixed(2)),
          },
          v8HeapStatistics: {
            totalHeapSizeMb: Number(((heapStats.total_heap_size || 0) / (1024 * 1024)).toFixed(2)),
            usedHeapSizeMb: Number(((heapStats.used_heap_size || 0) / (1024 * 1024)).toFixed(2)),
            heapSizeLimitMb: Number(((heapStats.heap_size_limit || 0) / (1024 * 1024)).toFixed(2)),
            mallocedMemoryMb: Number(((heapStats.malloced_memory || 0) / (1024 * 1024)).toFixed(2)),
          },
          windows: {
            openWindowsCount: windows.length,
          },
        }
      },
    },

    {
      name: 'app:assert_performance_budgets',
      description: 'Assert declarative performance budgets against active workflow observer traces (max stalls, IPC budgets)',
      schema: {
        type: 'object',
        properties: {
          maxStalls: { type: 'number', description: 'Maximum event-loop stalls allowed' },
          maxStallMs: { type: 'number', description: 'Maximum event-loop stall duration in ms' },
          maxIpcMs: { type: 'number', description: 'Global maximum IPC duration in ms' },
          maxFailures: { type: 'number', description: 'Maximum allowed failed IPC calls' },
          channelBudgets: { type: 'object', description: 'Map of channel -> { maxMs, maxFailures }' },
        },
      },
      tier: 'query',
      handler: async (budgets = {}) => {
        if (typeof getWorkflowObserver !== 'function') {
          return { passed: true, note: 'workflow-observer not configured' }
        }
        const obs = getWorkflowObserver()
        if (!obs || !Array.isArray(obs.events)) {
          return { passed: true, note: 'no active workflow events recorded' }
        }
        if (typeof obs.assertBudgets === 'function') {
          return obs.assertBudgets(budgets)
        }
        const events = obs.events
        const violations = []
        let stalls = 0
        let worstStallMs = 0
        let failures = 0
        for (const e of events) {
          if (e.kind === 'main-stall') {
            stalls++
            if (e.stallMs > worstStallMs) worstStallMs = e.stallMs
            if (budgets.maxStallMs && e.stallMs > budgets.maxStallMs) {
              violations.push(`Stall ${e.stallMs}ms exceeded budget ${budgets.maxStallMs}ms`)
            }
          }
          if (e.kind === 'ipc-handle') {
            if (!e.ok) failures++
            if (budgets.maxIpcMs && e.durationMs > budgets.maxIpcMs) {
              violations.push(`Channel '${e.channel}' took ${e.durationMs}ms (budget: ${budgets.maxIpcMs}ms)`)
            }
          }
        }
        if (budgets.maxStalls != null && stalls > budgets.maxStalls) {
          violations.push(`Total stalls ${stalls} exceeded budget ${budgets.maxStalls}`)
        }
        if (budgets.maxFailures != null && failures > budgets.maxFailures) {
          violations.push(`Total failures ${failures} exceeded budget ${budgets.maxFailures}`)
        }
        return {
          passed: violations.length === 0,
          violations,
          summary: { totalEvents: events.length, stalls, worstStallMs, failures },
        }
      },
    },

    {
      name: 'app:get_health_report',
      description: 'One-stop comprehensive application health report (event-loop freezes, memory, I/O queue, windows, and observer advice)',
      schema: { type: 'object', properties: {} },
      tier: 'query',
      handler: async () => {
        const memory = process.memoryUsage ? process.memoryUsage() : {}
        const v8 = require('node:v8')
        const heapStats = typeof v8.getHeapStatistics === 'function' ? v8.getHeapStatistics() : {}
        const windows = BrowserWindow && typeof BrowserWindow.getAllWindows === 'function' ? BrowserWindow.getAllWindows() : []
        const focusedWin = windows.find((w) => typeof w.isFocused === 'function' && w.isFocused()) || windows[0] || null

        let observerSummary = null
        let advice = []
        if (typeof getWorkflowObserver === 'function') {
          const obs = getWorkflowObserver()
          if (obs) {
            if (typeof obs.getSummary === 'function') observerSummary = obs.getSummary()
            else if (typeof obs.summary === 'function') observerSummary = obs.summary()
            if (typeof obs.getAdvice === 'function') advice = obs.getAdvice()
          }
        }

        let coreVitals = null
        if (typeof getAppVitals === 'function') {
          const vitals = getAppVitals()
          if (vitals && typeof vitals.getSummary === 'function') {
            coreVitals = vitals.getSummary()
          }
        }

        let activeHandles = 0
        let activeRequests = 0
        if (typeof process._getActiveHandles === 'function') activeHandles = process._getActiveHandles().length
        if (typeof process._getActiveRequests === 'function') activeRequests = process._getActiveRequests().length
        const threadPoolSize = Number(process.env.UV_THREADPOOL_SIZE) || 4

        const stalls = observerSummary?.stalls || (coreVitals?.vitals?.EST?.totalStalls) || 0
        const worstStallMs = observerSummary?.worstStallMs || (coreVitals?.vitals?.EST?.worstMs) || 0

        return {
          app: {
            name: app && typeof app.getName === 'function' ? app.getName() : 'electron-app',
            version: app && typeof app.getVersion === 'function' ? app.getVersion() : '0.0.0',
            platform: process.platform,
            pid: process.pid,
            uptimeSeconds: Math.round(process.uptime ? process.uptime() : 0),
          },
          status: stalls === 0 && worstStallMs < 50 ? 'HEALTHY' : 'DEGRADED',
          eventLoop: {
            stalls,
            worstStallMs,
            isFrozen: worstStallMs >= 100,
          },
          ioQueue: {
            uvThreadPoolSize: threadPoolSize,
            activeHandles,
            activeRequests,
            status: activeRequests >= threadPoolSize ? 'saturated' : 'normal',
          },
          memory: {
            rssMb: Number(((memory.rss || 0) / (1024 * 1024)).toFixed(2)),
            heapUsedMb: Number(((memory.heapUsed || 0) / (1024 * 1024)).toFixed(2)),
            heapLimitMb: Number(((heapStats.heap_size_limit || 0) / (1024 * 1024)).toFixed(2)),
            arrayBuffersMb: Number(((memory.arrayBuffers || 0) / (1024 * 1024)).toFixed(2)),
          },
          activeWindow: focusedWin ? {
            id: focusedWin.id,
            title: typeof focusedWin.getTitle === 'function' ? focusedWin.getTitle() : '',
            url: focusedWin.webContents && typeof focusedWin.webContents.getURL === 'function' ? focusedWin.webContents.getURL() : null,
          } : null,
          workflowObserver: observerSummary || { status: 'not-active' },
          coreVitals: coreVitals || { status: 'not-active' },
          advice: advice.length > 0 ? advice : (observerSummary?.advice || []),
          lastError: diagnosticsBuffer && diagnosticsBuffer.errors.length > 0 ? diagnosticsBuffer.errors[diagnosticsBuffer.errors.length - 1] : null,
        }
      },
    },

    {
      name: 'app:get_performance_advice',
      description: 'Fetch actionable performance and architecture optimization advice generated by electron-workflow-observer',
      schema: { type: 'object', properties: {} },
      tier: 'query',
      handler: async () => {
        let advice = []
        if (typeof getWorkflowObserver === 'function') {
          const obs = getWorkflowObserver()
          if (obs) {
            if (typeof obs.getAdvice === 'function') advice = obs.getAdvice()
            else if (typeof obs.getSummary === 'function') advice = obs.getSummary().advice || []
          }
        }
        return {
          count: advice.length,
          advice,
        }
      },
    },

    {
      name: 'app:get_core_vitals',
      description: 'Fetch real-time Desktop Core Vitals (EST event loop stalls, IRL IPC latency, TTFP, MBR memory bloat, and FDC frame drops)',
      schema: { type: 'object', properties: {} },
      tier: 'query',
      handler: async () => {
        if (typeof getAppVitals === 'function') {
          const v = getAppVitals()
          if (v && typeof v.getSummary === 'function') return v.getSummary()
        }
        return { status: 'not-active', error: 'app-vitals not initialized' }
      },
    },

    {
      name: 'app:assert_core_vitals_budgets',
      description: 'Evaluate declarative SLA performance budgets against recorded Desktop Core Vitals in CI or automated agent evaluations',
      schema: {
        type: 'object',
        properties: {
          maxEstMs: { type: 'number', description: 'Max allowed event-loop stall duration in ms (default: 50)' },
          maxIrlMs: { type: 'number', description: 'Max allowed p95 IPC latency in ms (default: 25)' },
          maxTtfpMs: { type: 'number', description: 'Max allowed time to first pixels in ms (default: 800)' },
          maxMbrRatio: { type: 'number', description: 'Max allowed memory bloat ratio (default: 2.0)' },
          maxFdcPercent: { type: 'number', description: 'Max allowed frame drop percentage (default: 2.0)' },
        },
      },
      tier: 'query',
      handler: async (budgets = {}) => {
        if (typeof getAppVitals === 'function') {
          const v = getAppVitals()
          if (v && typeof v.assertBudgets === 'function') return v.assertBudgets(budgets)
        }
        return { passed: false, error: 'app-vitals not initialized', violations: ['app-vitals not initialized'] }
      },
    },

    {
      name: 'app:click_element',
      description: 'Find and click an interactive UI element by data-testid, text, or selector inside BrowserWindow',
      schema: {
        type: 'object',
        properties: {
          testId: { type: 'string', description: 'data-testid attribute value' },
          text: { type: 'string', description: 'Visible text content of element' },
          selector: { type: 'string', description: 'CSS selector' },
          windowId: { type: 'number', description: 'Target window ID' },
        },
      },
      tier: 'action',
      handler: async (params = {}) => {
        const perm = guardrails.checkPermission('action')
        if (!perm.allowed) throw new Error(perm.reason)

        if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') {
          throw new Error('BrowserWindow is not available')
        }
        const windows = BrowserWindow.getAllWindows()
        const win = params.windowId
          ? windows.find((w) => w.id === params.windowId)
          : windows.find((w) => w.isFocused()) || windows[0]
        if (!win || !win.webContents) throw new Error('Target window not found')

        const script = `
          (() => {
            const { testId, text, selector } = ${JSON.stringify(params)};
            let el = null;
            if (testId) el = document.querySelector('[data-testid="' + testId + '"]');
            if (!el && selector) el = document.querySelector(selector);
            if (!el && text) {
              const all = Array.from(document.querySelectorAll('button, a, input, [role="button"], [role="tab"], div, span'));
              el = all.find((node) => (node.innerText || node.value || '').trim().toLowerCase() === text.toLowerCase());
            }
            if (!el) return { success: false, error: 'Element not found matching criteria' };

            el.scrollIntoView({ block: 'center', inline: 'center' });
            const rect = el.getBoundingClientRect();
            el.focus();
            const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
            el.dispatchEvent(clickEvent);

            return {
              success: true,
              element: {
                tag: el.tagName.toLowerCase(),
                testId: el.getAttribute('data-testid') || undefined,
                text: (el.innerText || el.value || '').trim().slice(0, 80),
                bounds: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
              },
            };
          })()
        `
        const result = await win.webContents.executeJavaScript(script)
        if (!result.success) throw new Error(result.error)
        return guardrails.sanitize(result)
      },
    },

    {
      name: 'app:type_text',
      description: 'Focus an input/textarea element and type text into it',
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type into input' },
          testId: { type: 'string', description: 'data-testid of target input' },
          selector: { type: 'string', description: 'CSS selector of target input' },
          clear: { type: 'boolean', description: 'Clear existing text first (default: true)' },
          windowId: { type: 'number', description: 'Target window ID' },
        },
        required: ['text'],
      },
      tier: 'action',
      handler: async (params = {}) => {
        const perm = guardrails.checkPermission('action')
        if (!perm.allowed) throw new Error(perm.reason)

        if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') {
          throw new Error('BrowserWindow is not available')
        }
        const windows = BrowserWindow.getAllWindows()
        const win = params.windowId
          ? windows.find((w) => w.id === params.windowId)
          : windows.find((w) => w.isFocused()) || windows[0]
        if (!win || !win.webContents) throw new Error('Target window not found')

        const script = `
          (() => {
            const { testId, selector, text, clear = true } = ${JSON.stringify(params)};
            let el = null;
            if (testId) el = document.querySelector('[data-testid="' + testId + '"]');
            if (!el && selector) el = document.querySelector(selector);
            if (!el) el = document.querySelector('input:not([type="hidden"]), textarea');
            if (!el) return { success: false, error: 'Input element not found' };

            el.focus();
            if (clear) el.value = '';
            el.value = clear ? text : (el.value + text);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));

            return {
              success: true,
              value: el.value,
              tag: el.tagName.toLowerCase(),
              testId: el.getAttribute('data-testid') || undefined,
            };
          })()
        `
        const result = await win.webContents.executeJavaScript(script)
        if (!result.success) throw new Error(result.error)
        return guardrails.sanitize(result)
      },
    },

    {
      name: 'app:navigate_route',
      description: 'Navigate to a route or hash in the active Electron window',
      schema: {
        type: 'object',
        properties: {
          route: { type: 'string', description: 'Target route path or hash (e.g. /grid, #/cull, /export)' },
          windowId: { type: 'number', description: 'Target window ID' },
        },
        required: ['route'],
      },
      tier: 'action',
      handler: async (params = {}) => {
        const perm = guardrails.checkPermission('action')
        if (!perm.allowed) throw new Error(perm.reason)

        if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') {
          throw new Error('BrowserWindow is not available')
        }
        const windows = BrowserWindow.getAllWindows()
        const win = params.windowId
          ? windows.find((w) => w.id === params.windowId)
          : windows.find((w) => w.isFocused()) || windows[0]
        if (!win || !win.webContents) throw new Error('Target window not found')

        const script = `
          (() => {
            const target = ${JSON.stringify(params.route)};
            if (target.startsWith('#')) {
              window.location.hash = target;
            } else {
              window.history.pushState({}, '', target);
              window.dispatchEvent(new PopStateEvent('popstate'));
            }
            return {
              navigated: true,
              url: window.location.href,
              hash: window.location.hash,
              pathname: window.location.pathname,
            };
          })()
        `
        const result = await win.webContents.executeJavaScript(script)
        return guardrails.sanitize(result)
      },
    },
  ]
}

module.exports = {
  createBuiltinTools,
}
