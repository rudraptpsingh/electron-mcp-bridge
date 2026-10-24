'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const { McpServer } = require('../src/server.cjs')
const { DesktopGuardrails } = require('../src/guardrails.cjs')

describe('McpServer Routing & Handling', () => {
  test('handles initialize and ping methods', async () => {
    const server = new McpServer({ name: 'test-app', version: '1.2.3' })

    const initResp = await server.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    })
    assert.strictEqual(initResp.id, 1)
    assert.strictEqual(initResp.result.serverInfo.name, 'test-app')
    assert.strictEqual(initResp.result.serverInfo.version, '1.2.3')

    const pingResp = await server.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'ping',
    })
    assert.strictEqual(pingResp.id, 2)
    assert.deepStrictEqual(pingResp.result, {})
  })

  test('registers tools and executes tools/call', async () => {
    const server = new McpServer()

    server.registerTool({
      name: 'add_numbers',
      description: 'Adds two numbers',
      schema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
      handler: async ({ a, b }) => ({ sum: a + b }),
    })

    const listResp = await server.handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    })
    assert.strictEqual(listResp.result.tools.length, 1)
    assert.strictEqual(listResp.result.tools[0].name, 'add_numbers')

    const callResp = await server.handleMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'add_numbers', arguments: { a: 15, b: 27 } },
    })
    assert.strictEqual(callResp.id, 4)
    assert.strictEqual(callResp.result.isError, undefined)
    const content = JSON.parse(callResp.result.content[0].text)
    assert.strictEqual(content.sum, 42)
  })

  test('registers and queries verification oracles', async () => {
    const server = new McpServer()

    server.registerOracle('verify_file_hash', 'Checks SHA256 on disk', {
      type: 'object',
      properties: { file: { type: 'string' } },
      required: ['file'],
    }, async ({ file }) => ({ file, valid: true, hash: 'e3b0c442...' }))

    const callResp = await server.handleMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'verify_file_hash', arguments: { file: 'test.xmp' } },
    })
    assert.strictEqual(callResp.id, 5)
    const text = callResp.result.content[0].text
    assert.match(text, /"valid": true/)
    assert.match(text, /e3b0c442/)
  })

  test('registers and reads resources', async () => {
    const server = new McpServer()

    server.registerResource({
      uri: 'app://catalog-state',
      name: 'Active Catalog',
      handler: async () => ({ currentProject: 'wedding-2026', photoCount: 450 }),
    })

    const listResp = await server.handleMessage({
      jsonrpc: '2.0',
      id: 6,
      method: 'resources/list',
    })
    assert.strictEqual(listResp.result.resources.length, 1)
    assert.strictEqual(listResp.result.resources[0].uri, 'app://catalog-state')

    const readResp = await server.handleMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'resources/read',
      params: { uri: 'app://catalog-state' },
    })
    assert.strictEqual(readResp.id, 7)
    assert.match(readResp.result.contents[0].text, /wedding-2026/)
  })

  test('returns error for unknown method or missing tool', async () => {
    const server = new McpServer()

    const missingTool = await server.handleMessage({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'non_existent' },
    })
    assert.strictEqual(missingTool.error.code, -32601)

    const unknownMethod = await server.handleMessage({
      jsonrpc: '2.0',
      id: 9,
      method: 'unknown/action',
    })
    assert.strictEqual(unknownMethod.error.code, -32601)
  })
})
