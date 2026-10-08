'use strict';

// Fase E4 — Configuración del Estadio MonteCristo (§17, decisión A6).
//
// Misma filosofía fail-closed que lib/admin-config.js: el flag nace APAGADO y, si
// se activa, loadFootballConfig() LANZA en el arranque cuando falta algo crítico.
// server.js la invoca junto a loadAdminConfig() (antes de instalar la red de
// uncaughtException), para que un error de configuración mate el proceso en vez de
// dejarlo zombi sin server.listen() (§12.7 hallazgo 5, A6, R26).
//
// El resto de parámetros FOOTBALL_* (ritmo de simulación, margins, límites, peso
// del flujo simulado, sweeps) los leen directamente del env los propios servicios
// (engine.js, scheduler.js, simulated-flow.js, betting.js, odds.js); aquí solo
// viven el flag, la ruta del store y el cupo de salas, más la validación crítica.

const path = require('path');

function flagOn(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return v === 'on' || v === 'true' || v === '1' || v === 'yes';
}

// Número positivo finito o el valor por defecto.
function posNum(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function loadFootballConfig(env = process.env) {
  const enabled = flagOn(env.FOOTBALL_ENABLED);
  const config = {
    enabled,
    storePath: env.FOOTBALL_STORE_PATH || path.join(process.cwd(), 'data', 'football.json'),
    sockets: {
      lobbyCapacity: posNum(env.FOOTBALL_LOBBY_CAPACITY, 200),
      matchCapacity: posNum(env.FOOTBALL_MATCH_CAPACITY, 40),
      betDelayMs: posNum(env.FOOTBALL_BET_DELAY_MS, 4000)
    }
  };

  if (!enabled) return config; // apagado: nada que validar, comportamiento por defecto intacto.

  // --- Validación fail-closed de lo crítico (§17). Solo con el flag activo. ---
  if (env.FOOTBALL_SIM_SECONDS_PER_MINUTE != null) {
    const spm = Number(env.FOOTBALL_SIM_SECONDS_PER_MINUTE);
    if (!Number.isFinite(spm) || spm <= 0) {
      throw new Error('Estadio: FOOTBALL_SIM_SECONDS_PER_MINUTE debe ser un número > 0 (fail-closed, §17).');
    }
  }
  if (env.FOOTBALL_MIN_MARGIN_INVARIANT != null) {
    const mm = Number(env.FOOTBALL_MIN_MARGIN_INVARIANT);
    if (!Number.isFinite(mm) || mm < 0 || mm > 0.2) {
      throw new Error('Estadio: FOOTBALL_MIN_MARGIN_INVARIANT fuera de rango [0, 0.2] (fail-closed, §17).');
    }
  }
  if (env.FOOTBALL_MAX_STAKE != null) {
    const ms = Number(env.FOOTBALL_MAX_STAKE);
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error('Estadio: FOOTBALL_MAX_STAKE debe ser un número > 0 (fail-closed, §17).');
    }
  }
  return config;
}

module.exports = { loadFootballConfig, flagOn };
