#!/usr/bin/env node
'use strict'

const { SocketClient, getSocketPath } = require('../src/transport.cjs')
const { LineDelimitedParser } = require('../src/protocol.cjs')

const argv = process.argv.slice(2)
const command = argv[0]

function printHelp() {
  console.error(`
electron-mcp-bridge CLI

Usage:
  npx electron-mcp-bridge attach [--app <appName>] [--socket <path>]
      Connect stdio (Claude Desktop / Cursor) to a running Electron application

  npx electron-mcp-bridge tools [--app <appName>]
      List available MCP tools registered in the running application

  npx electron-mcp-bridge call <toolName> [jsonArgs] [--app <appName>]
      Call an MCP tool in the running application and print the result

Options:
  --app <appName>     Name of the application (default: electron-app or shotselect)
  --socket <path>     Explicit Unix domain socket or named pipe path
  --help, -h          Show this help message
`)
}

function parseArg(flag) {
  const index = argv.indexOf(flag)
  if (index !== -1 && index + 1 < argv.length) {
    return argv[index + 1]
  }
  return null
}

async function main() {
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp()
    process.exit(0)
  }

  const appName = parseArg('--app') || process.env.ELECTRON_APP_NAME || 'shotselect'
  const explicitSocket = parseArg('--socket')
  const socketPath = explicitSocket || getSocketPath(appName)

  const client = new SocketClient({ appName, socketPath })

  if (command === 'attach') {
    try {
      await client.connect()
    } catch (err) {
      console.error(`[electron-mcp-bridge] Could not connect to running application '${appName}' at:`)
      console.error(`  ${socketPath}`)
      console.error(`Please ensure the Electron app is running with setupMcpBridge({ app, ipcMain }) enabled.`)
      process.exit(1)
    }

    // Pipe stdin (MCP client like Claude Desktop) to socket
    const stdinParser = new LineDelimitedParser()
    process.stdin.on('data', (chunk) => stdinParser.write(chunk))
    stdinParser.on('message', (msg) => client.send(msg))

    // Pipe socket messages to stdout (MCP response)
    client.on('message', (msg) => {
      process.stdout.write(`${JSON.stringify(msg)}\n`)
    })

    client.on('close', () => {
      process.exit(0)
    })

    process.stdin.on('end', () => {
      client.close()
      process.exit(0)
    })

    return
  }

  if (command === 'tools') {
    try {
      await client.connect()
    } catch (err) {
      console.error(`[electron-mcp-bridge] App not reachable at ${socketPath}`)
      process.exit(1)
    }

    let nextId = 1
    client.on('message', (msg) => {
      if (msg.id === 1) {
        // Send tools/list after initialize
        client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      } else if (msg.id === 2) {
        const tools = (msg.result && msg.result.tools) || []
        console.log(`\nAvailable Tools in '${appName}' (${tools.length}):\n`)
        for (const t of tools) {
          console.log(`  • ${t.name}`)
          if (t.description) console.log(`    ${t.description}`)
        }
        console.log('')
        client.close()
        process.exit(0)
      }
    })

    // Handshake
    client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cli' } },
    })
    return
  }

  if (command === 'call') {
    const toolName = argv[1]
    if (!toolName) {
      console.error('Usage: npx electron-mcp-bridge call <toolName> [jsonArgs]')
      process.exit(1)
    }

    let toolArgs = {}
    if (argv[2] && !argv[2].startsWith('--')) {
      try {
        toolArgs = JSON.parse(argv[2])
      } catch (err) {
        console.error(`Invalid JSON arguments: ${err.message}`)
        process.exit(1)
      }
    }

    try {
      await client.connect()
    } catch (err) {
      console.error(`[electron-mcp-bridge] App not reachable at ${socketPath}`)
      process.exit(1)
    }

    client.on('message', (msg) => {
      if (msg.id === 1) {
        // Handshake done, call tool
        client.send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: toolName, arguments: toolArgs },
        })
      } else if (msg.id === 2) {
        if (msg.error) {
          console.error('Error:', msg.error)
          process.exit(1)
        }
        console.log(JSON.stringify(msg.result, null, 2))
        client.close()
        process.exit(0)
      }
    })

    client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cli' } },
    })
    return
  }

  console.error(`Unknown command: '${command}'. Run with --help for usage.`)
  process.exit(1)
}

main().catch((err) => {
  console.error('[electron-mcp-bridge] Fatal error:', err)
  process.exit(1)
})
