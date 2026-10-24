'use strict'

const {
  RPC_ERRORS,
  MCP_PROTOCOL_VERSION,
  createResponse,
  createErrorResponse,
  createToolResult,
  validateSchema,
} = require('./protocol.cjs')

class McpServer {
  constructor(options = {}) {
    this.name = options.name || 'electron-mcp-bridge'
    this.version = options.version || '0.1.0'
    this.guardrails = options.guardrails
    this.tools = new Map()
    this.resources = new Map()
  }

  /**
   * Registers a tool callable by AI agents.
   */
  registerTool(tool) {
    if (!tool || typeof tool.name !== 'string') {
      throw new Error('Tool must have a valid string name')
    }
    if (typeof tool.handler !== 'function') {
      throw new Error(`Tool '${tool.name}' must have a handler function`)
    }

    this.tools.set(tool.name, {
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.schema || { type: 'object', properties: {} },
      tier: tool.tier || 'action',
      handler: tool.handler,
    })
  }

  /**
   * Registers a verification oracle (idempotent read-only verification tool).
   */
  registerOracle(name, description, schema, handler) {
    this.registerTool({
      name,
      description: `[Oracle] ${description}`,
      schema,
      tier: 'query',
      handler,
    })
  }

  /**
   * Registers a resource (URI-addressable data).
   */
  registerResource(resource) {
    if (!resource || typeof resource.uri !== 'string') {
      throw new Error('Resource must have a valid uri string')
    }
    if (typeof resource.handler !== 'function') {
      throw new Error(`Resource '${resource.uri}' must have a handler function`)
    }

    this.resources.set(resource.uri, {
      uri: resource.uri,
      name: resource.name || resource.uri,
      description: resource.description || '',
      mimeType: resource.mimeType || 'application/json',
      handler: resource.handler,
    })
  }

  /**
   * Dispatches an incoming JSON-RPC 2.0 message and returns the response.
   */
  async handleMessage(message) {
    if (!message || typeof message !== 'object') {
      return createErrorResponse(null, RPC_ERRORS.INVALID_REQUEST, 'Invalid request object')
    }

    const { id, method, params } = message

    // Notification check (no id)
    if (id === undefined || id === null) {
      if (method === 'notifications/initialized') {
        return null // Handshake acknowledgement
      }
      return null
    }

    try {
      switch (method) {
        case 'initialize': {
          return createResponse(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {
              tools: {},
              resources: {},
            },
            serverInfo: {
              name: this.name,
              version: this.version,
            },
          })
        }

        case 'ping': {
          return createResponse(id, {})
        }

        case 'tools/list': {
          const list = Array.from(this.tools.values()).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          }))
          return createResponse(id, { tools: list })
        }

        case 'tools/call': {
          if (!params || typeof params.name !== 'string') {
            return createErrorResponse(id, RPC_ERRORS.INVALID_PARAMS, "Missing required parameter 'name'")
          }

          const tool = this.tools.get(params.name)
          if (!tool) {
            return createErrorResponse(id, RPC_ERRORS.METHOD_NOT_FOUND, `Tool '${params.name}' not found`)
          }

          const args = params.arguments || {}
          const validation = validateSchema(tool.inputSchema, args)
          if (!validation.valid) {
            return createResponse(id, createToolResult(`Validation error: ${validation.error}`, true))
          }

          if (this.guardrails) {
            const perm = this.guardrails.checkPermission(tool.tier)
            if (!perm.allowed) {
              return createResponse(id, createToolResult(`Permission denied: ${perm.reason}`, true))
            }
          }

          try {
            const rawResult = await tool.handler(args)
            return createResponse(id, createToolResult(rawResult))
          } catch (execErr) {
            return createResponse(
              id,
              createToolResult(`Execution error in '${params.name}': ${execErr.message}`, true)
            )
          }
        }

        case 'resources/list': {
          const list = Array.from(this.resources.values()).map((r) => ({
            uri: r.uri,
            name: r.name,
            description: r.description,
            mimeType: r.mimeType,
          }))
          return createResponse(id, { resources: list })
        }

        case 'resources/read': {
          if (!params || typeof params.uri !== 'string') {
            return createErrorResponse(id, RPC_ERRORS.INVALID_PARAMS, "Missing required parameter 'uri'")
          }

          const resource = this.resources.get(params.uri)
          if (!resource) {
            return createErrorResponse(id, RPC_ERRORS.METHOD_NOT_FOUND, `Resource '${params.uri}' not found`)
          }

          try {
            const data = await resource.handler()
            const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
            return createResponse(id, {
              contents: [
                {
                  uri: resource.uri,
                  mimeType: resource.mimeType,
                  text,
                },
              ],
            })
          } catch (readErr) {
            return createErrorResponse(id, RPC_ERRORS.INTERNAL_ERROR, readErr.message)
          }
        }

        default:
          return createErrorResponse(id, RPC_ERRORS.METHOD_NOT_FOUND, `Method '${method}' not found`)
      }
    } catch (err) {
      return createErrorResponse(id, RPC_ERRORS.INTERNAL_ERROR, err.message)
    }
  }
}

module.exports = {
  McpServer,
}
