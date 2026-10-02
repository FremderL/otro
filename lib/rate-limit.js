'use strict';

class FixedWindowRateLimiter {
  constructor({ limit, windowMs, maxKeys = 10000, now = () => Date.now() }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.now = now;
    this.entries = new Map();
  }

  consume(key) {
    const now = this.now();
    const normalized = String(key || 'unknown').slice(0, 200);
    let entry = this.entries.get(normalized);
    if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + this.windowMs };
    entry.count += 1;
    // Reinserta al final para que el Map sirva como LRU aproximado.
    this.entries.delete(normalized);
    this.entries.set(normalized, entry);
    while (this.entries.size > this.maxKeys) this.entries.delete(this.entries.keys().next().value);
    return {
      allowed: entry.count <= this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      retryAfterMs: Math.max(0, entry.resetAt - now)
    };
  }
}

module.exports = { FixedWindowRateLimiter };
