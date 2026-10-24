'use strict'

const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { EventEmitter } = require('node:events')
const { LineDelimitedParser } = require('./protocol.cjs')

/**
 * Derives a cross-platform IPC socket path or named pipe for the given app name.
 */
function getSocketPath(appName = 'electron-app') {
  const safeName = appName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\electron-mcp-${safeName}`
  }
  return path.join(os.tmpdir(), `electron-mcp-${safeName}.sock`)
}

/**
 * Socket Server that runs inside the Electron application to accept agent connections.
 */
class SocketServer extends EventEmitter {
  constructor(options = {}) {
    super()
    this.appName = options.appName || 'electron-app'
    this.socketPath = options.socketPath || getSocketPath(this.appName)
    this.server = null
    this.clients = new Set()
  }

  start() {
    return new Promise((resolve, reject) => {
      // Clean up stale socket file on Unix if it exists
      if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
        try {
          fs.unlinkSync(this.socketPath)
        } catch (err) {
          return reject(new Error(`Failed to remove stale socket at ${this.socketPath}: ${err.message}`))
        }
      }

      this.server = net.createServer((socket) => {
        this.clients.add(socket)
        const parser = new LineDelimitedParser()

        socket.on('data', (chunk) => parser.write(chunk))
        parser.on('message', (message) => {
          this.emit('message', message, (response) => {
            if (!socket.destroyed) {
              socket.write(`${JSON.stringify(response)}\n`)
            }
          })
        })

        socket.on('error', (err) => {
          this.emit('client-error', err)
        })

        socket.on('close', () => {
          this.clients.delete(socket)
        })
      })

      this.server.on('error', (err) => {
        this.emit('error', err)
        reject(err)
      })

      this.server.listen(this.socketPath, () => {
        // Enforce private read/write permissions for current user on Unix
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(this.socketPath, 0o600)
          } catch {
            // Ignore if filesystem doesn't support chmod on sockets
          }
        }
        this.emit('listening', this.socketPath)
        resolve(this.socketPath)
      })
    })
  }

  broadcast(message) {
    const data = `${JSON.stringify(message)}\n`
    for (const client of this.clients) {
      if (!client.destroyed) {
        client.write(data)
      }
    }
  }

  stop() {
    return new Promise((resolve) => {
      for (const client of this.clients) {
        client.destroy()
      }
      this.clients.clear()

      if (this.server) {
        this.server.close(() => {
          if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
            try {
              fs.unlinkSync(this.socketPath)
            } catch {
              // Ignore
            }
          }
          resolve()
        })
      } else {
        resolve()
      }
    })
  }
}

/**
 * Socket Client used by the CLI to attach to a running Electron application.
 */
class SocketClient extends EventEmitter {
  constructor(options = {}) {
    super()
    this.appName = options.appName || 'electron-app'
    this.socketPath = options.socketPath || getSocketPath(this.appName)
    this.socket = null
    this.parser = new LineDelimitedParser()
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.socketPath)

      this.socket.on('connect', () => {
        resolve()
      })

      this.socket.on('data', (chunk) => this.parser.write(chunk))

      this.parser.on('message', (message) => {
        this.emit('message', message)
      })

      this.socket.on('error', (err) => {
        reject(err)
      })

      this.socket.on('close', () => {
        this.emit('close')
      })
    })
  }

  send(message) {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(`${JSON.stringify(message)}\n`)
    }
  }

  close() {
    if (this.socket) {
      this.socket.destroy()
    }
  }
}

/**
 * Direct Stdio Server for headless / spawned Electron instances.
 */
class StdioServer extends EventEmitter {
  constructor(options = {}) {
    super()
    this.parser = new LineDelimitedParser()
    this.input = options.input || process.stdin
    this.output = options.output || process.stdout
  }

  start() {
    this.input.on('data', (chunk) => this.parser.write(chunk))
    this.parser.on('message', (message) => {
      this.emit('message', message, (response) => {
        this.output.write(`${JSON.stringify(response)}\n`)
      })
    })
  }

  stop() {
    this.parser.reset()
  }
}

module.exports = {
  getSocketPath,
  SocketServer,
  SocketClient,
  StdioServer,
}
