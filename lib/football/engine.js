'use strict';

// Fase C — Motor de ejecución (§15).
//
// Un partido NUNCA es un proceso: es una función pura estado = f(seed, now)
// (§3.2). Este módulo no «reproduce» nada en tiempo real; deriva el estado
// evaluando el reloj de simulación contra la línea de tiempo determinista que
// genera el motor de Fase B. De ahí salen las tres propiedades que responden a
// «evitar errores por inactividad del sistema»:
//
//   · Idempotencia — correr el cálculo dos veces da lo mismo; un barrido perdido
//     no deja huecos y uno duplicado no corrompe (T5).
//   · Catch-up gratis — si el proceso estuvo caído, al volver se revela de golpe
//     el prefijo acumulado; nada se pierde (T5/T6).
//   · Reinicio transparente — basta el seed y now para reconstruir minuto,
//     marcador y eventos (T6).
//
// La línea de tiempo NO se persiste (§13.2): se regenera desde el seed y se
// cachea en memoria. El resultado, una vez asentado, sí se persiste y es la
// fuente autoritativa (por si una regeneración divergiera, §15.4).
//
// Las apuestas (liquidación/escrow) y el cierre de temporada con desempate son
// hooks que rellenan las Fases D y F; aquí quedan como funciones inyectables
// para que el scheduler sea autónomo y testeable sin ellas.

const { EventEmitter } = require('node:events');
const { mulberry32 } = require('./prng');
const { generateTimeline, deriveState } = require('./match-engine');
const { monthKey, calendarParts } = require('../football-store-shared');

// Estados en juego (no terminales y ya iniciados).
const LIVE_STATUSES = ['live', 'halftime', 'extra_time', 'shootout'];
// Estados que ya no se procesan en el barrido.
const TERMINAL_STATUSES = ['settled', 'postponed'];

const DEFAULTS = {
  secondsPerMinute: Number(process.env.FOOTBALL_SIM_SECONDS_PER_MINUTE) || 10, // 10 s reales por minuto simulado
  halftimeMs: Number(process.env.FOOTBALL_HALFTIME_MS) || 45000,               // intermedio real (el reloj sim se pausa)
  tickIntervalMs: 2000,          // §15.2: football:tick como mucho cada 2 s
  stallMs: 15000,                // §15.4: live sin tick hace > 15 s ⇒ re-derivar
  maxKickoffDelayMs: 120000,     // §15.3: kickoff con > 120 s de retraso ⇒ late_kickoff
  forceFinishMs: 45 * 60 * 1000, // §15.4: live más de 45 min reales ⇒ forzar finished
  finishGraceMs: 60000,          // holgura sobre la duración natural antes del backstop
  quarantineAfter: 3,            // §15.4: 3 errores seguidos ⇒ cuarentena (T14)
  pregenerateMs: 5 * 60 * 1000   // §15.3: pre-generar el bloque siguiente 5 min antes
};

// Reloj de simulación: convierte el instante de pared `now` al minuto simulado
// continuo (el mismo `t` de la línea de tiempo), pausando el reloj durante el
// intermedio real. Devuelve también la fase para mapear a status.
function matchClock(now, kickoffAt, clock, opts) {
  const msPerMin = opts.secondsPerMinute * 1000;
  const elapsed = now - kickoffAt;
  if (elapsed <= 0) return { minute: 0, phase: 'pre', ended: false };
  const firstHalfRealMs = clock.firstHalfEnd * msPerMin;
  if (elapsed < firstHalfRealMs) return { minute: elapsed / msPerMin, phase: 'first_half', ended: false };
  const afterHalf = elapsed - firstHalfRealMs;
  if (afterHalf < opts.halftimeMs) return { minute: clock.firstHalfEnd, phase: 'halftime', ended: false };
  const minute = clock.firstHalfEnd + (afterHalf - opts.halftimeMs) / msPerMin;
  if (minute >= clock.matchEnd) return { minute: clock.matchEnd, phase: 'ended', ended: true };
  if (clock.shootoutStart != null && minute >= clock.shootoutStart) return { minute, phase: 'shootout', ended: false };
  if (clock.extraTimeStart != null && minute >= clock.extraTimeStart) return { minute, phase: 'extra_time', ended: false };
  return { minute, phase: 'second_half', ended: false };
}

