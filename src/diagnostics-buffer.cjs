'use strict'

const v8 = require('node:v8')

class DiagnosticsBuffer {
  constructor(options = {}) {
    this.maxEntries = options.maxEntries || 100
    this.errors = []
    this.ipcMetrics = new Map() // channel -> { count, totalMs, maxMs, minMs, failures, slowCalls: [] }
    this.guardrails = options.guardrails
    this.startedAt = Date.now()
  }

  recordError(entry) {
    if (this.errors.length >= this.maxEntries) {
      this.errors.shift()
    }
    this.errors.push({
      time: Date.now(),
      type: entry.type || 'error',
      message: entry.message || 'Unknown error',
      stack: entry.stack ? String(entry.stack).split('\n').slice(0, 10).join('\n') : undefined,
      metadata: entry.metadata ? this.guardrails?.sanitize(entry.metadata) : undefined,
    })
  }

  recordIpcCall(channel, durationMs, success = true, callerStack = null) {
    let stat = this.ipcMetrics.get(channel)
    if (!stat) {
      stat = {
        channel,
        count: 0,
        failures: 0,
        totalMs: 0,
        maxMs: 0,
        minMs: Number.POSITIVE_INFINITY,
        recentSlow: [],
      }
      this.ipcMetrics.set(channel, stat)
    }

    stat.count++
    stat.totalMs += durationMs
    if (durationMs > stat.maxMs) stat.maxMs = durationMs
    if (durationMs < stat.minMs) stat.minMs = durationMs
    if (!success) stat.failures++

    if (durationMs >= 50 && stat.recentSlow.length < 10) {
      stat.recentSlow.push({
        durationMs,
        time: Date.now(),
        callerStack: callerStack ? callerStack.slice(0, 6) : undefined,
      })
    }
  }

  getChannelStats(channelFilter = null) {
    const list = []
    for (const [ch, stat] of this.ipcMetrics.entries()) {
      if (!channelFilter || ch.toLowerCase().includes(channelFilter.toLowerCase())) {
        list.push({
          channel: ch,
          invocations: stat.count,
          failures: stat.failures,
          avgMs: stat.count > 0 ? Number((stat.totalMs / stat.count).toFixed(2)) : 0,
          minMs: stat.minMs === Number.POSITIVE_INFINITY ? 0 : stat.minMs,
          maxMs: stat.maxMs,
          recentSlowCount: stat.recentSlow.length,
        })
      }
    }
    return list.sort((a, b) => b.invocations - a.invocations)
  }

  getV8HeapMetrics() {
    const heapStats = v8.getHeapStatistics ? v8.getHeapStatistics() : {}
    return {
      totalHeapMb: Math.round((heapStats.total_heap_size || 0) / (1024 * 1024)),
      usedHeapMb: Math.round((heapStats.used_heap_size || 0) / (1024 * 1024)),
      heapLimitMb: Math.round((heapStats.heap_size_limit || 0) / (1024 * 1024)),
      numberOfNativeContexts: heapStats.number_of_native_contexts || 0,
      numberOfDetachedContexts: heapStats.number_of_detached_contexts || 0,
      detachedContextWarning: (heapStats.number_of_detached_contexts || 0) > 0,
    }
  }
}

module.exports = {
  DiagnosticsBuffer,
}
