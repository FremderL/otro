'use strict';

// Fase C — Scheduler y watchdogs (§15).
//
// Filosofía (§15.1), heredada de los barridos que ya funcionan en el casino:
//   1. Derivar, no acumular: nada crítico depende de que un timer dispare a tiempo.
//   2. setInterval de barrido, NUNCA cadenas de setTimeout: una cadena se rompe en
//      silencio; un barrido se recupera solo en la siguiente vuelta.
//   3. Aislar por partido: cada uno va en su try/catch. Un partido raro se pierde;
//      el motor y los otros 11 siguen.
//
// Los cuatro barridos son síncronos y se pueden invocar directamente (runX(now))
// para probarlos sin timers reales; start() los engancha a setInterval con unref()
// para que nunca mantengan vivo el proceso.

const { LIVE_STATUSES } = require('./engine');

const SWEEP_DEFAULTS = {
  schedulerMs: Number(process.env.FOOTBALL_SWEEP_MS) || 500,  // §15.2
  kickoffMs: 5000,                                            // §15.3
  stuckMs: 30000,                                             // §15.4
  seasonMs: 60000,                                            // §15.5
  ballonDorMs: 60000,                                         // Fase 4: lifecycle/odds/liquidación
  quinielaMs: 10000,                                          // Quiniela: recuperación de cartera + liquidación de jornadas
  degradedAfterMs: 10000                                      // §15.4: scheduler sin correr > 10 s ⇒ degraded
};

class FootballScheduler {
  constructor(engine, options = {}) {
    this.engine = engine;
    this.opts = { ...SWEEP_DEFAULTS, ...options };
    this.logEvent = options.logEvent || engine.logEvent || (() => {});
    this.ballonDorService = options.ballonDorService || null;
    this.quinielaService = options.quinielaService || null;
    this.officialV2 = options.officialV2 || null;
    this.kickoffPending = null;
    this.timers = {};
    this.sweepRunning = false;   // anti-reentrancia del barrido principal (§15.2)
    this.lastSweepAt = 0;        // marca de tiempo del último ciclo (degraded, §15.4)
    this.started = false;
  }

  // --- Barridos (síncronos, testeables) ---

  // §15.2 — 500 ms: deriva y revela el estado de los partidos en juego.
  runSchedulerSweep(now = Date.now()) {
    if (this.sweepRunning) return { skipped: true }; // una vuelta tarda de más ⇒ no apilar
    this.sweepRunning = true;
    this.lastSweepAt = now;
    this.engine.lastSweepAt = now;
    let avanzados = 0;
    try {
      this.engine.ensureTodayScheduled(now);
      for (const match of this.engine.active()) {
        try {
          this.engine.advance(match, now);
          this.engine.clearError(match);
          avanzados++;
        } catch (error) {
          // Aislar por partido (§15.1 regla 3): se registra y, si reincide, cuarentena.
          this.logEvent('football_match_error', { match: match.id, message: String(error?.message || error) });
          const errores = this.engine.recordError(match);
          if (errores >= this.engine.opts.quarantineAfter) {
            this.engine.quarantine(match, 'repeated_errors');
          }
        }
      }
    } catch (error) {
      this.logEvent('football_scheduler_error', { message: String(error?.message || error) });
    } finally {
      this.sweepRunning = false;
    }
    return { avanzados };
  }

  // §15.3 — 5 s: arranca los partidos cuya hora llegó y pre-genera el bloque siguiente.
  runKickoffSweep(now = Date.now()) {
    if (this.officialV2) {
      if (this.kickoffPending) return { skipped: true };
      this.kickoffPending = (async () => {
        // Primero los encuentros que ya deben arrancar: preparar el resto del
        // horizonte no debe retrasarlos ni impedirlos si falla otro partido.
        for (const match of this.engine.operationalMatches()) {
          if (match.status !== 'scheduled' || match.scheduledKickoffAt > now) continue;
          try {
            const ready = await this.officialV2.prepareMatch(match, now);
            if (ready.ok || ready.legacy) this.engine.startMatch(match, now);
            else this.logEvent('football_v2_kickoff_not_ready', { match: match.id, reason: ready.reason });
          } catch (error) { this.logEvent('football_kickoff_error', { match: match.id, message: String(error?.message || error) }); }
        }
        try { await this.officialV2.prepareUpcoming(now); }
        catch (error) { this.logEvent('football_v2_kickoff_error', { message: String(error?.message || error) }); }
        this.engine.pregenerateUpcoming(now, this.engine.opts.pregenerateMs);
      })().catch(error => this.logEvent('football_v2_kickoff_error', { message: String(error?.message || error) }))
        .finally(() => { this.kickoffPending = null; });
      return { pending: true };
    }
    let arrancados = 0;
    const matches = this.engine.operationalMatches();
    for (const match of matches) {
      if (match.status === 'scheduled' && match.scheduledKickoffAt <= now) {
        try { if (this.engine.startMatch(match, now)) arrancados++; }
        catch (error) { this.logEvent('football_kickoff_error', { match: match.id, message: String(error?.message || error) }); }
      }
    }
    const pregenerados = this.engine.pregenerateUpcoming(now, this.engine.opts.pregenerateMs);
    return { arrancados, pregenerados };
  }

