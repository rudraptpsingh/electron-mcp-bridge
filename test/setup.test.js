'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { setupMcpBridge } = require('../src/setup.cjs')

describe('setupMcpBridge One-Line API', () => {
  test('initializes bridge with builtins, tools, oracles, and auto-quits', async () => {
    const mockApp = new EventEmitter()
    mockApp.getName = () => 'ShotSelect'

    const mockIpcMain = {
      _invokeHandlers: new Map(),
      eventNames: () => [],
    }

    const bridge = setupMcpBridge({
      app: mockApp,
      ipcMain: mockIpcMain,
      transport: 'socket',
      socketPath: `/tmp/test-mcp-setup-${Date.now()}.sock`,
      oracles: [
        {
          name: 'verify_xmp_oracle',
          description: 'Checks XMP on disk',
          handler: async () => ({ onDisk: true, rating: 5 }),
        },
      ],
      tools: [
        {
          name: 'open_project',
          description: 'Opens a photo project',
          handler: async ({ folder }) => ({ loaded: folder, count: 50 }),
        },
      ],
    })

    assert.ok(bridge)
    assert.strictEqual(globalThis.__ELECTRON_MCP_BRIDGE__, bridge)

    // Verify tools were registered
    const listResp = await bridge.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    const toolNames = listResp.result.tools.map((t) => t.name)
    assert.ok(toolNames.includes('app:list_windows'))
    assert.ok(toolNames.includes('app:get_diagnostics'))
    assert.ok(toolNames.includes('verify_xmp_oracle'))
    assert.ok(toolNames.includes('open_project'))

    // Verify oracle execution
    const oracleResp = await bridge.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'verify_xmp_oracle' },
    })
    assert.match(oracleResp.result.content[0].text, /"onDisk": true/)
    assert.match(oracleResp.result.content[0].text, /"rating": 5/)

    // Trigger app quit to verify cleanup
    mockApp.emit('will-quit')
    await bridge.stop()
  })
})
