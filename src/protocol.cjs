'use strict'

const { EventEmitter } = require('node:events')

const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
}

const MCP_PROTOCOL_VERSION = '2024-11-05'

/**
 * Split-stream line parser that handles chunked data and emits complete JSON-RPC messages.
 */
class LineDelimitedParser extends EventEmitter {
  constructor(options = {}) {
    super()
    this.maxFrameBytes = options.maxFrameBytes || 16 * 1024 * 1024 // 16 MB ceiling
    this.buffer = ''
  }

  write(chunk) {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (Buffer.byteLength(this.buffer) > this.maxFrameBytes) {
      this.buffer = ''
      this.emit('error', new Error('Protocol frame exceeded maximum buffer size'))
      return
    }

    while (this.buffer.includes('\n')) {
      const newlineIndex = this.buffer.indexOf('\n')
      const line = this.buffer.slice(0, newlineIndex).trim()
      this.buffer = this.buffer.slice(newlineIndex + 1)

      if (!line) continue

      try {
        const message = JSON.parse(line)
        if (message && typeof message === 'object') {
          this.emit('message', message)
        }
      } catch (err) {
        this.emit('error', new Error(`Invalid JSON frame: ${err.message}`))
      }
    }
  }

  reset() {
    this.buffer = ''
  }
}

function createResponse(id, result) {
  return {
    jsonrpc: '2.0',
    id: id !== undefined ? id : null,
    result: result || {},
  }
}

function createErrorResponse(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id: id !== undefined ? id : null,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  }
}

function createTextContent(text) {
  return {
    type: 'text',
    text: typeof text === 'string' ? text : JSON.stringify(text, null, 2),
  }
}

function createImageContent(base64Data, mimeType = 'image/png') {
  return {
    type: 'image',
    data: base64Data,
    mimeType,
  }
}

function createToolResult(content, isError = false) {
  const contentArray = Array.isArray(content)
    ? content
    : [typeof content === 'string' || (content && content.type) ? content : createTextContent(content)]

  return {
    content: contentArray.map((item) =>
      typeof item === 'string'
        ? createTextContent(item)
        : item && item.type
          ? item
          : createTextContent(item)
    ),
    ...(isError ? { isError: true } : {}),
  }
}

/**
 * Lightweight, zero-dependency schema validation for tool parameters.
 */
function validateSchema(schema, args) {
  if (!schema || typeof schema !== 'object') return { valid: true }

  const target = args && typeof args === 'object' ? args : {}

  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (target[key] === undefined || target[key] === null) {
        return { valid: false, error: `Missing required argument: '${key}'` }
      }
    }
  }

  if (schema.properties && typeof schema.properties === 'object') {
    for (const [key, prop] of Object.entries(schema.properties)) {
      const val = target[key]
      if (val === undefined || val === null) continue

      if (prop.type === 'string' && typeof val !== 'string') {
        return { valid: false, error: `Argument '${key}' must be a string` }
      }
      if (prop.type === 'number' && typeof val !== 'number') {
        return { valid: false, error: `Argument '${key}' must be a number` }
      }
      if (prop.type === 'boolean' && typeof val !== 'boolean') {
        return { valid: false, error: `Argument '${key}' must be a boolean` }
      }
      if (prop.type === 'array' && !Array.isArray(val)) {
        return { valid: false, error: `Argument '${key}' must be an array` }
      }
      if (prop.type === 'object' && (typeof val !== 'object' || Array.isArray(val))) {
        return { valid: false, error: `Argument '${key}' must be an object` }
      }
    }
  }

  return { valid: true }
}

module.exports = {
  RPC_ERRORS,
  MCP_PROTOCOL_VERSION,
  LineDelimitedParser,
  createResponse,
  createErrorResponse,
  createTextContent,
  createImageContent,
  createToolResult,
  validateSchema,
}