function phaseToStatus(phase) {
  if (phase === 'first_half' || phase === 'second_half') return 'live';
  if (phase === 'halftime') return 'halftime';
  if (phase === 'extra_time') return 'extra_time';
  if (phase === 'shootout') return 'shootout';
  if (phase === 'ended') return 'finished';
  return null; // 'pre' ⇒ sigue 'scheduled'
}

function deriveAtClock(result, clk) {
  let throughIndex = Infinity;
  if (clk.phase === 'pre') throughIndex = -1; // el kickoff t=0 aún no es público
  if (clk.phase === 'halftime') {
    const halftime = result.timeline.find(event => event.type === 'halftime' && event.t <= clk.minute);
    if (halftime) throughIndex = halftime.i;
  }
  return deriveState(result.timeline, clk.minute, result.lineups, throughIndex);
}

class FootballEngine extends EventEmitter {
  // store: FootballStore (Fase A). options: sobreescribe DEFAULTS + hooks.
  constructor(store, options = {}) {
    super();
    this.store = store;
    this.opts = { ...DEFAULTS, ...options };
    // Estado de ejecución por partido, NO persistido (se re-deriva del seed).
    this.runtime = new Map(); // matchId → { result, revealedIndex, lastTickAt, errorCount, quarantined, replay }
    this.lastSweepAt = 0;
    this.degraded = false;

    // --- Hooks inyectables (Fase D: apuestas; Fase F: temporada) ---
    this.logEvent = options.logEvent || (() => {});
    this.settleBets = options.settleBets || (() => {});       // pagar apuestas al terminar
    this.refundBets = options.refundBets || (() => {});       // reembolsar al posponer
    this.cancelPendingBets = options.cancelPendingBets || (() => 0); // §15.6 paso 4b
    this.reconcileEscrow = options.reconcileEscrow || (() => 0);     // §15.6 paso 7b
    this.hasOpenBets = options.hasOpenBets || (() => false);  // A7: gate del reset mensual
    this.countOpenBets = options.countOpenBets || (() => 0);  // §15.8
    this.countEscrow = options.countEscrow || (() => 0);      // §15.8
  }

  // --- Caché de línea de tiempo ---

  _runtime(match) {
    let rt = this.runtime.get(match.id);
    if (!rt) {
      rt = { result: null, revealedIndex: -1, lastTickAt: 0, errorCount: 0, quarantined: false, replay: false };
      this.runtime.set(match.id, rt);
    }
    return rt;
  }

  // Genera (una sola vez por proceso) la línea de tiempo desde el seed del
  // partido y los ratings vigentes de la liga. §3.3: el mismo modelo que fija las
  // cuotas. Se cachea; el resultado asentado es la fuente autoritativa (§15.4).
  _ensureTimeline(match) {
    const rt = this._runtime(match);
    if (rt.result) return rt.result;
    const league = this.store.getLeague(match.seasonMonth);
    if (!league) throw new Error(`sin temporada para ${match.seasonMonth}`);
    const home = league.config.find(c => c.id === match.homeId);
    const away = league.config.find(c => c.id === match.awayId);
    if (!home || !away) throw new Error(`clubes no encontrados para ${match.id}`);
    const ctx = league.ctx || {};
    const result = generateTimeline(home, away, {
      leagueAvg: ctx.leagueAvg, homeAdv: ctx.homeAdv, rho: ctx.rho,
      esDesempate: Boolean(match.desempate)
    }, mulberry32(match.seed));
    rt.result = result;
    return result;
  }

  // Descarta la caché de un partido (para re-derivar desde cero, §15.4).
  invalidate(matchId) {
    const rt = this.runtime.get(matchId);
    if (rt) rt.result = null;
  }

  // --- Lectura de estado (pura: f(seed, now)) ---

  // Deriva el estado público de un partido en `now` sin emitir nada. Base de T5/T6.
  // Devuelve SOLO lo revelable (state al minuto, índice revelado): ni el marcador
  // final ni la línea completa, para no fugar el futuro por accidente (T7/§3.2).
  deriveMatchState(match, now) {
    const result = this._ensureTimeline(match);
    const clk = matchClock(now, match.scheduledKickoffAt, result.clock, this.opts);
    const { state, revealedIndex } = deriveAtClock(result, clk);
    return { minute: clk.minute, phase: clk.phase, ended: clk.ended, matchEnd: result.clock.matchEnd, state, revealedIndex };
  }

