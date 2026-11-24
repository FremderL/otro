'use strict';

// Limitador de ventana fija en memoria (por proceso).
//
// Limitación conocida: al vivir en memoria, el contador se reinicia con cada
// deploy y no se comparte entre instancias. El casino es single-instance por
// diseño (ver README «Arquitectura: single-instance»), así que es aceptable;
// si se escala a varias instancias habrá que moverlo a Postgres/Redis.
//
// Corrección importante: cuando el mapa llega a maxKeys ya NO se expulsan
// claves existentes (eso permitía a un atacante inundar con claves únicas y
// «limpiar» los contadores legítimos). En su lugar, las claves nuevas se
// rechazan hasta que expire la ventana más antigua.

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
    if (!entry || entry.resetAt <= now) {
      // Ventana nueva. Si el mapa está lleno, primero se purgan las ventanas
      // ya expiradas; si sigue lleno, la clave nueva se rechaza (fail-closed)
      // en vez de expulsar a alguien que ya está siendo limitado.
      if (!entry && this.entries.size >= this.maxKeys) {
        for (const [k, v] of this.entries) {
          if (v.resetAt <= now) this.entries.delete(k);
        }
      }
      if (!entry && this.entries.size >= this.maxKeys) {
        return { allowed: false, remaining: 0, retryAfterMs: this.windowMs };
      }
      entry = { count: 0, resetAt: now + this.windowMs };
    }
    entry.count += 1;
    // Reinserta al final para que el Map sirva como LRU aproximado.
    this.entries.delete(normalized);
    this.entries.set(normalized, entry);
    return {
      allowed: entry.count <= this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      retryAfterMs: Math.max(0, entry.resetAt - now)
    };
  }
}

module.exports = { FixedWindowRateLimiter };