  // §15.4 — 30 s: detecta y auto-repara anomalías. Cada caso es idempotente.
  runStuckSweep(now = Date.now()) {
    const acciones = { stalled: 0, forcedFinish: 0, degraded: false };
    for (const match of this.engine.operationalMatches()) {
      if (!LIVE_STATUSES.includes(match.status)) continue;
      const rt = this.engine.runtime.get(match.id);

      // live sin tick hace > stallMs ⇒ re-derivar estado completo desde el seed.
      if (rt && rt.lastTickAt && now - rt.lastTickAt > this.engine.opts.stallMs) {
        this.engine.rederive(match, now);
        this.logEvent('football_match_stalled', { match: match.id, ageMs: now - rt.lastTickAt });
        acciones.stalled++;
        continue; // re-derive ya lo deja al día
      }

      // live más allá del límite ⇒ forzar finished con el marcador derivado.
      const deadline = this.engine.forceFinishDeadline(match);
      if (deadline && now > deadline) {
        this.engine.forceFinish(match, now);
        this.logEvent('football_match_forced_finish', { match: match.id });
        acciones.forcedFinish++;
      }
    }

    // Reconcilia escrow periódicamente: liquida apuestas/parlays abiertas cuyo
    // partido ya terminó aunque el barrido normal las hubiera saltado (servidor
    // dormido, jugador ausente, etc.). Idempotente: no repaga.
    try { if (typeof this.engine.reconcileEscrow === 'function') this.engine.reconcileEscrow(); } catch (e) { this.logEvent('football_escrow_reconcile_error', { message: String(e && e.message || e) }); }

    // El barrido principal sin correr hace > 10 s ⇒ motor degradado (§15.4).
    if (this.lastSweepAt && now - this.lastSweepAt > this.opts.degradedAfterMs) {
      this.engine.degraded = true;
      acciones.degraded = true;
      this.logEvent('football_engine_degraded', { ageMs: now - this.lastSweepAt });
    } else {
      this.engine.degraded = false;
    }
    return acciones;
  }

  // §15.5 — 1 min: coordina la liga con la temporada del casino. En Fase C asegura
  // el mes en curso; el cierre con desempate/prórroga y la política de apagón
  // (comprimir/truncar, §15.9) los completa la Fase F sobre estos mismos hooks.
  runSeasonSweep(now = Date.now()) {
    try {
      this.engine.ensureTodayScheduled(now);
      const league = this.engine.store.getLeague();
      if (league) this.logEvent('football_season_guard', { seasonMonth: league.seasonMonth, status: league.status });
    } catch (error) {
      this.logEvent('football_season_guard_error', { message: String(error?.message || error) });
    }
    return {};
  }

  // Barrido de ciclo BDO (1 min): el servicio es idempotente y el cierre J20
  // además se ejecuta atómicamente al asentarse el último partido en el store.
  runBallonDorSweep(now = Date.now()) {
    if (!this.ballonDorService || typeof this.ballonDorService.sweep !== 'function') return { skipped: true };
    return this.ballonDorService.sweep(now).catch(error => {
      this.logEvent('football_ballon_dor_sweep_error', { message: String(error?.message || error) });
      return { ok: false };
    });
  }

  // Quiniela: barrido de recuperación de cartera + liquidación derive-not-accumulate.
  // El servicio es idempotente (operationId por movimiento), así que correrlo en
  // cada vuelta repara un crash pendiente sin pagar nada dos veces.
  runQuinielaSweep(now = Date.now()) {
    if (!this.quinielaService || typeof this.quinielaService.sweep !== 'function') return { skipped: true };
    return this.quinielaService.sweep(now).catch(error => {
      this.logEvent('football_quiniela_sweep_error', { message: String(error?.message || error) });
      return { ok: false };
    });
  }

  // --- Ciclo de vida ---

  start() {
    if (this.started) return this;
    this.started = true;
    const arm = (name, ms, fn) => {
      const timer = setInterval(() => fn(Date.now()), ms);
      timer.unref?.(); // nunca mantiene vivo el proceso
      this.timers[name] = timer;
    };
    arm('scheduler', this.opts.schedulerMs, (now) => this.runSchedulerSweep(now));
    arm('kickoff', this.opts.kickoffMs, (now) => this.runKickoffSweep(now));
    arm('stuck', this.opts.stuckMs, (now) => this.runStuckSweep(now));
    arm('season', this.opts.seasonMs, (now) => this.runSeasonSweep(now));
    arm('ballonDor', this.opts.ballonDorMs, (now) => this.runBallonDorSweep(now));
    arm('quiniela', this.opts.quinielaMs, (now) => this.runQuinielaSweep(now));
    return this;
  }

  stop() {
    for (const timer of Object.values(this.timers)) clearInterval(timer);
    this.timers = {};
    this.started = false;
    return this;
  }
}

module.exports = { FootballScheduler, SWEEP_DEFAULTS };
