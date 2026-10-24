'use strict'

const os = require('node:os')

const HOME_DIR = os.homedir()

class DesktopGuardrails {
  constructor(options = {}) {
    this.allowDestructive = Boolean(options.allowDestructive)
    this.allowActions = options.allowActions !== false // default true
    this.allowedChannels = Array.isArray(options.allowedChannels) ? new Set(options.allowedChannels) : null
    this.blockedChannels = new Set([
      'auth:login',
      'auth:get-token',
      'credentials:get',
      'crypto:private-key',
      ...(options.blockedChannels || []),
    ])
    this.sanitizeOutputs = options.sanitizeOutputs !== false
  }

  /**
   * Evaluates if a tool execution is permitted under current guardrails.
   */
  checkPermission(tier = 'query', channelName = null) {
    if (tier === 'destructive' && !this.allowDestructive) {
      return {
        allowed: false,
        reason: 'Destructive action blocked. Enable allowDestructive in bridge configuration to execute.',
      }
    }

    if (tier === 'action' && !this.allowActions) {
      return {
        allowed: false,
        reason: 'Application actions are disabled in read-only mode.',
      }
    }

    if (channelName) {
      if (this.blockedChannels.has(channelName)) {
        return {
          allowed: false,
          reason: `IPC channel '${channelName}' is blocked by security policy.`,
        }
      }
      if (this.allowedChannels && !this.allowedChannels.has(channelName)) {
        return {
          allowed: false,
          reason: `IPC channel '${channelName}' is not in the allowed channels whitelist.`,
        }
      }
    }

    return { allowed: true }
  }

  /**
   * Sanitizes objects and strings to prevent leaking user home paths or sensitive tokens.
   */
  sanitize(value) {
    if (!this.sanitizeOutputs || value === null || value === undefined) return value

    if (typeof value === 'string') {
      let result = value
      if (HOME_DIR && HOME_DIR.length > 2) {
        result = result.replaceAll(HOME_DIR, '~')
      }
      // Redact potential Bearer tokens or API keys
      result = result.replace(/bearer\s+[a-zA-Z0-9_\-\.]{16,}/gi, 'Bearer [REDACTED]')
      result = result.replace(/(api[_-]?key|secret|password)\s*[:=]\s*['"]?[a-zA-Z0-9_\-\.]{8,}['"]?/gi, '$1: [REDACTED]')
      return result
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.sanitize(item))
    }

    if (typeof value === 'object') {
      const sanitized = {}
      for (const [key, val] of Object.entries(value)) {
        const lowerKey = key.toLowerCase()
        if (
          lowerKey.includes('password') ||
          lowerKey.includes('secret') ||
          lowerKey.includes('token') ||
          lowerKey.includes('apikey') ||
          lowerKey.includes('credential')
        ) {
          sanitized[key] = '[REDACTED]'
        } else {
          sanitized[key] = this.sanitize(val)
        }
      }
      return sanitized
    }

    return value
  }
}

module.exports = {
  DesktopGuardrails,
}
