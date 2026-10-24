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

  npx electron-mcp-bridge triage [--app <appName>]
      Run a full diagnostic triage scan (windows, memory leaks, errors, IPC health)

  npx electron-mcp-bridge state [--app <appName>]
      Inspect the active window UI hierarchy, test IDs, and route state

  npx electron-mcp-bridge benchmark <channel> [jsonArgs] [--iterations <N>]
      Micro-benchmark an IPC channel over N runs and return p50/p95/p99 latency

  npx electron-mcp-bridge tools [--app <appName>]
      List available MCP tools registered in the running application

  npx electron-mcp-bridge call <toolName> [jsonArgs] [--app <appName>]
      Call an MCP tool in the running application and print the result

Options:
  --app <appName>     Name of the application (default: electron-app or shotselect)
  --socket <path>     Explicit Unix domain socket or named pipe path
  --iterations <N>    Number of benchmark iterations (default: 10)
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

async function callToolRpc(client, toolName, toolArgs = {}) {
  return new Promise((resolve, reject) => {
    let callId = 2
    const onMessage = (msg) => {
      if (msg.id === 1) {
        // Handshake complete, dispatch tool call
        client.send({
          jsonrpc: '2.0',
          id: callId,
          method: 'tools/call',
          params: { name: toolName, arguments: toolArgs },
        })
      } else if (msg.id === callId) {
        client.removeListener('message', onMessage)
        if (msg.error) {
          return reject(new Error(msg.error.message || 'RPC Error'))
        }
        const text = msg.result?.content?.[0]?.text
        try {
          resolve(JSON.parse(text))
        } catch {
          resolve(text)
        }
      }
    }

    client.on('message', onMessage)
    client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cli' } },
    })
  })
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

    const stdinParser = new LineDelimitedParser()
    process.stdin.on('data', (chunk) => stdinParser.write(chunk))
    stdinParser.on('message', (msg) => client.send(msg))

    client.on('message', (msg) => {
      process.stdout.write(`${JSON.stringify(msg)}\n`)
    })

    client.on('close', () => process.exit(0))
    process.stdin.on('end', () => {
      client.close()
      process.exit(0)
    })
    return
  }

  if (command === 'triage') {
    try {
      await client.connect()
    } catch (err) {
      console.error(`[electron-mcp-bridge] App not reachable at ${socketPath}`)
      process.exit(1)
    }

    try {
      const appInfo = await callToolRpc(client, 'app:get_app_info')
      const windows = await callToolRpc(client, 'app:list_windows')
      const perf = await callToolRpc(client, 'app:get_performance_profile')
      const errors = await callToolRpc(client, 'app:get_error_logs')
      const ipc = await callToolRpc(client, 'app:inspect_ipc')

      console.log('\n' + '='.repeat(64))
      console.log(` ELECTRON MCP TRIAGE REPORT: ${appInfo.appName || appName}`)
      console.log('='.repeat(64))
      console.log(`• Process: PID ${appInfo.pid} | Uptime: ${appInfo.uptimeSeconds}s | Platform: ${appInfo.platform} (${appInfo.arch})`)
      console.log(`• Versions: Electron ${appInfo.versions?.electron} | Node ${appInfo.versions?.node}`)
      console.log(`• Memory: RSS ${perf.memoryRssMb} MB | Heap: ${perf.v8Heap?.usedHeapMb || 0} MB / ${perf.v8Heap?.totalHeapMb || 0} MB`)
      if (perf.v8Heap?.detachedContextWarning) {
        console.log(`  ⚠️  WARNING: ${perf.v8Heap.numberOfDetachedContexts} detached context(s) detected (potential memory leak)!`)
      }
      console.log(`• Windows: ${windows.count} open window(s)`)
      for (const w of windows.windows || []) {
        console.log(`  - [ID ${w.id}] "${w.title}" (${w.isFocused ? 'Focused' : 'Background'}) -> ${w.url || 'blank'}`)
      }
      console.log(`• IPC Channels: ${ipc.totalRegistered} registered`)
      console.log(`• Uncaught Errors: ${errors.totalErrors} recorded`)
      if (errors.totalErrors > 0) {
        for (const e of errors.errors) {
          console.log(`  ❌ [${e.type}] ${e.message}`)
        }
      }
      console.log('='.repeat(64) + '\n')
      client.close()
      process.exit(0)
    } catch (err) {
      console.error('[electron-mcp-bridge] Triage failed:', err.message)
      client.close()
      process.exit(1)
    }
  }

  if (command === 'state') {
    try {
      await client.connect()
    } catch (err) {
      console.error(`[electron-mcp-bridge] App not reachable at ${socketPath}`)
      process.exit(1)
    }

    try {
      const tree = await callToolRpc(client, 'app:get_ui_tree')
      console.log('\n' + '='.repeat(64))
      console.log(` ACTIVE UI STATE: ${tree.title || 'Untitled'}`)
      console.log(` Location: ${tree.location || 'unknown'}`)
      console.log(` Total Interactive Elements: ${tree.totalInteractiveElements}`)
      console.log('='.repeat(64))
      for (const el of tree.elements || []) {
        const idStr = el.testId ? `[data-testid="${el.testId}"]` : ''
        const textStr = el.text ? `"${el.text}"` : ''
        console.log(`  • <${el.tag}> ${idStr} ${textStr} (bounds: ${el.bounds?.w}x${el.bounds?.h})`)
      }
      console.log('='.repeat(64) + '\n')
      client.close()
      process.exit(0)
    } catch (err) {
      console.error('[electron-mcp-bridge] State inspection failed:', err.message)
      client.close()
      process.exit(1)
    }
  }

  if (command === 'benchmark') {
    const channelName = argv[1]
    if (!channelName) {
      console.error('Usage: npx electron-mcp-bridge benchmark <channelName> [jsonArgs] [--iterations N]')
      process.exit(1)
    }

    let toolArgs = []
    if (argv[2] && !argv[2].startsWith('--')) {
      try {
        const parsed = JSON.parse(argv[2])
        toolArgs = Array.isArray(parsed) ? parsed : [parsed]
      } catch {
        toolArgs = [argv[2]]
      }
    }

    const iterations = Number(parseArg('--iterations') || 10)

    try {
      await client.connect()
    } catch (err) {
      console.error(`[electron-mcp-bridge] App not reachable at ${socketPath}`)
      process.exit(1)
    }

    try {
      const bench = await callToolRpc(client, 'app:benchmark_ipc', {
        channel: channelName,
        args: toolArgs,
        iterations,
      })

      console.log('\n' + '='.repeat(64))
      console.log(` IPC BENCHMARK: ${channelName}`)
      console.log('='.repeat(64))
      console.log(`• Iterations: ${bench.iterations} (Successful: ${bench.successfulRuns}, Failures: ${bench.failures})`)
      console.log(`• Mean Latency: ${bench.latencyMs.mean} ms`)
      console.log(`• p50 Latency:  ${bench.latencyMs.p50} ms`)
      console.log(`• p95 Latency:  ${bench.latencyMs.p95} ms`)
      console.log(`• p99 Latency:  ${bench.latencyMs.p99} ms`)
      console.log(`• Min / Max:    ${bench.latencyMs.min} ms / ${bench.latencyMs.max} ms`)
      if (bench.stallDetected) {
        console.log('  ⚠️  PERFORMANCE WARNING: p95 >= 50ms (Event loop stall threshold exceeded!)')
      } else {
        console.log('  ✅ PERFORMANCE BUDGET PASSED (p95 < 50ms)')
      }
      console.log('='.repeat(64) + '\n')
      client.close()
      process.exit(0)
    } catch (err) {
      console.error('[electron-mcp-bridge] Benchmark failed:', err.message)
      client.close()
      process.exit(1)
    }
  }

  if (command === 'tools') {
    try {
      await client.connect()
    } catch (err) {
      console.error(`[electron-mcp-bridge] App not reachable at ${socketPath}`)
      process.exit(1)
    }

    client.on('message', (msg) => {
      if (msg.id === 1) {
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

    try {
      const res = await callToolRpc(client, toolName, toolArgs)
      console.log(JSON.stringify(res, null, 2))
      client.close()
      process.exit(0)
    } catch (err) {
      console.error('[electron-mcp-bridge] Tool call failed:', err.message)
      client.close()
      process.exit(1)
    }
  }

  console.error(`Unknown command: '${command}'. Run with --help for usage.`)
  process.exit(1)
}

main().catch((err) => {
  console.error('[electron-mcp-bridge] Fatal error:', err)
  process.exit(1)
})
