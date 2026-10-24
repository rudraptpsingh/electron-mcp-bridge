'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const { createBuiltinTools } = require('../src/builtin-tools.cjs')
const { DesktopGuardrails } = require('../src/guardrails.cjs')
const { DiagnosticsBuffer } = require('../src/diagnostics-buffer.cjs')

describe('Universal Builtin Electron Tools', () => {
  const mockWebContents = {
    getURL: () => 'app://index.html#/grid',
    isLoading: () => false,
    isCrashed: () => false,
    executeJavaScript: async (expr) => {
      if (expr.includes('2 + 2')) return 4
      if (expr.includes('querySelectorAll')) {
        return {
          title: 'ShotSelect - Grid View',
          location: 'app://index.html#/grid',
          totalInteractiveElements: 2,
          elements: [
            { tag: 'button', testId: 'cull-accept-btn', text: 'Accept (P)', bounds: { x: 10, y: 10, w: 100, h: 32 } },
            { tag: 'button', testId: 'cull-reject-btn', text: 'Reject (X)', bounds: { x: 120, y: 10, w: 100, h: 32 } },
          ],
        }
      }
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
  const diagnosticsBuffer = new DiagnosticsBuffer({ guardrails })
  diagnosticsBuffer.recordError({ type: 'warning', message: 'Test warning message' })

  const tools = createBuiltinTools({
    app: {
      getName: () => 'ShotSelect',
      getVersion: () => '1.18.21',
      getLocale: () => 'en-US',
      isPackaged: false,
    },
    BrowserWindow: mockBrowserWindow,
    ipcMain: mockIpcMain,
    guardrails,
    diagnosticsBuffer,
    getWorkflowObserver: () => mockObserver,
  })

  function getTool(name) {
    const t = tools.find((x) => x.name === name)
    assert.ok(t, `Tool ${name} must be present`)
    return t
  }

  test('app:get_app_info returns platform and runtime versions', async () => {
    const tool = getTool('app:get_app_info')
    const result = await tool.handler()
    assert.strictEqual(result.appName, 'ShotSelect')
    assert.strictEqual(result.version, '1.18.21')
    assert.ok(result.pid > 0)
    assert.ok(result.platform.length > 0)
  })

  test('app:list_windows returns window state and bounds', async () => {
    const tool = getTool('app:list_windows')
    const result = await tool.handler()
    assert.strictEqual(result.count, 1)
    assert.strictEqual(result.windows[0].id, 1)
    assert.strictEqual(result.windows[0].title, 'ShotSelect - Project Alpha')
    assert.strictEqual(result.windows[0].url, 'app://index.html#/grid')
  })

  test('app:inspect_ipc lists registered channels and activity', async () => {
    const tool = getTool('app:inspect_ipc')
    const result = await tool.handler({ filter: 'catalog' })
    assert.strictEqual(result.totalRegistered, 2)
    assert.ok(result.channels.some((c) => c.channel === 'catalog:getPhotos'))
  })

  test('app:inspect_ipc_channel returns single channel deep-dive', async () => {
    const tool = getTool('app:inspect_ipc_channel')
    const result = await tool.handler({ channel: 'catalog:getPhotos' })
    assert.strictEqual(result.channel, 'catalog:getPhotos')
    assert.strictEqual(result.isRegistered, true)
    assert.strictEqual(result.handlerType, 'handle')
  })

  test('app:invoke_ipc executes main process handler and records latency', async () => {
    const tool = getTool('app:invoke_ipc')
    const result = await tool.handler({ channel: 'catalog:setRating', args: ['photo_99', 4] })
    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.photoId, 'photo_99')
    assert.strictEqual(result.rating, 4)

    // Check that diagnosticsBuffer recorded it
    const stats = diagnosticsBuffer.getChannelStats('catalog:setRating')
    assert.strictEqual(stats.length, 1)
    assert.strictEqual(stats[0].invocations, 1)
  })

  test('app:get_ui_tree returns semantic interactive elements from renderer', async () => {
    const tool = getTool('app:get_ui_tree')
    const result = await tool.handler()
    assert.strictEqual(result.title, 'ShotSelect - Grid View')
    assert.strictEqual(result.totalInteractiveElements, 2)
    assert.strictEqual(result.elements[0].testId, 'cull-accept-btn')
  })

  test('app:get_error_logs returns buffered errors and warnings', async () => {
    const tool = getTool('app:get_error_logs')
    const result = await tool.handler()
    assert.strictEqual(result.totalErrors, 1)
    assert.strictEqual(result.errors[0].type, 'warning')
    assert.strictEqual(result.errors[0].message, 'Test warning message')
  })

  test('app:get_performance_profile returns V8 heap and observer metrics', async () => {
    const tool = getTool('app:get_performance_profile')
    const result = await tool.handler()
    assert.ok(result.memoryRssMb >= 0)
    assert.ok(result.v8Heap.totalHeapMb >= 0)
    assert.strictEqual(result.workflowObserver.stallsCount, 0)
  })

  test('app:benchmark_ipc benchmarks channel over multiple runs', async () => {
    const tool = getTool('app:benchmark_ipc')
    const result = await tool.handler({ channel: 'catalog:getPhotos', iterations: 5 })
    assert.strictEqual(result.iterations, 5)
    assert.strictEqual(result.successfulRuns, 5)
    assert.strictEqual(result.failures, 0)
    assert.ok(result.latencyMs.mean >= 0)
    assert.strictEqual(result.stallDetected, false)
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

  test('app:trace_event_loop_stalls returns stall diagnostics and thresholds', async () => {
    const tool = getTool('app:trace_event_loop_stalls')
    const result = await tool.handler({ thresholdMs: 40 })
    assert.strictEqual(result.thresholdMs, 40)
    assert.strictEqual(typeof result.stallCount, 'number')
    assert.ok(Array.isArray(result.stalls))
  })

  test('app:inspect_io_queue returns libuv thread pool and handle metrics', async () => {
    const tool = getTool('app:inspect_io_queue')
    const result = await tool.handler()
    assert.ok(result.uvThreadPoolSize > 0)
    assert.strictEqual(typeof result.activeHandles, 'number')
    assert.strictEqual(typeof result.activeRequests, 'number')
    assert.ok(['normal', 'saturated'].includes(result.concurrencyStatus))
  })

  test('app:inspect_memory_breakdown returns process and V8 heap statistics', async () => {
    const tool = getTool('app:inspect_memory_breakdown')
    const result = await tool.handler()
    assert.ok(result.processMemory.rssMb >= 0)
    assert.ok(result.processMemory.heapUsedMb >= 0)
    assert.ok(result.v8HeapStatistics.totalHeapSizeMb >= 0)
    assert.strictEqual(result.windows.openWindowsCount, 1)
  })

  test('app:assert_performance_budgets evaluates declarative budgets', async () => {
    const tool = getTool('app:assert_performance_budgets')
    const result = await tool.handler({ maxStalls: 2, maxIpcMs: 100 })
    assert.strictEqual(typeof result.passed, 'boolean')
  })
})
