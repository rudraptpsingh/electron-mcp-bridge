'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const { createBuiltinTools } = require('../src/builtin-tools.cjs')
const { DesktopGuardrails } = require('../src/guardrails.cjs')

describe('Universal Builtin Electron Tools', () => {
  const mockWebContents = {
    getURL: () => 'app://index.html#/grid',
    executeJavaScript: async (expr) => {
      if (expr.includes('2 + 2')) return 4
      return { route: 'grid', count: 120 }
    },
    capturePage: async () => ({
      toPNG: () => Buffer.from('fake-png-bytes'),
    }),
  }

  const mockWindow = {
    id: 1,
    getTitle: () => 'ShotSelect - Project Alpha',
    getBounds: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
    isFocused: () => true,
    isVisible: () => true,
    isMinimized: () => false,
    webContents: mockWebContents,
  }

  const mockBrowserWindow = {
    getAllWindows: () => [mockWindow],
  }

  const mockIpcMain = {
    _invokeHandlers: new Map([
      ['catalog:getPhotos', async () => [{ id: 'p1', rating: 5 }]],
      ['catalog:setRating', async (_event, photoId, rating) => ({ ok: true, photoId, rating })],
    ]),
    eventNames: () => ['app:ready', 'window:close'],
  }

  const mockObserver = {
    getSummary: () => ({
      slowChannels: [{ channel: 'io:heavy', p95Ms: 42 }],
      stallsCount: 0,
    }),
  }

  const guardrails = new DesktopGuardrails()

  const tools = createBuiltinTools({
    app: { getName: () => 'ShotSelect' },
    BrowserWindow: mockBrowserWindow,
    ipcMain: mockIpcMain,
    guardrails,
    getWorkflowObserver: () => mockObserver,
  })

  function getTool(name) {
    const t = tools.find((x) => x.name === name)
    assert.ok(t, `Tool ${name} must be present`)
    return t
  }

  test('app:list_windows returns window state and bounds', async () => {
    const tool = getTool('app:list_windows')
    const result = await tool.handler()
    assert.strictEqual(result.count, 1)
    assert.strictEqual(result.windows[0].id, 1)
    assert.strictEqual(result.windows[0].title, 'ShotSelect - Project Alpha')
    assert.strictEqual(result.windows[0].url, 'app://index.html#/grid')
  })

  test('app:inspect_ipc lists registered channels', async () => {
    const tool = getTool('app:inspect_ipc')
    const result = await tool.handler({ filter: 'catalog' })
    assert.strictEqual(result.total, 2)
    assert.ok(result.channels.some((c) => c.channel === 'catalog:getPhotos'))
  })

  test('app:invoke_ipc executes main process handler', async () => {
    const tool = getTool('app:invoke_ipc')
    const result = await tool.handler({ channel: 'catalog:setRating', args: ['photo_99', 4] })
    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.photoId, 'photo_99')
    assert.strictEqual(result.rating, 4)
  })

  test('app:eval_renderer runs JavaScript in target window', async () => {
    const tool = getTool('app:eval_renderer')
    const result = await tool.handler({ expression: '2 + 2' })
    assert.strictEqual(result, 4)
  })

  test('app:capture_screenshot returns MCP image content', async () => {
    const tool = getTool('app:capture_screenshot')
    const result = await tool.handler()
    assert.strictEqual(result.type, 'image')
    assert.strictEqual(result.mimeType, 'image/png')
    assert.ok(result.data.length > 0)
  })

  test('app:get_diagnostics fetches memory, process info, and observer metrics', async () => {
    const tool = getTool('app:get_diagnostics')
    const result = await tool.handler()
    assert.ok(result.process.pid > 0)
    assert.ok(result.process.memory.rssMb >= 0)
    assert.strictEqual(result.workflowObserver.stallsCount, 0)
    assert.strictEqual(result.workflowObserver.slowChannels[0].channel, 'io:heavy')
  })
})
