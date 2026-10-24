'use strict'

const { McpServer } = require('./server.cjs')
const { DesktopGuardrails } = require('./guardrails.cjs')
const { SocketServer, StdioServer, getSocketPath } = require('./transport.cjs')
const { createBuiltinTools } = require('./builtin-tools.cjs')
const { DiagnosticsBuffer } = require('./diagnostics-buffer.cjs')

/**
 * Single-call setup function that turns any Electron application into an MCP Server.
 */
function setupMcpBridge(options = {}) {
  const {
    app,
    ipcMain,
    BrowserWindow: customBrowserWindow,
    appName = app && typeof app.getName === 'function' ? app.getName() : 'electron-app',
    tools = [],
    oracles = [],
    resources = [],
    allowDestructive = false,
    allowActions = true,
    allowedChannels = null,
    blockedChannels = [],
    transport = 'socket',
    socketPath,
    getWorkflowObserver,
  } = options

  // Attempt to resolve BrowserWindow if not provided
  let BrowserWindow = customBrowserWindow
  if (!BrowserWindow) {
    try {
      const electron = require('electron')
      BrowserWindow = electron.BrowserWindow
    } catch {
      // Running in headless / simulated environment
    }
  }

  const guardrails = new DesktopGuardrails({
    allowDestructive,
    allowActions,
    allowedChannels,
    blockedChannels,
  })

  const diagnosticsBuffer = new DiagnosticsBuffer({ guardrails })

  // Hook process error events for triaging
  const onUncaught = (err) => {
    diagnosticsBuffer.recordError({
      type: 'uncaughtException',
      message: err ? err.message : 'Unknown uncaughtException',
      stack: err ? err.stack : undefined,
    })
  }
  const onUnhandled = (reason) => {
    diagnosticsBuffer.recordError({
      type: 'unhandledRejection',
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    })
  }

  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onUnhandled)

  const server = new McpServer({
    name: `${appName}-mcp-bridge`,
    version: '0.2.0',
    guardrails,
  })

  // 1. Register universal Electron tools
  const builtinTools = createBuiltinTools({
    app,
    BrowserWindow,
    ipcMain,
    guardrails,
    diagnosticsBuffer,
    getWorkflowObserver:
      getWorkflowObserver ||
      (() => {
        if (typeof globalThis !== 'undefined' && globalThis.__ELECTRON_WORKFLOW_OBSERVER__) {
          return globalThis.__ELECTRON_WORKFLOW_OBSERVER__
        }
        return null
      }),
  })

  for (const tool of builtinTools) {
    server.registerTool(tool)
  }

  // 2. Register application custom tools
  for (const tool of tools) {
    server.registerTool(tool)
  }

  // 3. Register application oracles
  for (const oracle of oracles) {
    server.registerOracle(oracle.name, oracle.description, oracle.schema, oracle.handler)
  }

  // 4. Register application resources
  for (const resource of resources) {
    server.registerResource(resource)
  }

  // 5. Initialize transports
  let socketServer = null
  let stdioServer = null

  if (transport === 'socket' || transport === 'both') {
    socketServer = new SocketServer({
      appName,
      socketPath: socketPath || getSocketPath(appName),
    })

    socketServer.on('message', async (message, reply) => {
      const response = await server.handleMessage(message)
      if (response !== null) {
        reply(response)
      }
    })

    socketServer.start().catch((err) => {
      console.warn(`[electron-mcp-bridge] Failed to start socket server: ${err.message}`)
    })
  }

  if (transport === 'stdio' || transport === 'both') {
    stdioServer = new StdioServer()
    stdioServer.on('message', async (message, reply) => {
      const response = await server.handleMessage(message)
      if (response !== null) {
        reply(response)
      }
    })
    stdioServer.start()
  }

  const bridge = {
    server,
    guardrails,
    diagnosticsBuffer,
    socketServer,
    stdioServer,
    registerTool: (tool) => server.registerTool(tool),
    registerOracle: (name, desc, schema, handler) => server.registerOracle(name, desc, schema, handler),
    registerResource: (res) => server.registerResource(res),
    handleMessage: (msg) => server.handleMessage(msg),
    stop: async () => {
      process.removeListener('uncaughtException', onUncaught)
      process.removeListener('unhandledRejection', onUnhandled)
      if (socketServer) await socketServer.stop()
      if (stdioServer) stdioServer.stop()
    },
  }

  // Auto teardown on app quit
  if (app && typeof app.on === 'function') {
    app.on('will-quit', () => {
      bridge.stop().catch(() => {})
    })
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.__ELECTRON_MCP_BRIDGE__ = bridge
  }

  return bridge
}

module.exports = {
  setupMcpBridge,
}
