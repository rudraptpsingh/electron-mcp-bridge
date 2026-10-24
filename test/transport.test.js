'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const os = require('node:os')
const { SocketServer, SocketClient, getSocketPath } = require('../src/transport.cjs')

describe('Socket Transport', () => {
  test('derives cross-platform socket path', () => {
    const sock = getSocketPath('My ShotSelect App')
    assert.ok(typeof sock === 'string')
    if (process.platform === 'win32') {
      assert.match(sock, /^\\\\\.\\pipe\\electron-mcp-my_shotselect_app/)
    } else {
      assert.match(sock, /electron-mcp-my_shotselect_app\.sock$/)
    }
  })

  test('SocketServer and SocketClient connect and exchange messages', async () => {
    const testAppName = `test-bridge-${Date.now()}`
    const testSocketPath = path.join(os.tmpdir(), `${testAppName}.sock`)

    const server = new SocketServer({ appName: testAppName, socketPath: testSocketPath })
    const client = new SocketClient({ appName: testAppName, socketPath: testSocketPath })

    server.on('message', (msg, reply) => {
      assert.strictEqual(msg.method, 'echo')
      reply({ id: msg.id, result: { echoed: msg.params.text } })
    })

    await server.start()
    await client.connect()

    const responseReceived = await new Promise((resolve) => {
      client.on('message', (msg) => {
        resolve(msg)
      })
      client.send({ id: 100, method: 'echo', params: { text: 'Hello Electron MCP' } })
    })

    assert.strictEqual(responseReceived.id, 100)
    assert.strictEqual(responseReceived.result.echoed, 'Hello Electron MCP')

    client.close()
    await server.stop()
  })
})