  // Partidos en juego (no terminales, ya iniciados, no en cuarentena).
  active() {
    return this.store.getMatches().filter(m => LIVE_STATUSES.includes(m.status) && !this._runtime(m).quarantined);
  }

  // Límite tras el cual un partido 'live' se fuerza a terminar (§15.4). Se adapta
  // al ritmo: max(45 min reales, duración natural + holgura).
  forceFinishDeadline(match) {
    const result = this._ensureTimeline(match);
    const naturalEndMs = result.clock.matchEnd * this.opts.secondsPerMinute * 1000 + this.opts.halftimeMs;
    return match.scheduledKickoffAt + Math.max(this.opts.forceFinishMs, naturalEndMs + this.opts.finishGraceMs);
  }

  // --- Ciclo de vida del partido ---

  ensureTodayScheduled(now = Date.now()) {
    // La temporada completa se pre-genera al crearla; asegurar el mes en curso
    // basta para que la jornada de hoy exista (§15.6 paso 1-2).
    return this.store.ensureSeason(new Date(now));
  }

  // Pre-genera las líneas de tiempo de los partidos que arrancan en breve, para
  // que el kickoff no pague la generación en el camino caliente (§15.3).
  pregenerateUpcoming(now = Date.now(), aheadMs = this.opts.pregenerateMs) {
    let n = 0;
    for (const match of this.store.getMatches()) {
      if (match.status !== 'scheduled') continue;
      if (match.scheduledKickoffAt > now && match.scheduledKickoffAt <= now + aheadMs) {
        try { this._ensureTimeline(match); n++; }
        catch (error) { this.logEvent('football_pregenerate_error', { match: match.id, message: String(error?.message || error) }); }
      }
    }
    return n;
  }

  // scheduled → live. Ancla el reloj en scheduledKickoffAt (pre-comprometido), de
  // modo que un kickoff tardío arranca en el minuto que corresponde (§15.3).
  startMatch(match, now = Date.now()) {
    if (match.status !== 'scheduled') return false;
    if (now < match.scheduledKickoffAt) return false; // no arranca antes de hora (la puerta también vive en el kickoff sweep)
    const result = this._ensureTimeline(match);
    const clk = matchClock(now, match.scheduledKickoffAt, result.clock, this.opts);
    match.actualKickoffAt = now;
    match.status = 'live';
    const rt = this._runtime(match);
    rt.lastTickAt = now;
    const late = now - match.scheduledKickoffAt > this.opts.maxKickoffDelayMs;
    this.emit('football:status', { matchId: match.id, code: late ? 'late_kickoff' : 'kickoff', minute: clk.minute });
    if (late) this.logEvent('football_late_kickoff', { match: match.id, minute: Math.round(clk.minute), delayMs: now - match.scheduledKickoffAt });
    return true;
  }

  // Corazón del barrido: deriva el estado, revela el prefijo pendiente, actualiza
  // status, emite tick y asienta al terminar. Idempotente (T5).
  advance(match, now = Date.now()) {
    const rt = this._runtime(match);
    if (rt.quarantined || TERMINAL_STATUSES.includes(match.status) || match.status === 'settled') return null;
    const result = this._ensureTimeline(match);
    const clk = matchClock(now, match.scheduledKickoffAt, result.clock, this.opts);
    const { state, revealedIndex } = deriveAtClock(result, clk);

    // Revela los eventos pendientes desde el último índice (catch-up en lote).
    if (revealedIndex > rt.revealedIndex) {
      const fresh = result.timeline.slice(rt.revealedIndex + 1, revealedIndex + 1);
      const catchUp = fresh.length > 1;
      for (const event of fresh) {
        this.emit('football:event', { matchId: match.id, event, catchUp, replay: rt.replay });
        if (event.type === 'goal' || event.type === 'penalty_scored') {
          this.emit('football:goal', { matchId: match.id, event, replay: rt.replay });
        }
      }
      rt.revealedIndex = revealedIndex;
      rt.replay = false; // lo revelado como replay ya no se repite en tiempo real
    }

    // Actualiza el status según la fase.
    const next = phaseToStatus(clk.phase);
    if (next && match.status !== next && match.status !== 'settled') {
      match.status = next;
      this.emit('football:status', { matchId: match.id, code: next, minute: clk.minute });
    }

    // Tick posicional (agrupa eventos de baja relevancia, §15.2).
    if (now - rt.lastTickAt >= this.opts.tickIntervalMs) {
      this.emit('football:tick', { matchId: match.id, state, minute: clk.minute, matchEnd: result.clock.matchEnd });
      rt.lastTickAt = now;
    }
    rt.lastMinute = clk.minute;
    rt.lastState = state;

    // Terminó ⇒ asentar el resultado (actualiza tabla y ratings vía store).
    if (clk.ended && match.status !== 'settled') {
      this._settleResult(match, result.score, now);
    }
    return { state, revealedIndex, minute: clk.minute, phase: clk.phase, ended: clk.ended };
  }

