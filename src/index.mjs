import cjs from './index.cjs'

export const {
  setupMcpBridge,
  McpServer,
  DesktopGuardrails,
  SocketServer,
  SocketClient,
  StdioServer,
  getSocketPath,
  createBuiltinTools,
  protocol,
} = cjs

export default setupMcpBridge
