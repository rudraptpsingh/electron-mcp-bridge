export interface ToolDefinition<T = any> {
  name: string
  description?: string
  schema?: Record<string, any>
  tier?: 'query' | 'action' | 'destructive'
  handler: (args: T) => Promise<any> | any
}

export interface OracleDefinition<T = any> {
  name: string
  description: string
  schema?: Record<string, any>
  handler: (args: T) => Promise<any> | any
}

export interface ResourceDefinition {
  uri: string
  name?: string
  description?: string
  mimeType?: string
  handler: () => Promise<any> | any
}

export interface SetupMcpBridgeOptions {
  app?: any
  ipcMain?: any
  BrowserWindow?: any
  appName?: string
  tools?: ToolDefinition[]
  oracles?: OracleDefinition[]
  resources?: ResourceDefinition[]
  allowDestructive?: boolean
  allowActions?: boolean
  allowedChannels?: string[] | null
  blockedChannels?: string[]
  transport?: 'socket' | 'stdio' | 'both'
  socketPath?: string
  getWorkflowObserver?: () => any
}

export interface McpBridgeInstance {
  server: any
  guardrails: any
  socketServer: any
  stdioServer: any
  registerTool: (tool: ToolDefinition) => void
  registerOracle: (name: string, description: string, schema?: Record<string, any>, handler?: (args: any) => any) => void
  registerResource: (resource: ResourceDefinition) => void
  handleMessage: (message: Record<string, any>) => Promise<Record<string, any> | null>
  stop: () => Promise<void>
}

export function setupMcpBridge(options?: SetupMcpBridgeOptions): McpBridgeInstance

export class McpServer {
  constructor(options?: { name?: string; version?: string; guardrails?: any })
  registerTool(tool: ToolDefinition): void
  registerOracle(name: string, description: string, schema: any, handler: any): void
  registerResource(resource: ResourceDefinition): void
  handleMessage(message: Record<string, any>): Promise<Record<string, any> | null>
}

export class DesktopGuardrails {
  constructor(options?: {
    allowDestructive?: boolean
    allowActions?: boolean
    allowedChannels?: string[] | null
    blockedChannels?: string[]
    sanitizeOutputs?: boolean
  })
  checkPermission(tier?: string, channelName?: string): { allowed: boolean; reason?: string }
  sanitize<T>(value: T): T
}

export class SocketServer {
  constructor(options?: { appName?: string; socketPath?: string })
  start(): Promise<string>
  broadcast(message: any): void
  stop(): Promise<void>
}

export class SocketClient {
  constructor(options?: { appName?: string; socketPath?: string })
  connect(): Promise<void>
  send(message: any): void
  close(): void
}

export class StdioServer {
  constructor(options?: { input?: any; output?: any })
  start(): void
  stop(): void
}

export function getSocketPath(appName?: string): string

export default setupMcpBridge
