'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const {
  LineDelimitedParser,
  createResponse,
  createErrorResponse,
  createToolResult,
  createImageContent,
  validateSchema,
} = require('../src/protocol.cjs')

describe('MCP Protocol & Framing', () => {
  test('LineDelimitedParser parses single message', (t, done) => {
    const parser = new LineDelimitedParser()
    parser.on('message', (msg) => {
      assert.strictEqual(msg.jsonrpc, '2.0')
      assert.strictEqual(msg.method, 'ping')
      done()
    })
    parser.write('{"jsonrpc":"2.0","method":"ping"}\n')
  })

  test('LineDelimitedParser handles fragmented chunks', (t, done) => {
    const parser = new LineDelimitedParser()
    parser.on('message', (msg) => {
      assert.strictEqual(msg.id, 42)
      assert.strictEqual(msg.result.ok, true)
      done()
    })

    parser.write('{"jsonrpc":"2.0","id":42')
    parser.write(',"result":{"ok":')
    parser.write('true}}\n')
  })

  test('LineDelimitedParser handles multiple messages in one chunk', () => {
    const parser = new LineDelimitedParser()
    const messages = []
    parser.on('message', (msg) => messages.push(msg))

    parser.write('{"id":1}\n{"id":2}\n{"id":3}\n')
    assert.strictEqual(messages.length, 3)
    assert.deepStrictEqual(messages.map((m) => m.id), [1, 2, 3])
  })

  test('createResponse formats standard JSON-RPC 2.0 response', () => {
    const resp = createResponse(1, { count: 10 })
    assert.strictEqual(resp.jsonrpc, '2.0')
    assert.strictEqual(resp.id, 1)
    assert.strictEqual(resp.result.count, 10)
  })

  test('createErrorResponse formats standard JSON-RPC 2.0 error', () => {
    const err = createErrorResponse(2, -32601, 'Method not found')
    assert.strictEqual(err.jsonrpc, '2.0')
    assert.strictEqual(err.id, 2)
    assert.strictEqual(err.error.code, -32601)
    assert.strictEqual(err.error.message, 'Method not found')
  })

  test('createToolResult formats MCP content arrays', () => {
    const res = createToolResult('Simple text output')
    assert.strictEqual(res.content.length, 1)
    assert.strictEqual(res.content[0].type, 'text')
    assert.strictEqual(res.content[0].text, 'Simple text output')

    const img = createImageContent('base64data', 'image/png')
    const imgRes = createToolResult(img)
    assert.strictEqual(imgRes.content[0].type, 'image')
    assert.strictEqual(imgRes.content[0].data, 'base64data')
  })

  test('validateSchema checks types and required fields', () => {
    const schema = {
      type: 'object',
      properties: {
        photoId: { type: 'string' },
        rating: { type: 'number' },
        flagged: { type: 'boolean' },
      },
      required: ['photoId'],
    }

    const missing = validateSchema(schema, { rating: 5 })
    assert.strictEqual(missing.valid, false)
    assert.match(missing.error, /Missing required argument: 'photoId'/)

    const badType = validateSchema(schema, { photoId: 123 })
    assert.strictEqual(badType.valid, false)
    assert.match(badType.error, /must be a string/)

    const valid = validateSchema(schema, { photoId: 'img_1', rating: 4, flagged: true })
    assert.strictEqual(valid.valid, true)
  })
})
