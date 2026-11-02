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
const { verifyCommitment } = require('./v2/commitment');
const {
  GRACE_MS, DELAY_MS, MAX_RESCHEDULE_WINDOW_MS,
  originalKickoffOf, isUnstartedOverdue, canAutoReschedule, isOverdueBeyondRescheduleWindow
} = require('./auto-reschedule');
const { monthKey } = require('../football-store-shared');

const SWEEP_DEFAULTS = {
  schedulerMs: Number(process.env.FOOTBALL_SWEEP_MS) || 500,  // §15.2
  kickoffMs: 5000,                                            // §15.3
  stuckMs: 30000,                                             // §15.4
  seasonMs: 60000,                                            // §15.5
  ballonDorMs: 60000,                                         // Fase 4: lifecycle/odds/liquidación
  quinielaMs: 10000,                                          // Quiniela: recuperación de cartera + liquidación de jornadas
  pregameMs: 5000,                                            // Previa: una intervención cada pocos segundos
  degradedAfterMs: 10000                                      // §15.4: scheduler sin correr > 10 s ⇒ degraded
};

class FootballScheduler {
  constructor(engine, options = {}) {
    this.engine = engine;
    this.opts = { ...SWEEP_DEFAULTS, ...options };
    this.logEvent = options.logEvent || engine.logEvent || (() => {});
    this.ballonDorService = options.ballonDorService || null;
    this.quinielaService = options.quinielaService || null;
    this.pregameService = options.pregameService || null;
    this.officialV2 = options.officialV2 || null;
    this.kickoffPending = null;
    this.kickoffByMatch = new Map();
    this.upcomingPending = null;
    this.autoReschedulePending = null;
    this.rescheduleUnconfirmed = new Map();
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
            // Un compromiso dañado o aún sin confirmar requiere investigación o
            // persistencia, no posponer y reembolsar obligaciones automáticamente.
            if ((this.officialV2?.onlyV2 && !match.simulation)
                || (match.simulation && (match.simulationUnconfirmed || !verifyCommitment(match.simulation, match)))) {
              if (errores === this.engine.opts.quarantineAfter) {
                this.logEvent('football_v2_commitment_blocked', { match: match.id, seasonMonth: match.seasonMonth });
              }
            } else this.engine.quarantine(match, 'repeated_errors');
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
      // Un horizonte lento o un partido pendiente no deben cerrar la puerta
      // global de kickoff. La exclusión es por encuentro; nunca duplicamos una
      // preparación ni liberamos por timeout una escritura aún en curso.
      for (const match of this.engine.operationalMatches()) {
        const pending = this.kickoffByMatch.get(match.id);
        if (pending) {
          if (!pending.warned && now - pending.at >= this.opts.degradedAfterMs) {
            pending.warned = true;
            this.logEvent('football_kickoff_waiting', {
              match: match.id, homeId: match.homeId, awayId: match.awayId,
              seasonMonth: match.seasonMonth, ageMs: now - pending.at
            });
          }
          continue;
        }
        if (match.status !== 'scheduled' || match.scheduledKickoffAt > now || match.autoReschedulePending
            || isUnstartedOverdue(match, this.engine.store, now)) continue;
        const kickoffAt = match.scheduledKickoffAt;
        const startedAt = Date.now();
        const operation = { at: now, warned: false };
        operation.promise = Promise.resolve().then(async () => {
          const ready = await this.officialV2.prepareMatch(match, now);
          // Durante el await el watchdog puede haber reprogramado/asentado el
          // encuentro. No arrancar una preparación tardía con un reloj viejo.
          const resumedAt = now + Math.max(0, Date.now() - startedAt);
          if (match.status !== 'scheduled' || match.scheduledKickoffAt !== kickoffAt
              || match.autoReschedulePending || isUnstartedOverdue(match, this.engine.store, resumedAt)) return;
          if (ready.ok || (ready.legacy && !this.officialV2.onlyV2)) this.engine.startMatch(match, resumedAt);
          else this.logEvent('football_v2_kickoff_not_ready', {
            match: match.id, homeId: match.homeId, awayId: match.awayId,
            seasonMonth: match.seasonMonth, reason: ready.reason
          });
        }).catch(error => this.logEvent('football_kickoff_error', {
          match: match.id, homeId: match.homeId, awayId: match.awayId,
          seasonMonth: match.seasonMonth, message: String(error?.message || error)
        })).finally(() => { this.kickoffByMatch.delete(match.id); });
        this.kickoffByMatch.set(match.id, operation);
      }
      // Observabilidad/tests: esperar este lote no actúa como cerrojo global.
      const batch = Promise.all([...this.kickoffByMatch.values()].map(item => item.promise));
      if (!this.upcomingPending) {
        this.upcomingPending = Promise.resolve().then(() => this.officialV2.prepareUpcoming(now))
          .catch(error => this.logEvent('football_v2_kickoff_error', { message: String(error?.message || error) }))
          .then(() => this.engine.pregenerateUpcoming(now, this.engine.opts.pregenerateMs))
          .catch(error => this.logEvent('football_v2_kickoff_error', { message: String(error?.message || error) }))
          .finally(() => { this.upcomingPending = null; });
      }
      const sweep = Promise.all([batch, this.upcomingPending]);
      this.kickoffPending = sweep;
      sweep.finally(() => { if (this.kickoffPending === sweep) this.kickoffPending = null; });
      return { pending: true };
    }
    let arrancados = 0;
    const matches = this.engine.operationalMatches();
    for (const match of matches) {
      if (match.status === 'scheduled' && match.scheduledKickoffAt <= now && !match.autoReschedulePending
          && !isUnstartedOverdue(match, this.engine.store, now)) {
        try { if (this.engine.startMatch(match, now)) arrancados++; }
        catch (error) { this.logEvent('football_kickoff_error', { match: match.id, message: String(error?.message || error) }); }
      }
    }
    const pregenerados = this.engine.pregenerateUpcoming(now, this.engine.opts.pregenerateMs);
    return { arrancados, pregenerados };
  }

  // Se ejecuta aparte del kickoff: una preparación V2 colgada no detiene la
  // detección. Dentro de los primeros 30 minutos posteriores a la hora prevista
  // reprograma +30 min; superado ese margen obtiene y asienta los resultados sin
  // simular el encuentro en vivo.
  runAutoRescheduleSweep(now = Date.now()) {
    if (this.autoReschedulePending) return this.autoReschedulePending;
    const store = this.engine.store;
    if (!store || typeof store.saveStrict !== 'function' || typeof store.rescheduleMatch !== 'function') return Promise.resolve();
    if (store.writerLease && !store.writerLease.active) return Promise.resolve();
    this.autoReschedulePending = (async () => {
      const matches = this.engine.operationalMatches()
        .slice()
        .sort((a, b) => String(a.seasonMonth || '').localeCompare(String(b.seasonMonth || ''))
          || (a.jornada - b.jornada) || (a.scheduledKickoffAt - b.scheduledKickoffAt));
      for (const match of matches) {
        let pending = this.rescheduleUnconfirmed.get(match.id);
        if (pending && now - pending.originalKickoffAt > MAX_RESCHEDULE_WINDOW_MS) {
          match.scheduledKickoffAt = pending.oldKickoffAt;
          match.day = pending.previousDay;
          if (pending.previousAutoRescheduledAt != null) match.autoRescheduledAt = pending.previousAutoRescheduledAt;
          else delete match.autoRescheduledAt;
          if (pending.previousAutoRescheduleKickoffAt != null) {
            match.autoReschedulePreviousKickoffAt = pending.previousAutoRescheduleKickoffAt;
          } else delete match.autoReschedulePreviousKickoffAt;
          delete match.autoReschedulePending;
          delete match.autoReschedulePreviousDay;
          const league = store.getLeague?.(match.seasonMonth);
          league?.calendar?.matches?.sort((a, b) => (a.jornada - b.jornada) || (a.scheduledKickoffAt - b.scheduledKickoffAt));
          this.rescheduleUnconfirmed.delete(match.id);
          pending = null;
        }
        if (!pending && isOverdueBeyondRescheduleWindow(match, store, now, GRACE_MS, MAX_RESCHEDULE_WINDOW_MS)) {
          try {
            if (this.officialV2 && match.seasonMonth >= '2026-11'
                && (match.simulationUnconfirmed || (!match.simulation && (this.officialV2.onlyV2 || !this.officialV2.requiresLegacy(match))))) {
              const ready = await this.officialV2.prepareMatch(match, now);
              if (!ready.ok && !ready.legacy) {
                this.logEvent('football_overdue_settle_not_ready', { match: match.id, reason: ready.reason });
                continue;
              }
            }
            if (!match.simulation) {
              try { this.engine._freezeGenerationInputs(match); }
              catch (error) { this.logEvent('football_freeze_inputs_error', { match: match.id, message: String(error?.message || error) }); }
            }
            const delayMs = now - originalKickoffOf(match);
            const settled = this.engine.settleOverdueMatch(match, now);
            if (settled?.ok) {
              await store.saveStrict();
              this.logEvent('football_overdue_settled', {
                match: match.id, home: match.result.home, away: match.result.away, delayMs
              });
            }
            await new Promise(resolve => setImmediate(resolve));
          } catch (error) {
            this.logEvent('football_overdue_settle_error', { match: match.id, message: String(error?.message || error) });
          }
          continue;
        }
        if (!pending) {
          if (!canAutoReschedule(match, store, now, GRACE_MS, MAX_RESCHEDULE_WINDOW_MS)) continue;
          const newKickoffAt = now + DELAY_MS;
          // El calendario se indexa por mes: cruzar de temporada requiere una
          // intervención explícita, no ocultar el partido en otra liga.
          if (match.seasonMonth !== monthKey(new Date(now)) || match.seasonMonth !== monthKey(new Date(newKickoffAt))) {
            // Solo se registra cuando el cruce es inminente (mes en curso): los
            // encuentros de temporadas anteriores ya están fuera de ventana y se
            // liquidan por el camino de vencidos, sin repetir este aviso.
            if (match.seasonMonth === monthKey(new Date(now))) {
              this.logEvent('football_auto_reschedule_season_boundary', { match: match.id });
            }
            continue;
          }
          const oldKickoffAt = match.scheduledKickoffAt;
          const originalKickoffAt = originalKickoffOf(match);
          const previousAutoRescheduledAt = match.autoRescheduledAt ?? null;
          const previousAutoRescheduleKickoffAt = match.autoReschedulePreviousKickoffAt ?? null;
          const previousDay = match.day;
          Object.defineProperty(match, 'autoReschedulePending', { value: true, writable: true, configurable: true });
          Object.defineProperty(match, 'autoReschedulePreviousDay', { value: previousDay, configurable: true });
          match.autoRescheduledAt = now;
          match.autoReschedulePreviousKickoffAt = originalKickoffAt;
          const changed = store.rescheduleMatch(match.id, newKickoffAt, { seasonMonth: match.seasonMonth, now, deferSave: true });
          if (!changed.ok) {
            delete match.autoReschedulePending;
            delete match.autoReschedulePreviousDay;
            if (previousAutoRescheduledAt != null) match.autoRescheduledAt = previousAutoRescheduledAt;
            else delete match.autoRescheduledAt;
            if (previousAutoRescheduleKickoffAt != null) match.autoReschedulePreviousKickoffAt = previousAutoRescheduleKickoffAt;
            else delete match.autoReschedulePreviousKickoffAt;
            this.logEvent('football_auto_reschedule_error', { match: match.id, reason: changed.reason });
            continue;
          }
          pending = {
            oldKickoffAt, originalKickoffAt, newKickoffAt,
            previousDay, previousAutoRescheduledAt, previousAutoRescheduleKickoffAt
          };
          this.rescheduleUnconfirmed.set(match.id, pending);
        }
        try {
          if (!(await store.saveStrict())) throw new Error('persistencia_pendiente');
        } catch (error) {
          this.logEvent('football_auto_reschedule_persist_error', { match: match.id, message: String(error?.message || error) });
          continue;
        }
        delete match.autoReschedulePending;
        delete match.autoReschedulePreviousDay;
        this.rescheduleUnconfirmed.delete(match.id);
        if (match.status !== 'scheduled' || match.scheduledKickoffAt !== pending.newKickoffAt) continue;
        this.engine.rescheduleMatch(match, pending.newKickoffAt, { day: match.day, block: match.block, automatic: true });
        this.logEvent('football_auto_rescheduled', { match: match.id, oldKickoffAt: pending.oldKickoffAt, newKickoffAt: pending.newKickoffAt });
      }
    })().catch(error => this.logEvent('football_auto_reschedule_error', { message: String(error?.message || error) }))
      .finally(() => { this.autoReschedulePending = null; });
    return this.autoReschedulePending;
  }

  // §15.4 — 30 s: detecta y auto-repara anomalías. Cada caso es idempotente.
  runStuckSweep(now = Date.now()) {
    const acciones = { stalled: 0, forcedFinish: 0, degraded: false };
    for (const match of this.engine.operationalMatches()) {
      if (!LIVE_STATUSES.includes(match.status)) continue;
      try {
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
      } catch (error) {
        this.logEvent('football_stuck_match_error', {
          match: match.id, seasonMonth: match.seasonMonth, message: String(error?.message || error)
        });
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

  // §15.5 — 1 min: coordina la liga con la temporada del casino. Antes de rotar,
  // asienta todo partido vencido sin acta (de cualquier temporada) para que el mes
  // que sale no se cierre con un cruce de menos ni arrastre posiciones falsas al
  // siguiente. Si no se puede persistir, no se toca nada y se reintenta.
  async runSeasonSweep(now = Date.now()) {
    const store = this.engine.store;
    if (store?.writerLease && !store.writerLease.active) return { skipped: true };
    try {
      if (this.officialV2?.onlyV2 && this.officialV2.retireSeason) {
        const retired = await this.officialV2.retireSeason(store.getCurrentSeasonMonth());
        if (!retired.ok) this.logEvent('football_v1_retirement_pending', { reason: retired.reason });
      }
      if (typeof this.engine.repairOverdueMatches === 'function') {
        const repaired = await this.engine.repairOverdueMatches(now);
        if (repaired && (repaired.liquidados || repaired.recuperados)) {
          this.logEvent('football_overdue_repaired', repaired);
        }
      }
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

  // Previa de la cabina: la conversación de los comentaristas antes del saque
  // inicial. El servicio es idempotente por partido (mantiene su propia sesión),
  // así que correrlo de más solo evita repetir una intervención ya emitida.
  runPregameSweep(now = Date.now()) {
    if (!this.pregameService || typeof this.pregameService.tick !== 'function') return { skipped: true };
    try {
      return this.pregameService.tick(now);
    } catch (error) {
      this.logEvent('football_pregame_error', { message: String(error?.message || error) });
      return { ok: false };
    }
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
    arm('kickoff', this.opts.kickoffMs, (now) => { this.runAutoRescheduleSweep(now); this.runKickoffSweep(now); });
    arm('stuck', this.opts.stuckMs, (now) => this.runStuckSweep(now));
    arm('season', this.opts.seasonMs, (now) => this.runSeasonSweep(now));
    arm('ballonDor', this.opts.ballonDorMs, (now) => this.runBallonDorSweep(now));
    arm('quiniela', this.opts.quinielaMs, (now) => this.runQuinielaSweep(now));
    arm('pregame', this.opts.pregameMs, (now) => this.runPregameSweep(now));
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
