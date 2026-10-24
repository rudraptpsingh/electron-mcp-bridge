'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert')
const os = require('node:os')
const { DesktopGuardrails } = require('../src/guardrails.cjs')

describe('Desktop Guardrails & Sanitization', () => {
  test('evaluates permissions for query, action, and destructive tiers', () => {
    const defaultGuard = new DesktopGuardrails()
    assert.strictEqual(defaultGuard.checkPermission('query').allowed, true)
    assert.strictEqual(defaultGuard.checkPermission('action').allowed, true)
    assert.strictEqual(defaultGuard.checkPermission('destructive').allowed, false)

    const permissiveGuard = new DesktopGuardrails({ allowDestructive: true })
    assert.strictEqual(permissiveGuard.checkPermission('destructive').allowed, true)

    const readOnlyGuard = new DesktopGuardrails({ allowActions: false })
    assert.strictEqual(readOnlyGuard.checkPermission('action').allowed, false)
  })

  test('enforces channel whitelisting and blacklisting', () => {
    const guard = new DesktopGuardrails({
      allowedChannels: ['catalog:read', 'catalog:rate'],
      blockedChannels: ['catalog:delete-all'],
    })

    assert.strictEqual(guard.checkPermission('action', 'catalog:read').allowed, true)
    assert.strictEqual(guard.checkPermission('action', 'catalog:delete-all').allowed, false)
    assert.strictEqual(guard.checkPermission('action', 'unlisted:channel').allowed, false)
    assert.strictEqual(guard.checkPermission('action', 'auth:login').allowed, false) // built-in block
  })

  test('sanitizes user home path, bearer tokens, and passwords', () => {
    const guard = new DesktopGuardrails()
    const home = os.homedir()

    const rawPayload = {
      projectPath: `${home}/Projects/Shoot-2026`,
      apiKey: 'secret_1234567890abcdef',
      password: 'superSecretPassword',
      headers: {
        authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummyPayloadToken',
      },
      nested: {
        cacheDir: `${home}/.cache/app`,
      },
    }

    const sanitized = guard.sanitize(rawPayload)
    assert.strictEqual(sanitized.projectPath, '~/Projects/Shoot-2026')
    assert.strictEqual(sanitized.apiKey, '[REDACTED]')
    assert.strictEqual(sanitized.password, '[REDACTED]')
    assert.match(sanitized.headers.authorization, /Bearer \[REDACTED\]/)
    assert.strictEqual(sanitized.nested.cacheDir, '~/.cache/app')
  })
})
