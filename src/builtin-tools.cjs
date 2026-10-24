'use strict'

const { createImageContent, createTextContent } = require('./protocol.cjs')

/**
 * Creates the set of universal Electron tools.
 */
function createBuiltinTools(context) {
  const { app, BrowserWindow, ipcMain, guardrails, getWorkflowObserver } = context

  return [
    {
      name: 'app:list_windows',
      description: 'Enumerate all open BrowserWindow instances with their IDs, titles, bounds, and URLs',
      schema: {
        type: 'object',
        properties: {},
      },
      tier: 'query',
      handler: async () => {
        if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') {
          return { windows: [] }
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
          }
        })
        return { count: windows.length, windows }
      },
    },

    {
      name: 'app:inspect_ipc',
      description: 'List registered ipcMain channels and registered handler metadata',
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

        // 1. Check ipcMain._invokeHandlers (Electron internal Map of .handle() channels)
        if (ipcMain && ipcMain._invokeHandlers instanceof Map) {
          for (const channel of ipcMain._invokeHandlers.keys()) {
            if (!filter || channel.toLowerCase().includes(filter)) {
              registered.push({ channel, type: 'handle' })
            }
          }
        }

        // 2. Check eventNames for .on() listeners
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

        return {
          total: registered.length,
          channels: registered,
        }
      },
    },

    {
      name: 'app:invoke_ipc',
      description: 'Invoke an ipcMain.handle() channel in the main process with specified arguments',
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
        if (!perm.allowed) {
          throw new Error(perm.reason)
        }

        // Try direct handler execution from ipcMain._invokeHandlers
        if (ipcMain && ipcMain._invokeHandlers instanceof Map) {
          const handler = ipcMain._invokeHandlers.get(channel)
          if (typeof handler === 'function') {
            const fakeEvent = {
              sender: { id: 0, getURL: () => 'app://internal-mcp' },
              frameId: 0,
            }
            const result = await handler(fakeEvent, ...(Array.isArray(args) ? args : [args]))
            return guardrails.sanitize(result)
          }
        }

        // Fallback: evaluate through active window's ipcRenderer if possible
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
            const result = await win.webContents.executeJavaScript(script)
            return guardrails.sanitize(result)
          }
        }

        throw new Error(`IPC channel '${channel}' not found or no active window available for dispatch`)
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