  // Re-deriva el estado completo desde el seed (auto-reparación de §15.4). NO
  // toca revealedIndex: el próximo advance revela solo lo pendiente durante el
  // atasco (catch-up), sin re-emitir el pasado ya visible.
  rederive(match, now = Date.now()) {
    const rt = this._runtime(match);
    rt.result = null;       // fuerza regeneración desde el seed
    const derived = this.deriveMatchState(match, now);
    rt.lastTickAt = now;
    rt.lastMinute = derived.minute;
    rt.lastState = derived.state;
    return derived;
  }

  _settleResult(match, score, now) {
    match.status = 'finished';
    const out = this.store.settleMatch(match.id, { home: score.home, away: score.away }, { seasonMonth: match.seasonMonth, now });
    if (out && out.ok) {
      this.settleBets(match, score); // hook Fase D
      this.emit('football:status', { matchId: match.id, code: 'full_time', score });
      this.logEvent('football_match_finished', { match: match.id, home: score.home, away: score.away });
    } else {
      this.logEvent('football_settle_failed', { match: match.id, reason: out && out.reason });
    }
    return out;
  }

  // Fuerza el final de un partido 'live' atascado con el marcador derivado (§15.4).
  forceFinish(match, now = Date.now()) {
    const result = this._ensureTimeline(match);
    return this._settleResult(match, result.score, now);
  }

  // --- Errores y cuarentena (T14) ---

  recordError(match) {
    const rt = this._runtime(match);
    rt.errorCount++;
    return rt.errorCount;
  }

  clearError(match) {
    const rt = this._runtime(match);
    rt.errorCount = 0;
  }

  // Saca al partido del ciclo sin tocar a los demás (§15.1 regla 3, §15.4).
  quarantine(match, reason = 'error') {
    const rt = this._runtime(match);
    if (rt.quarantined) return false;
    rt.quarantined = true;
    match.status = 'postponed';
    this.refundBets(match); // hook Fase D: reembolsar apuestas del partido pospuesto
    this.emit('football:status', { matchId: match.id, code: 'postponed', reason });
    this.logEvent('football_match_quarantined', { match: match.id, reason });
    return true;
  }

  // --- Reconciliación al arrancar (§15.6) ---

