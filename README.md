# electron-mcp-bridge

[![npm version](https://img.shields.io/npm/v/electron-mcp-bridge.svg)](https://www.npmjs.com/package/electron-mcp-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

> **In-process Model Context Protocol (MCP) Server for Electron Desktop Applications.**  
> Connect AI Agents (Anthropic Claude Desktop, Google Antigravity, Cursor, Windsurf) directly to your running Electron app to inspect state, trigger actions, and verify on-disk oracles with zero runtime dependencies.

---

## The Problem in the Open-Source Ecosystem

In 2026, AI coding and execution agents interact with software via the **Model Context Protocol (MCP)**:
- **Web apps** have Playwright MCP and Puppeteer MCP.
- **Mobile apps** have Maestro MCP.
- **Desktop Electron apps** only had outside-in Chrome DevTools Protocol (CDP) wrappers.

Existing CDP wrappers (`@laststance/electron-mcp-server`, `playwright-mcp-electron`) suffer from three fundamental architectural flaws:
1. **Blind to the Node.js Main Process:** CDP only sees the Chromium renderer DOM. It cannot inspect SQLite databases, `ipcMain` channels, background worker threads, filesystem locks, or event-loop stalls.
2. **The "Green Click" Fallacy (The Oracle Deficit):** If an agent clicks a button and it turns blue, CDP says "passed"—even if the SQLite transaction rolled back or the file write hung.
3. **Cannot Attach to Running Desktop Sessions:** CDP wrappers require cold-launching an isolated browser window with debugging flags; developers cannot connect agents to their active, already-running desktop app.

---

## What `electron-mcp-bridge` Does

`electron-mcp-bridge` sits directly **inside your Electron main process**, bridging **BOTH** the Node.js backend and Chromium renderer:

```
  ┌────────────────────────────────────────────────────────────────┐
  │ AI Agents (Claude Desktop, Cursor, Windsurf, Antigravity)      │
  └───────────────────────────────┬────────────────────────────────┘
                                  │ stdio (JSON-RPC 2.0)
  ┌───────────────────────────────▼────────────────────────────────┐
  │ npx electron-mcp-bridge attach                                │
  └───────────────────────────────┬────────────────────────────────┘
                                  │ Unix Domain Socket / Pipe (0600)
  ┌───────────────────────────────▼────────────────────────────────┐
  │ Electron Application (Main Process)                            │
  │  ├── Desktop Safety Firewall & Redactor                        │
  │  ├── 6 Universal Tools (inspect_ipc, invoke_ipc, windows, etc) │
  │  ├── Application Verification Oracles (SQLite / Disk / DB)     │
  │  └── Performance Diagnostics (electron-workflow-observer)     │
  └───────────────────────────────┬────────────────────────────────┘
                                  │ webContents.executeJavaScript()
  ┌───────────────────────────────▼────────────────────────────────┐
  │ Chromium Renderer (DOM, Active Routes, Visual Paint)           │
  └────────────────────────────────────────────────────────────────┘
```

- **Zero Runtime Dependencies:** Pure Node.js standard library (`node:net`, `node:crypto`, `node:stream`).
- **Live App Attachment:** Attach Claude Desktop or Cursor to your already-running app with `npx electron-mcp-bridge attach`.
- **True Verification Oracles:** Run actions and assert that on-disk sidecars, database rows, and hash receipts actually changed.
- **Workflow Observer Synergy:** Directly exposes event-loop stall alerts and IPC latency bottlenecks from `electron-workflow-observer`.
- **Desktop Guardrails:** Built-in permission tiers (`query`, `action`, `destructive`) and sensitive token/home-path redaction.

---

## Installation

```bash
npm install electron-mcp-bridge
```

---

## Quick Start (1 Line in Electron)

In your `main.js` or `electron/main.ts`:

```typescript
const { setupMcpBridge } = require('electron-mcp-bridge')

// 1-line setup automatically opens a secure local domain socket:
setupMcpBridge({
  app,
  ipcMain,
  appName: 'my-desktop-app', // defaults to app.getName()
  enabled: process.env.NODE_ENV !== 'production' || process.env.ENABLE_MCP === '1',
})
```

---

## Connecting AI Agents

### 1. Claude Desktop

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "my-app": {
      "command": "npx",
      "args": ["electron-mcp-bridge", "attach", "--app", "my-desktop-app"]
    }
  }
}
```

Now, Claude Desktop can inspect your running Electron app, trigger commands, and verify data!

### 2. Cursor / Windsurf / Antigravity

In your agent's MCP configuration:

```json
{
  "mcpServers": {
    "my-app": {
      "command": "npx",
      "args": ["electron-mcp-bridge", "attach", "--app", "my-desktop-app"]
    }
  }
}
```

---

## Universal Built-in Tools

Every Electron app using `electron-mcp-bridge` immediately exposes 6 universal tools to agents:

| Tool | Tier | Description |
| :--- | :--- | :--- |
| `app:list_windows` | `query` | Enumerates all open `BrowserWindow` instances, bounds, active URLs, and focus states. |
| `app:inspect_ipc` | `query` | Lists registered `ipcMain` channels and handler counts. |
| `app:invoke_ipc` | `action` | Dispatches an invocation to an `ipcMain.handle()` channel and returns the result. |
| `app:eval_renderer` | `action` | Evaluates safe JavaScript inside the active window's `webContents`. |
| `app:capture_screenshot` | `query` | Captures the window or sub-rectangle and returns a base64 PNG image. |
| `app:get_diagnostics` | `query` | Returns process memory, CPU usage, and integrates with `electron-workflow-observer`. |

---

## Domain Oracles (The Killer Validation Feature)

In addition to universal tools, apps can declare application-specific oracles to prove **business effects** (SQLite rows, file sidecars, native metadata):

```typescript
setupMcpBridge({
  app,
  ipcMain,
  oracles: [
    {
      name: 'verify_xmp_oracle',
      description: 'Verifies on-disk .xmp sidecar exists, parses rating, and verifies SHA-256 hash',
      schema: {
        type: 'object',
        properties: { photoId: { type: 'string' } },
        required: ['photoId'],
      },
      handler: async ({ photoId }) => {
        const xmpPath = `/photos/${photoId}.xmp`
        const exists = fs.existsSync(xmpPath)
        const content = exists ? fs.readFileSync(xmpPath, 'utf8') : ''
        return {
          onDisk: exists,
          hasRating: content.includes('<xmp:Rating>5</xmp:Rating>'),
          bytes: content.length,
        }
      },
    },
  ],
})
```

Now an AI agent or test script can run:
```
tools/call { name: "verify_xmp_oracle", arguments: { photoId: "img_001" } }
```
And verify real disk persistence without guessing!

---

## Desktop Safety Firewall & Guardrails

To prevent agents from executing unintended destructive operations:

```typescript
setupMcpBridge({
  app,
  ipcMain,
  // Safety options:
  allowDestructive: false,    // Blocks destructive actions (default: false)
  allowActions: true,         // Allows idempotent mutations (default: true)
  allowedChannels: ['catalog:read', 'catalog:rate'], // Whitelist specific IPC channels
  blockedChannels: ['auth:login', 'crypto:keys'],     // Explicitly blocked channels
})
```

Tool outputs are automatically sanitized:
- User home directory paths (`/Users/username/...`) are redacted to `~/...`
- Common credentials, tokens, and secret keys are automatically replaced with `[REDACTED]`.

---

## CLI Utilities

```bash
# Attach stdio to running app (used by Claude Desktop / Cursor)
npx electron-mcp-bridge attach --app shotselect

# Inspect available tools from the command line
npx electron-mcp-bridge tools --app shotselect

# One-shot tool invocation
npx electron-mcp-bridge call app:list_windows --app shotselect
```

---

## License

MIT © 2026 Rudra Pratap Singh