  // Reconstruye el estado de todos los partidos no terminales desde (seed, now).
  // El orden importa: esto corre ANTES del reset mensual de fichas (A12), que
  // orquesta bootstrap() en la integración. Los hooks de apuestas (pasos 4-7b)
  // los rellena la Fase D.
  reconcile(now = Date.now()) {
    const t0 = Date.now();
    this.store.ensureSeason(new Date(now));
    const currentMonth = monthKey(new Date(now));
    const todayDay = Number(calendarParts(new Date(now)).day);
    const matches = this.store.getMatches();
    const summary = {
      partidos: matches.length, liquidados: 0, en_juego: 0, reprogramados: 0,
      reembolsados: 0, pendientes_anulados: 0, escrow_mismatch: 0
    };

    for (const match of matches) {
      if (TERMINAL_STATUSES.includes(match.status) || match.status === 'settled') continue;
      try {
        const result = this._ensureTimeline(match);
        const clk = matchClock(now, match.scheduledKickoffAt, result.clock, this.opts);
        const rt = this._runtime(match);
        rt.replay = true; // §15.9: lo recuperado al arrancar se emite como replay, no en tiempo real
        const deadline = this.forceFinishDeadline(match);

        if (clk.ended || now > deadline) {
          // Terminó durante la caída ⇒ liquidar SIEMPRE (el resultado estaba
          // pre-comprometido por el seed; nunca anular, §15.9).
          this._settleResult(match, result.score, now);
          rt.revealedIndex = result.timeline.length - 1;
          summary.liquidados++;
        } else if (clk.phase !== 'pre') {
          // En juego ⇒ live/halftime; el próximo advance revela el prefijo como catch-up.
          match.status = phaseToStatus(clk.phase) || 'live';
          rt.revealedIndex = -1;
          rt.lastTickAt = now;
          summary.en_juego++;
        } else if (match.seasonMonth === currentMonth && match.day === todayDay) {
          // Aún no jugado y es de hoy ⇒ lo arranca el kickoff sweep (§15.6 paso 6).
          summary.reprogramados++;
        }
      } catch (error) {
        // No se pudo derivar (p. ej. club faltante). Si el kickoff pasó de largo,
        // posponer y reembolsar; si no, dejar programado para reintentar.
        this.logEvent('football_reconcile_match_error', { match: match.id, message: String(error?.message || error) });
        if (now - match.scheduledKickoffAt > this.opts.forceFinishMs) {
          this.quarantine(match, 'boot_underivable');
          summary.reembolsados++;
        }
      }
    }

    // Pasos de apuestas (§15.6 4b y 7b): hooks de la Fase D.
    summary.pendientes_anulados += this.cancelPendingBets(now) || 0;
    summary.escrow_mismatch += this.reconcileEscrow(now) || 0;

    const ms = Date.now() - t0;
    this.logEvent('football_boot_reconcile', { ...summary, ms });
    this.emit('football:reconcile', { ...summary, ms });
    return { ...summary, ms };
  }

  // --- Observabilidad y apagado (§15.7, §15.8) ---

  healthSnapshot(now = Date.now()) {
    const league = this.store.getLeague();
    const matches = this.store.getMatches();
    const todayMonth = monthKey(new Date(now));
    const todayDay = Number(calendarParts(new Date(now)).day);
    let quarantined = 0;
    for (const rt of this.runtime.values()) if (rt.quarantined) quarantined++;
    // lastTickAgeMs solo sobre partidos EN JUEGO: uno ya asentado tiene el tick
    // viejo por definición y no es una señal de alarma.
    const activos = this.active();
    let oldestTick = 0;
    for (const m of activos) {
      const rt = this.runtime.get(m.id);
      if (rt && rt.lastTickAt) oldestTick = Math.max(oldestTick, now - rt.lastTickAt);
    }
    const jornadaHoy = matches.find(m => m.seasonMonth === todayMonth && m.day === todayDay);
    return {
      enabled: true,
      seasonMonth: league ? league.seasonMonth : null,
      jornada: jornadaHoy ? jornadaHoy.jornada : null,
      matchesActive: activos.length,
      matchesScheduledToday: matches.filter(m => m.seasonMonth === todayMonth && m.day === todayDay && m.status !== 'settled').length,
      lastSweepAgeMs: this.lastSweepAt ? now - this.lastSweepAt : null,
      lastTickAgeMs: oldestTick || null,
      openBets: this.countOpenBets(now) || 0,
      escrowChips: this.countEscrow(now) || 0,
      ledgerBalanced: true, // se vuelve significativo con el cuadre de escrow de la Fase D
      quarantined,
      degraded: this.degraded
    };
  }

  // Gate del reset mensual (A7): mientras haya apuestas abiertas del mes que
  // cierra, el reset se pospone. Sin apuestas (Fase C) nunca bloquea.
  seasonGate() {
    const currentMonth = this.store.getCurrentSeasonMonth();
    if (this.hasOpenBets(currentMonth)) return { type: 'deferred', reason: 'open_football_bets' };
    return { type: 'proceed' };
  }

  // Apagado limpio (§15.7): avisa, persiste y cierra. Los partidos NO se marcan
  // interrumpidos: al volver, f(seed, now) los pone donde corresponde.
  async shutdown() {
    this.emit('football:status', { code: 'restarting' });
    try { await this.store.saveNow(); }
    catch (error) { this.logEvent('football_shutdown_save_error', { message: String(error?.message || error) }); }
    try { if (typeof this.store.close === 'function') await this.store.close(); }
    catch (error) { this.logEvent('football_shutdown_close_error', { message: String(error?.message || error) }); }
  }
}

module.exports = { FootballEngine, matchClock, phaseToStatus, LIVE_STATUSES, TERMINAL_STATUSES, DEFAULTS };
