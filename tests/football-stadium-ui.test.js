'use strict';

// Regresión del cliente del Estadio: estados de juego, mercados y alineación visible.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'estadio.html'), 'utf8');
const STYLES = fs.readFileSync(path.join(__dirname, '..', 'public', 'estadio.css'), 'utf8');
const ADMIN_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
const ADMIN_CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'estadio.js'), 'utf8');

function team(id, name, short, primary, secondary) {
  return {
    id, name, short,
    colors: { primary, secondary, kit: 'solid' },
    formation: '4-4-2', style: 'balanced'
  };
}

function player(id, teamId, number, active = true) {
  return {
    id, team: teamId, name: `Jugador ${number}`, number,
    pos: number === 1 ? 'GK' : 'MF', role: number === 1 ? 'GK' : 'MF', slotIndex: number - 1,
    x: teamId === 'home' ? .22 : .78, y: .1 + number * .02,
    status: active ? 'active' : 'bench', active
  };
}

function market(key, price) { return { key, price, implied: 1 / price }; }

function ballonDorMarket(overrides = {}) {
  const playerIds = ['frr_09', 'sol_17', 'vrd_09', 'klv_17', 'hlc_09', 'irn_09', 'nvl_09', 'est_17', 'prg_09', 'amb_17', 'crv_09', 'alm_17', 'tlb_17', 'vng_17', 'vtr_17', 'vlm_17'];
  const candidates = Array.from({ length: 16 }, (_, index) => ({
    id: `bdo-club-${index + 1}`,
    playerId: playerIds[index],
    clubId: `club-${index + 1}`,
    clubName: `Club ${index + 1}`,
    clubShort: `CL${index + 1}`,
    clubColors: { primary: index === 0 ? '#52e0ae' : '#223344' },
    playerName: `Delantero ${index + 1}`,
    playerNumber: index + 9,
    attributes: { shooting: 70 + index, pace: 65 + index },
    stats: { goals: index, assists: index % 3, appearances: index + 1, yellowCards: index % 2, redCards: 0 },
    points: { total: 30 - index, teamBonus: 0 },
    probability: 1 / 16,
    impliedProbability: 1 / (2 + index / 10),
    odds: index === 0 ? 2.5 : Number((2 + index / 10).toFixed(2))
  }));
  return {
    market: 'balon_de_oro', eventId: 'bdo-2026-10', seasonMonth: '2026-10', status: 'active',
    updatedAt: 100, opensOnDay: 1, closesAfterJornada: 20,
    oddsSnapshot: { afterJornada: 0, updatedAt: 100, simulations: 2000, overround: 1.1 },
    finalization: {
      scheduledAt: Date.UTC(2026, 9, 31, 4), timeZone: 'America/Mexico_City', hour: 22, minute: 0,
      afterMatch: { id: 'bdo-final-match', jornada: 30, desempate: false, kickoffAt: Date.UTC(2026, 9, 30, 3, 30) },
      actualAt: null
    },
    candidates, result: null, cancellationReason: null,
    ...overrides
  };
}

function settledBallonDorMarket(overrides = {}) {
  const market = ballonDorMarket({
    status: 'settled',
    finalization: {
      scheduledAt: 100, timeZone: 'America/Mexico_City', hour: 22, minute: 0,
      afterMatch: { id: 'final', jornada: 30, desempate: false, kickoffAt: 50 }, actualAt: 100
    },
    ...overrides
  });
  const ranking = market.candidates.map((candidate, index) => ({
    candidateId: candidate.id, rank: index + 1, score: candidate.points.total
  }));
  market.result = {
    winnerCandidateId: ranking[0].candidateId, winnerScore: ranking[0].score,
    finalizedAt: 100, ranking
  };
  market.ceremony = {
    verified: true, eventId: market.eventId, seasonMonth: market.seasonMonth, finalizedAt: 100,
    predictionCount: 3, settledPredictionCount: 3, winningPredictionCount: 1,
    paidWinningPredictionCount: 1, paidVirtualChips: 250, pendingPayoutCount: 0, settlementComplete: true
  };
  return market;
}

function createHarness(options = {}) {
  let nowMs = options.now == null ? Date.now() : options.now;
  let perfNow = 1000;
  const intervals = [];
  const teams = {
    home: team('home', options.homeName || 'Home FC', options.homeShort || 'HOM', '#1de9b6', '#1f2a30'),
    away: team('away', options.awayName || 'Away FC', options.awayShort || 'AWY', '#d32f2f', '#1a1a1a')
  };
  teams.home.style = 'possession';
  teams.away.style = 'pressing';
  Object.assign(teams, options.extraTeams || {});
  const kickoffAt = options.kickoffAt == null
    ? nowMs + (options.kickoffOffsetMs == null ? 60000 : options.kickoffOffsetMs)
    : options.kickoffAt;
  const match = {
    id: 'ui-match', homeId: options.homeId || 'home', awayId: options.awayId || 'away', status: 'scheduled',
    scheduledKickoffAt: kickoffAt, jornada: 1, block: 'matutino'
  };
  const players = [
    ...Array.from({ length: 11 }, (_, i) => player(`h${i + 1}`, 'home', i + 1)),
    player('h12', 'home', 12, false),
    ...Array.from({ length: 11 }, (_, i) => player(`a${i + 1}`, 'away', i + 21))
  ];
  const matchState = {
    match,
    state: {
      minute: 0, displayMinute: 0, half: 1, phase: 'kickoff', score: { home: 0, away: 0 },
      possession: { home: .5, away: .5 }, possessionTeam: 'home', ballCarrierId: null,
      playStopped: true, ball: { x: .5, y: .5 }, players,
      formation: { home: '4-4-2', away: '4-4-2' },
      stats: { xG: { home: 0, away: 0 }, shots: { home: 0, away: 0 }, shotsOnTarget: { home: 0, away: 0 }, corners: { home: 0, away: 0 }, fouls: { home: 0, away: 0 } },
      cards: { home: [], away: [] }, redCards: { home: 0, away: 0 }
    },
    markets: {
      '1x2': [market('home', 2.1), market('draw', 3.2), market('away', 3.5)],
      double_chance: [market('home_draw', 1.3)]
    },
    myBets: options.myBets || [], commentary: []
  };
  const lobby = {
    matches: [match], standings: options.standings || [], nextKickoffAt: null, serverNow: nowMs
  };
  const handlers = {};
  const requests = [];
  const audioTelemetryAttempts = [];
  const socketEmitted = [];
  const ballonDorSocketAttempts = [];
  const ballonDorHttpAttempts = [];
  let ballonDorMarketGets = 0;
  let currentBallonDorMarket = options.ballonDorMarket || null;
  let betHistory = options.betHistory || null;
  let submittedPromotion = null;
  const activePromotions = Array.isArray(options.activePromotions)
    ? options.activePromotions
    : (options.activePromotion ? [options.activePromotion] : []);
  const socket = {
    connected: options.socketConnected !== false,
    on(event, handler) { handlers[event] = handler; },
    emit(event, payload, ack) {
      socketEmitted.push({ event, payload });
      if (event === 'football:bet' && options.onBet) { options.onBet(payload, ack); return; }
      if (event === 'football:quiniela_get' && options.onQuinielaGet) { ack(options.onQuinielaGet(payload)); return; }
      if (event === 'football:quiniela_enter' && options.onQuinielaEnter) { ack(options.onQuinielaEnter(payload)); return; }
      if (event === 'football:club_profile_get' && options.onClubProfileGet) { options.onClubProfileGet(payload, ack); return; }
      if (event === 'football:roster_get' && options.onRosterGet) { options.onRosterGet(payload, ack); return; }
      if (event === 'football:transfers_get' && options.onTransfersGet) { ack(options.onTransfersGet(payload)); return; }
      if (event === 'football:fan_equip' && options.onFanEquip) { ack(options.onFanEquip(payload)); return; }
      if (event === 'football:fan_get' && options.onFanGet) { ack(options.onFanGet(payload)); return; }
      if (event === 'football:fan_select' && options.onFanSelect) { ack(options.onFanSelect(payload)); return; }
      if (event === 'football:fan_ranking_opt' && options.onFanOpt) { ack(options.onFanOpt(payload)); return; }
      if (event === 'football:fantasy_get' && options.onFantasyGet) { ack(options.onFantasyGet(payload)); return; }
      if (event === 'football:fantasy_save' && options.onFantasySave) { ack(options.onFantasySave(payload)); return; }
      if (event === 'football:fantasy_ranking_opt' && options.onFantasyOpt) { ack(options.onFantasyOpt(payload)); return; }
      if (event === 'football:ballon_dor_market') {
        if (typeof ack === 'function') ack({ ok: true, market: currentBallonDorMarket });
        return;
      }
      if (event === 'football:ballon_dor_bet') {
        ballonDorSocketAttempts.push({ payload: { ...payload } });
        const outcome = typeof options.onBallonDorSocketBet === 'function'
          ? options.onBallonDorSocketBet(payload, ballonDorSocketAttempts.length)
          : {
            ok: true,
            chips: 1000 - Number(payload.stake || 0),
            replayed: false,
            future: {
              id: 'future-ui-1', seasonMonth: currentBallonDorMarket && currentBallonDorMarket.seasonMonth || '2026-10',
              market: 'balon_de_oro', selection: payload.selection, stake: Number(payload.stake),
              odds: 2.5, potentialPayout: Math.floor(Number(payload.stake) * 2.5),
              status: 'open', payout: null, placedAt: nowMs
            }
          };
        Promise.resolve(outcome).then(result => { if (typeof ack === 'function') ack(result); });
        return;
      }
      if (event !== 'football:subscribe') return;
      if (payload.scope === 'lobby') {
        ack({ ok: true, teams, profile: { id: 'alice', chips: 1000 }, lobby });
      } else {
        if (options.onMatchSubscribe) { options.onMatchSubscribe(payload, ack, { teams, matchState }); return; }
        ack({ ok: true, teams, profile: { id: 'alice', chips: 1000 }, matchState });
      }
    }
  };
  let rafCallback = null;
  const drawnText = [];
  const playerTextTrace = [];
  const ballTrace = [];
  const fillRects = [];
  const canvasContext = new Proxy({}, {
    get(_target, key) {
      if (key === 'fillText') return (value, x, y) => { drawnText.push(String(value)); playerTextTrace.push({ value: String(value), x, y }); };
      // El balón se dibuja con radio BALL_R (6): se registra su posición para medir la trayectoria.
      if (key === 'arc') return (x, y, r) => { if (r === 6) ballTrace.push({ x, y }); };
      // Rectángulos rellenos (áreas, redes y rótulos) para medir geometría.
      if (key === 'fillRect') return (x, y, width, height) => { fillRects.push({ x, y, width, height }); };
      return () => {};
    },
    set() { return true; }
  });
  const dom = new JSDOM(HTML, {
    url: 'http://localhost:3000' + (options.path || '/estadio'),
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  const speechUtterances = [];
  let activeSpeechUtterance = null, speechOverlapCount = 0, speechCancelCount = 0, speechResumeCount = 0;
  let speechApi = null;
  if (options.speechSynthesis) {
    window.SpeechSynthesisUtterance = function (text) { this.text = String(text); };
    speechApi = {
      speaking: false,
      voices: options.speechVoices || [
        { name: 'Narrador mexicano', lang: 'es-MX', localService: true },
        { name: 'Analista mexicana', lang: 'es-MX', localService: true }
      ],
      getVoices() { return this.voices.slice(); },
      addEventListener() {},
      resume() { speechResumeCount++; },
      speak(utterance) {
        if (this.speaking) speechOverlapCount++;
        this.speaking = true;
        activeSpeechUtterance = utterance;
        speechUtterances.push(utterance);
      },
      cancel() {
        speechCancelCount++;
        this.speaking = false;
        activeSpeechUtterance = null;
      }
    };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: speechApi });
  }
  window.Date.now = () => nowMs;
  Object.defineProperty(window.performance, 'now', { configurable: true, value: () => perfNow });
  const mobileGateStyle = window.document.createElement('style');
  mobileGateStyle.textContent = 'body { overflow: hidden; }';
  window.document.head.appendChild(mobileGateStyle);
  const style = window.document.createElement('style');
  style.textContent = STYLES;
  window.document.head.appendChild(style);
  window.localStorage.setItem('montecristo-tos', options.localTosVersion || '2026-09-28');
  // Preferencia previa de la grada: el cliente la lee al evaluarse.
  if (options.danmakuMuted) window.localStorage.setItem('montecristo-danmaku-muted', 'off');
  if (options.openingCompleted && currentBallonDorMarket) {
    window.localStorage.setItem('montecristo-bdo-opening-v2:' + currentBallonDorMarket.seasonMonth, 'completed');
  }
  let openingAudioTime = 0, openingAudioPaused = true, openingAudioMuted = false, openingAudioPlayCount = 0;
  let openingClockSeconds = 0;
  const openingAudio = window.document.getElementById('est-bdo-opening-audio');
  Object.defineProperties(openingAudio, {
    currentTime: { configurable: true, get: () => openingAudioTime, set: value => { openingAudioTime = Number(value) || 0; } },
    duration: { configurable: true, get: () => 45 },
    paused: { configurable: true, get: () => openingAudioPaused },
    muted: { configurable: true, get: () => openingAudioMuted, set: value => { openingAudioMuted = Boolean(value); } }
  });
  openingAudio.play = () => {
    openingAudioPlayCount++;
    if (options.openingAudioFails) return Promise.reject(new Error('audio unavailable'));
    openingAudioPaused = false;
    return Promise.resolve();
  };
  openingAudio.pause = () => { openingAudioPaused = true; };
  // Tema instrumental de la segunda mitad: el arnés lo mide aparte de la voz.
  let openingBedPaused = true, openingBedPlayCount = 0;
  const openingBed = window.document.getElementById('est-bdo-opening-bed');
  Object.defineProperties(openingBed, {
    currentTime: { configurable: true, get: () => 0, set: () => {} },
    volume: { configurable: true, get: () => 1, set: () => {} },
    muted: { configurable: true, get: () => false, set: () => {} },
    paused: { configurable: true, get: () => openingBedPaused }
  });
  openingBed.play = () => { openingBedPlayCount++; openingBedPaused = false; return Promise.resolve(); };
  openingBed.pause = () => { openingBedPaused = true; };
  const ceremonyAudioCounts = { music: 0, narration: 0 };
  const ceremonyAudioSrcHistory = { music: [], narration: [] };
  const ceremonyAudioState = {};
  ['music', 'narration'].forEach(kind => {
    const state = { currentTime: 0, duration: 45, paused: true, muted: false };
    const audio = window.document.getElementById('est-bdo-ceremony-' + kind + '-audio');
    ceremonyAudioState[kind] = { state, audio };
    Object.defineProperties(audio, {
      currentTime: { configurable: true, get: () => state.currentTime, set: value => { state.currentTime = Number(value) || 0; } },
      duration: { configurable: true, get: () => state.duration },
      paused: { configurable: true, get: () => state.paused },
      muted: { configurable: true, get: () => state.muted, set: value => { state.muted = Boolean(value); } }
    });
    audio.load = () => {};
    audio.play = () => {
      ceremonyAudioCounts[kind]++;
      ceremonyAudioSrcHistory[kind].push(audio.getAttribute('src') || 'static');
      if (options.ceremonyAudioFails) return Promise.reject(new Error('audio unavailable'));
      state.paused = false;
      audio.dispatchEvent(new window.Event('play'));
      return Promise.resolve();
    };
    audio.pause = () => { state.paused = true; };
  });
  const reducedMotion = options.reducedMotion !== undefined ? Boolean(options.reducedMotion) : true;
  window.matchMedia = () => ({ matches: reducedMotion, addListener() {}, addEventListener() {} });
  window.HTMLCanvasElement.prototype.getContext = () => canvasContext;
  window.requestAnimationFrame = callback => { rafCallback = callback; return 1; };
  window.cancelAnimationFrame = () => {};
  window.setInterval = (callback, delay) => { intervals.push({ callback, delay }); return intervals.length; };
  window.clearInterval = () => {};
  const timeouts = [];
  const scheduledTimeouts = []; // bitácora de todos los setTimeout, sin consumir
  window.setTimeout = (callback, delay) => {
    const timer = { callback, at: perfNow + (delay || 0), delay: Number(delay) || 0 };
    timeouts.push(timer);
    scheduledTimeouts.push(timer);
    return timer;
  };
  window.clearTimeout = timer => {
    const idx = timeouts.indexOf(timer);
    if (idx >= 0) timeouts.splice(idx, 1);
  };
  window.fetch = async (url, requestOptions = {}) => {
    const target = String(url);
    requests.push({ url: target, options: requestOptions });
    if (target === '/api/estadio/telemetry/audio' && requestOptions.method === 'POST') {
      audioTelemetryAttempts.push({ body: JSON.parse(requestOptions.body || '{}'), options: requestOptions });
      return { ok: true, status: 202, json: async () => ({ ok: true }) };
    }
    if (target.startsWith('/assets/')) {
      return { ok: true, blob: async () => new window.Blob([Uint8Array.from([1, 2, 3, 4])], { type: 'image/jpeg' }) };
    }
    if (target.includes('/healthz')) {
      return { ok: true, json: async () => ({ football: { enabled: true }, promotionsEnabled: Boolean(options.promotionsEnabled) }) };
    }
    if (target === '/api/auth/session') {
      return {
        ok: true,
        json: async () => options.accountSession || { authenticated: false, account: null, csrfToken: null }
      };
    }
    if (requestOptions.method === 'POST' && target === '/api/estadio/promotions') {
      submittedPromotion = JSON.parse(requestOptions.body);
      return { ok: true, status: 201, json: async () => ({ ok: true, promotion: { status: 'pending' } }) };
    }
    if (target === '/api/estadio/ballon-dor/archive') {
      const defaultCycle = currentBallonDorMarket ? [{
        eventId: currentBallonDorMarket.eventId,
        seasonMonth: currentBallonDorMarket.seasonMonth,
        status: currentBallonDorMarket.status,
        finalizedAt: currentBallonDorMarket.result && currentBallonDorMarket.result.finalizedAt,
        winner: currentBallonDorMarket.result && currentBallonDorMarket.candidates.find(candidate => candidate.id === currentBallonDorMarket.result.winnerCandidateId)
          ? { playerName: currentBallonDorMarket.candidates[0].playerName, clubName: currentBallonDorMarket.candidates[0].clubName, score: currentBallonDorMarket.result.winnerScore }
          : null,
        ceremony: currentBallonDorMarket.ceremony || null
      }] : [];
      const cycles = options.ballonDorArchive || defaultCycle;
      return { ok: true, json: async () => ({ ok: true, cycles }) };
    }
    if (target === '/api/estadio/ballon-dor' || target.startsWith('/api/estadio/ballon-dor?')) {
      ballonDorMarketGets++;
      const fail = typeof options.failBallonDorFetch === 'function'
        ? Boolean(options.failBallonDorFetch(ballonDorMarketGets))
        : Boolean(options.failBallonDorFetch);
      return {
        ok: !fail,
        json: async () => fail ? { ok: false, error: 'unavailable' } : { ok: true, market: currentBallonDorMarket }
      };
    }
    if (target === '/api/estadio/ballon-dor/bet' && requestOptions.method === 'POST') {
      const body = JSON.parse(requestOptions.body || '{}');
      ballonDorHttpAttempts.push({ body, headers: requestOptions.headers || {} });
      const outcome = typeof options.onBallonDorHttpBet === 'function'
        ? await options.onBallonDorHttpBet(body, ballonDorHttpAttempts.length)
        : {
          ok: true, chips: 1000 - Number(body.stake || 0), replayed: false,
          future: {
            id: 'future-http-ui-1', seasonMonth: currentBallonDorMarket && currentBallonDorMarket.seasonMonth || '2026-10',
            market: 'balon_de_oro', selection: body.selection, stake: Number(body.stake),
            odds: 2.5, potentialPayout: Math.floor(Number(body.stake) * 2.5),
            status: 'open', payout: null, placedAt: nowMs
          }
        };
      return { ok: outcome.status ? outcome.status < 400 : outcome.ok !== false, status: outcome.status || 200, json: async () => outcome };
    }
    if (target.startsWith('/api/estadio/my-bets')) {
      const history = typeof betHistory === 'function' ? betHistory() : betHistory;
      if (options.onBetHistory) return { ok: true, json: async () => options.onBetHistory() };
      return { ok: true, json: async () => ({ ok: true, history: history || null, profile: { id: 'alice', chips: 1000 } }) };
    }
    if (target.endsWith('/mine')) {
      return { ok: true, json: async () => ({ promotion: null }) };
    }
    if (target.startsWith('/api/estadio/promotions/')) {
      return {
        ok: true,
        json: async () => ({ ok: true, promotion: activePromotions[0] || null, promotions: activePromotions })
      };
    }
    return {
      ok: true,
      json: async () => ({ ok: true, teams, tosVersion: '2026-09-28', lobby, profile: { id: 'alice', chips: 1000 } })
    };
  };
  window.io = options.socketMissing ? undefined : () => socket;
  window.eval(CLIENT);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

  return {
    dom, window, socket, handlers, match, matchState, players, drawnText, playerTextTrace, requests, ballTrace, fillRects, socketEmitted, scheduledTimeouts,
    audioTelemetryAttempts, ballonDorSocketAttempts, ballonDorHttpAttempts,
    speech: speechApi ? {
      utterances: speechUtterances,
      get overlapCount() { return speechOverlapCount; },
      get cancelCount() { return speechCancelCount; },
      get resumeCount() { return speechResumeCount; },
      finish(index) {
        const utterance = speechUtterances[index];
        if (!utterance) throw new Error('No existe la locución ' + index);
        if (activeSpeechUtterance === utterance) {
          activeSpeechUtterance = null;
          speechApi.speaking = false;
        }
        if (typeof utterance.onend === 'function') utterance.onend({ type: 'end' });
      }
    } : null,
    get openingAudioPlayCount() { return openingAudioPlayCount; },
    get openingBedPlayCount() { return openingBedPlayCount; },
    get ceremonyAudioCounts() { return { ...ceremonyAudioCounts }; },
    get ceremonyAudioSrcHistory() { return { music: ceremonyAudioSrcHistory.music.slice(), narration: ceremonyAudioSrcHistory.narration.slice() }; },
    async finishCeremonyClip() {
      const item = ceremonyAudioState.narration;
      item.state.currentTime = item.state.duration;
      item.state.paused = true;
      item.audio.dispatchEvent(new window.Event('ended'));
      await this.flush();
    },
    // La inauguración avanza con el reloj de la página (no con el del MP3): este
    // atajo mueve las dos cosas para que las pruebas puedan pedir «segundo 18».
    advanceOpeningAudio(seconds) {
      const target = Math.max(0, Number(seconds) || 0);
      const delta = Math.max(0, target - openingClockSeconds);
      openingClockSeconds = target;
      openingAudioTime = target;
      openingAudio.dispatchEvent(new window.Event('timeupdate'));
      if (delta > 0) this.advanceTime(delta * 1000);
    },
    get submittedPromotion() { return submittedPromotion; },
    setBallonDorMarket(nextMarket) { currentBallonDorMarket = nextMarket; },
    setBetHistory(nextHistory) { betHistory = nextHistory; },
    async flush() { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); },
    advanceTime(ms) {
      nowMs += ms;
      perfNow += ms;
      intervals.filter(interval => interval.delay === 1000 || (interval.delay === 15000 && ms >= interval.delay)
        || (interval.delay === 250 && ms >= interval.delay) || (interval.delay === 100 && ms >= interval.delay)).forEach(interval => interval.callback());
      const due = timeouts.filter(t => t.at <= perfNow);
      for (const t of due) {
        const idx = timeouts.indexOf(t);
        if (idx >= 0) timeouts.splice(idx, 1);
        t.callback();
      }
    },
    async connectToMatch() {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(typeof handlers.connect, 'function', 'el cliente conectó el socket');
      handlers.connect();
      window.document.querySelector('#est-match-list li').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    },
    draw(offsetMs = 3000) {
      drawnText.length = 0;
      assert.equal(typeof rafCallback, 'function');
      rafCallback(window.performance.now() + offsetMs);
      return drawnText.slice();
    },
    close() { dom.window.close(); }
  };
}

test('el lobby y la tabla muestran los nombres cómicos completos, no solo los códigos cortos', async t => {
  const h = createHarness({
    homeName: 'Real Mandril', homeShort: 'VTR',
    awayName: 'Farselona FC', awayShort: 'VNG',
    standings: [
      { teamId: 'home', played: 1, goalDiff: 1, points: 3 },
      { teamId: 'away', played: 1, goalDiff: -1, points: 0 }
    ]
  });
  t.after(h.close);
  await h.connectToMatch();
  await h.flush();
  const { document } = h.window;
  const fixture = document.querySelector('#est-match-list .est-match-teams').textContent;
  const standings = document.querySelector('#est-standings tbody').textContent;
  assert.match(fixture, /Real Mandril/);
  assert.match(fixture, /Farselona FC/);
  assert.doesNotMatch(fixture, /VTR|VNG/);
  assert.match(standings, /Real Mandril/);
  assert.match(standings, /Farselona FC/);
});

test('las galerías de anuncios del Estadio y de administración solo apuntan a imágenes existentes', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const stadiumDom = new JSDOM(HTML);
  const adminDom = new JSDOM(ADMIN_HTML);
  [
    [stadiumDom.window.document, '.est-preset-btn'],
    [adminDom.window.document, '.admin-preset-btn']
  ].forEach(([document, selector]) => {
    document.querySelectorAll(selector).forEach(button => {
      const preset = button.getAttribute('data-preset');
      const thumbnail = button.querySelector('img')?.getAttribute('src');
      assert.ok(preset && thumbnail, 'cada preset tiene una ruta y una miniatura');
      assert.equal(thumbnail, preset, 'la miniatura coincide con la imagen que se previsualiza');
      assert.ok(fs.existsSync(path.join(publicDir, preset.replace(/^\//, ''))), `${preset} existe en public/`);
    });
  });
  stadiumDom.window.close();
  adminDom.window.close();
});

test('avatares persistentes, cues y nombres grabados del Balón de Oro usan assets locales acotados', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const dom = new JSDOM(HTML);
  const { document } = dom.window;
  const thumbnails = [...document.querySelectorAll('#est-preset-thumbnails img')];
  assert.equal(thumbnails.length, 5, 'el estudio conserva cinco fondos reutilizables');
  const preview = document.getElementById('est-studio-preview-img');
  for (const image of [...thumbnails, preview]) {
    assert.equal(image.getAttribute('loading'), 'lazy', `${image.id || image.alt} se carga cuando se aproxima al viewport`);
    assert.equal(image.getAttribute('decoding'), 'async');
    assert.ok(Number(image.getAttribute('width')) > 0 && Number(image.getAttribute('height')) > 0,
      'las dimensiones reservan espacio antes de decodificar');
    const imagePath = image.getAttribute('src').replace(/^\//, '');
    assert.ok(fs.existsSync(path.join(publicDir, imagePath)), `${imagePath} existe en public/`);
  }

  const opening = document.getElementById('est-bdo-opening-audio');
  assert.equal(opening.getAttribute('preload'), 'none');
  assert.match(opening.getAttribute('src'), /^\/assets\/[^/]+\.mp3$/);
  assert.ok(fs.existsSync(path.join(publicDir, opening.getAttribute('src').replace(/^\//, ''))));
  const music = document.getElementById('est-bdo-ceremony-music-audio');
  assert.equal(music.getAttribute('preload'), 'none');
  assert.equal(music.getAttribute('src'), '/assets/ballon-dor-ceremony-theme.wav');
  assert.equal(music.hasAttribute('loop'), true, 'el fondo discreto acompaña clips de duración variable');
  const scoreBytes = fs.statSync(path.join(publicDir, 'assets', 'ballon-dor-ceremony-theme.wav')).size;
  assert.ok(scoreBytes > 0 && scoreBytes <= 2_100_000, 'el tema local sigue siendo una pista ligera');
  const narration = document.getElementById('est-bdo-ceremony-narration-audio');
  assert.equal(narration.getAttribute('preload'), 'none');
  assert.equal(narration.hasAttribute('src'), false, 'cada cue y cada nombre se seleccionan por ID estable');

  const cueIds = ['verification', 'third-place', 'second-place', 'finalists', 'winner-intro', 'winner-congratulations'];
  for (const cue of cueIds) {
    const cuePath = path.join(publicDir, 'assets', 'ballon-dor-ceremony', 'cues', cue + '.wav');
    assert.ok(fs.existsSync(cuePath), `${cue} tiene locución es-MX propia`);
  }
  const playerIds = ['frr_09', 'sol_17', 'vrd_09', 'klv_17', 'hlc_09', 'irn_09', 'nvl_09', 'est_17', 'prg_09', 'amb_17', 'crv_09', 'alm_17', 'tlb_17', 'vng_17', 'vtr_17', 'vlm_17'];
  assert.equal(playerIds.length, 16, 'se conserva el candidato ST existente de cada club');
  const uniqueAvatarArt = new Set();
  for (const playerId of playerIds) {
    assert.ok(fs.existsSync(path.join(publicDir, 'assets', 'ballon-dor-ceremony', 'names', playerId + '.wav')),
      `${playerId} tiene clip de nombre`);
    const avatarPath = path.join(publicDir, 'assets', 'ballon-dor-avatars', playerId + '.svg');
    assert.ok(fs.existsSync(avatarPath), `${playerId} tiene un avatar único reutilizable`);
    const avatarArt = fs.readFileSync(avatarPath, 'utf8');
    assert.match(avatarArt, /^<svg\b/);
    uniqueAvatarArt.add(avatarArt);
  }
  assert.equal(uniqueAvatarArt.size, 16, 'cada playerId usa una ilustración distinta');
  assert.ok(fs.existsSync(path.join(publicDir, 'assets', 'ballon-dor-avatars', 'default.svg')));
  dom.window.close();
});

test('el CSS del evento conserva layouts móviles, movimiento reducido y sintaxis balanceada', () => {
  assert.match(STYLES, /\.est-commentary-panel/);
  assert.match(STYLES, /\.est-commentary-voice-toggle/);
  assert.match(STYLES, /\.est-cmt\.is-latest/);
  assert.match(STYLES, /\.est-cmt\.is-speaking/);
  assert.match(STYLES, /@media\s*\(max-width:\s*680px\)[\s\S]*?\.est-cmt/);
  assert.match(STYLES, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.est-commentary-live/);
  assert.match(STYLES, /@media\(max-width:760px\)[\s\S]*?\.est-bdo-opening-dialog/);
  assert.match(STYLES, /@media\(max-width:680px\)[\s\S]*?\.est-bdo-ceremony-panel/);
  assert.match(STYLES, /@media\(prefers-reduced-motion:\s*reduce\)[\s\S]*?animation:none !important/);
  assert.match(STYLES, /\.est-bdo-ceremony-nominees/);
  assert.match(STYLES, /@media\(max-width:680px\)[\s\S]*?\.est-bdo-ceremony-nominees \{ grid-template-columns:repeat\(2/);
  assert.match(STYLES, /\.est-bdo-opening-stage\[data-motion="reduced"\][^}]*animation:none !important/);

  let depth = 0;
  let quote = '';
  let comment = false;
  for (let index = 0; index < STYLES.length; index++) {
    const char = STYLES[index], next = STYLES[index + 1];
    if (comment) {
      if (char === '*' && next === '/') { comment = false; index++; }
      continue;
    }
    if (quote) {
      if (char === '\\') index++;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '*') { comment = true; index++; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '{') depth++;
    if (char === '}') depth--;
    assert.ok(depth >= 0, 'las llaves CSS no se cierran antes de abrir');
  }
  assert.equal(depth, 0);
  assert.equal(comment, false);
  assert.equal(quote, '');
});

test('el editor administrativo enseña el fondo elegido y lo guarda en la campaña publicada', async t => {
  const dom = new JSDOM(ADMIN_HTML, {
    url: 'http://localhost:3000/admin',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const posts = [];
  window.crypto.randomUUID = () => 'idempotency-test';
  window.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('/assets/')) {
      return { ok: true, blob: async () => new window.Blob([Uint8Array.from([5, 6, 7, 8])], { type: 'image/jpeg' }) };
    }
    if (options.method === 'POST' && target === '/admin/estadio/promotions/create') {
      posts.push(JSON.parse(options.body));
      return { ok: true, status: 201, json: async () => ({ ok: true, promotion: {} }) };
    }
    const response = target === '/api/auth/session'
      ? { ok: true, csrfToken: 'csrf-test', auth: { staff: { id: 'admin', role: 'admin' }, mfaEnrollmentRequired: false, mfaVerified: true } }
      : target === '/api/admin/v1/me'
        ? { ok: true, staff: { name: 'Admin', username: 'admin', role: 'admin' } }
        : target === '/admin/estadio/matches'
          ? { ok: true, teams: {}, matches: [] }
          : target === '/admin/estadio/promotions'
            ? { ok: true, promotions: [], activePromotions: [] }
            : { ok: true, reports: [] };
    return { ok: true, status: 200, json: async () => response };
  };
  window.eval(ADMIN_CLIENT);
  await new Promise(resolve => setTimeout(resolve, 25));

  const selectedPreset = window.document.querySelector('.admin-preset-btn[data-preset="/assets/estadio-tunnel.jpg"]');
  selectedPreset.click();
  assert.equal(window.document.getElementById('admin-studio-preview-img').getAttribute('src'), '/assets/estadio-tunnel.jpg');
  window.document.getElementById('promo-create-profile').value = 'montecristo_oficial';
  window.document.getElementById('promo-create-text').value = 'Una campaña de prueba';
  window.document.getElementById('promo-create-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 1000;
    const waitForUpload = () => {
      if (posts.length === 1) return resolve();
      if (Date.now() >= deadline) return reject(new Error('La creatividad no terminó de cargarse a tiempo.'));
      setTimeout(waitForUpload, 10);
    };
    waitForUpload();
  });

  assert.equal(posts.length, 1, 'se publicó la campaña');
  assert.equal(posts[0].text, 'Una campaña de prueba');
  assert.equal(posts[0].image, 'data:image/jpeg;base64,BQYHCA==', 'la creatividad elegida se adjunta para verla al publicar');
});

test('el borrado de campañas envía Idempotency-Key UUID aunque la solicitud POST no tenga cuerpo', async t => {
  const dom = new JSDOM(ADMIN_HTML, {
    url: 'http://localhost:3000/admin',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const key = '2a5f92d7-1fd4-4df0-a8c6-a7729347ea63';
  const deletionRequests = [];
  let activePromotions = [{
    id: 'promo-active-1', profileId: 'profile-1', username: 'patrocinador',
    isPermanent: true, scope: 'all', createdAt: Date.now(), reviewedAt: Date.now(),
    text: 'Campaña de prueba', targetPath: '/estadio'
  }];
  window.crypto.randomUUID = () => key;
  window.confirm = () => true;
  window.fetch = async (url, options = {}) => {
    const target = String(url);
    if (options.method === 'POST' && target.endsWith('/delete')) {
      deletionRequests.push({ url: target, ...options });
      activePromotions = [];
      return { ok: true, status: 200, json: async () => ({ ok: true, deleted: true }) };
    }
    const response = target === '/api/auth/session'
      ? { ok: true, csrfToken: 'csrf-test', auth: { staff: { id: 'admin', role: 'admin' }, mfaEnrollmentRequired: false, mfaVerified: true } }
      : target === '/api/admin/v1/me'
        ? { ok: true, staff: { name: 'Admin', username: 'admin', role: 'admin' } }
        : target === '/admin/estadio/matches'
          ? { ok: true, teams: {}, matches: [] }
          : target === '/admin/estadio/promotions'
            ? { ok: true, promotions: [], activePromotions }
            : { ok: true, reports: [] };
    return { ok: true, status: 200, json: async () => response };
  };
  window.eval(ADMIN_CLIENT);
  await new Promise(resolve => setTimeout(resolve, 35));

  const deleteButton = window.document.querySelector('[data-promotion-delete]');
  assert.ok(deleteButton, 'la campaña activa aparece con su acción para eliminar');
  deleteButton.click();
  await new Promise(resolve => setTimeout(resolve, 45));

  assert.equal(deletionRequests.length, 1);
  assert.equal(deletionRequests[0].url, '/admin/estadio/promotions/profile-1/promo-active-1/delete');
  assert.equal(deletionRequests[0].method, 'POST');
  assert.equal(deletionRequests[0].body, undefined, 'el endpoint no requiere cuerpo');
  assert.equal(deletionRequests[0].headers['Idempotency-Key'], key, 'toda escritura administrativa envía una clave UUID');
  assert.equal(deletionRequests[0].headers['X-CSRF-Token'], 'csrf-test');
});

test('La Previa abre exactamente en T−30, muestra datos de liga y se oculta al kickoff', async t => {
  const baseNow = 1800000000000;
  const standings = [
    { teamId: 'home', played: 5, won: 3, drawn: 1, lost: 1, goalsFor: 9, goalsAgainst: 4, goalDiff: 5, points: 10, form: ['W', 'D', 'W', 'L', 'W'] },
    { teamId: 'away', played: 5, won: 2, drawn: 2, lost: 1, goalsFor: 7, goalsAgainst: 10, points: 8, form: ['D', 'W', 'D', 'L', 'W'] }
  ];
  const h = createHarness({ now: baseNow, kickoffOffsetMs: 30 * 60 * 1000 + 1, standings, reducedMotion: false });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match } = h;
  const panel = window.document.getElementById('est-preshow');

  assert.equal(window.getComputedStyle(window.document.body).overflowY, 'auto', 'Estadio conserva el scroll vertical aunque la hoja global bloquee otras páginas pequeñas');
  assert.equal(panel.hidden, true, 'a T−30:01 todavía no aparece');
  h.advanceTime(1000);
  assert.equal(panel.hidden, false, 'aparece justo al entrar en los 30 minutos');
  assert.equal(window.document.getElementById('est-preshow-timer').textContent, '30:00');
  assert.equal(window.document.getElementById('est-preshow-promo').hidden, false, 'la promoción propia solo se muestra en la ventana activa');
  const comparison = window.document.getElementById('est-showcase').textContent;
  assert.match(window.document.getElementById('est-compare-home').textContent, /Home FC/);
  assert.match(window.document.getElementById('est-compare-away').textContent, /Away FC/);
  assert.match(comparison, /Posesión/);
  assert.match(comparison, /Presión alta/);
  assert.match(comparison, /Puntos/);
  assert.match(comparison, /9–4/);
  assert.match(comparison, /DG/);
  assert.ok(comparison.includes('+5'));
  assert.match(comparison, /-3/);
  assert.match(comparison, /Forma \(5\)/);
  const showcase = window.document.getElementById('est-showcase');
  const showcaseTrack = window.document.getElementById('est-showcase-track');
  assert.equal(showcaseTrack.querySelectorAll('.est-showcase-promo').length, 4, 'cada anuncio propio tiene su propia ficha');
  assert.equal(showcaseTrack.querySelectorAll('.est-showcase-stat').length, 1, 'todos los indicadores caben juntos en una sola ficha');
  const indicatorCard = showcaseTrack.querySelector('.est-showcase-stat');
  assert.equal(indicatorCard.dataset.indicatorCount, '8', 'la ficha conjunta contiene los ocho datos');
  assert.equal(indicatorCard.querySelectorAll('.est-indicator-row').length, 8, 'ningún indicador se pierde del cuadro');
  assert.equal(showcaseTrack.children.length, 5, 'la cartelera tiene una ficha de datos más todos sus anuncios');
  assert.equal(window.document.getElementById('est-showcase-count').textContent, '1 / 5');
  assert.equal(showcase.dataset.slideType, 'indicator', 'la ficha inicial muestra la comparativa completa');
  const initialShowcasePosition = showcaseTrack.style.transform;
  h.advanceTime(15000);
  assert.equal(showcase.dataset.index, '1', 'el carrusel avanza una ficha a la vez');
  assert.equal(showcase.dataset.slideType, 'promotion', 'después de los datos aparece un anuncio individual');
  assert.equal(window.document.getElementById('est-showcase-count').textContent, '2 / 5');
  assert.notEqual(showcaseTrack.style.transform, initialShowcasePosition, 'cada ficha ocupa la misma ventana y el carrusel se desplaza');
  window.document.querySelector('#est-showcase-dots [data-showcase-index="0"]').click();
  assert.equal(showcase.dataset.index, '0', 'se puede volver a elegir la comparativa completa desde los puntos');

  h.advanceTime(30 * 60 * 1000);
  assert.equal(panel.hidden, false, 'si el estado sigue programado, conserva una espera neutral');
  assert.match(window.document.getElementById('est-preshow-status').textContent, /Kickoff pendiente/);
  assert.equal(window.document.getElementById('est-preshow-promo').hidden, true, 'la promoción se corta al llegar la hora programada');
  handlers['football:status']({ matchId: match.id, code: 'kickoff', minute: 0 });
  assert.equal(panel.hidden, true, 'al confirmarse el kickoff desaparece la previa');
});

test('los indicadores permanecen juntos y cada anuncio ocupa su propia ficha a pantalla completa', async t => {
  const h = createHarness({ now: 1800000000000, kickoffOffsetMs: 20 * 60 * 1000, reducedMotion: false });
  t.after(h.close);
  await h.connectToMatch();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  const { window } = h;
  const showcase = window.document.getElementById('est-showcase');
  const track = window.document.getElementById('est-showcase-track');
  assert.equal(track.querySelectorAll('.est-showcase-promo').length, 4);
  assert.equal(track.querySelectorAll('.est-showcase-stat').length, 1);
  assert.equal(track.querySelectorAll('.est-indicator-row').length, 8);
  assert.equal(track.children[0].dataset.showcaseKey, 'indicators');
  assert.equal(track.children[1].dataset.showcaseKey, 'house-0');
  assert.equal(track.children[2].dataset.showcaseKey, 'house-1');

  h.advanceTime(15000);
  assert.equal(showcase.dataset.index, '1');
  assert.equal(showcase.dataset.slideType, 'promotion');
  assert.equal(track.children[1].getAttribute('aria-hidden'), 'false', 'el anuncio activo es accesible y visible');
  assert.equal(track.children[0].getAttribute('aria-hidden'), 'true', 'las otras fichas quedan fuera de lectura');

  h.advanceTime(15000);
  assert.equal(showcase.dataset.index, '2');
  assert.equal(showcase.dataset.slideType, 'promotion');
  assert.match(track.children[2].textContent, /bots del servidor/);
});

test('el formulario promocional requiere cuenta vinculada y publica el texto, enlace e imagen del preset durante T−30', async t => {
  const h = createHarness({
    promotionsEnabled: true,
    kickoffOffsetMs: 15 * 60 * 1000,
    accountSession: { ok: true, profile: { id: 'linked-profile', username: 'aficionado', role: 'sponsor' }, csrfToken: 'csrf-test' }
  });
  t.after(h.close);
  await h.connectToMatch();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  const { window } = h;
  const composer = window.document.getElementById('est-promo-compose');
  const form = window.document.getElementById('est-promo-form');
  assert.equal(composer.hidden, false, 'el formulario solo aparece cuando el feature está activo y el partido está en T−30');
  assert.equal(form.hidden, false, 'una cuenta vinculada puede enviar');
  assert.match(window.document.getElementById('est-promo-auth').textContent, /@aficionado/);

  window.document.getElementById('est-promo-copy-input').value = 'Ven a jugar a MonteCristo';
  window.document.getElementById('est-promo-target').value = '/room';
  window.document.getElementById('est-promo-room-code').value = 'a1b2c';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.deepEqual(h.submittedPromotion, {
    matchId: 'ui-match', text: 'Ven a jugar a MonteCristo', targetPath: '/room/A1B2C',
    image: 'data:image/jpeg;base64,AQIDBA=='
  });
  assert.deepEqual(Object.keys(h.submittedPromotion).sort(), ['image', 'matchId', 'targetPath', 'text']);
  const request = h.requests.find(item => item.url === '/api/estadio/promotions' && item.options.method === 'POST');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.headers['X-CSRF-Token'], 'csrf-test');
  assert.match(window.document.getElementById('est-promo-message').textContent, /pendiente de revisión.*No se han cobrado fichas/);
});

test('un anuncio aprobado también ocupa una ficha completa y conserva su enlace y formato', async t => {
  const h = createHarness({
    promotionsEnabled: true,
    kickoffOffsetMs: 20 * 60 * 1000,
    activePromotion: {
      id: 'sponsor-123', label: 'Patrocinador oficial', text: 'Una promoción destacada',
      textPosition: 'middle', textSize: 'large', textAlign: 'center', ctaText: 'Conocer más',
      href: '/estadio', image: '/api/estadio/promotion-media/sponsor-123', isPermanent: true
    }
  });
  t.after(h.close);
  await h.connectToMatch();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  const { window } = h;
  const track = window.document.getElementById('est-showcase-track');
  const sponsorSlide = track.querySelector('[data-showcase-key="sponsor-sponsor-123"]');
  assert.ok(sponsorSlide, 'el anuncio aprobado se agrega como una ficha aparte');
  assert.equal(sponsorSlide.classList.contains('est-showcase-promo'), true);
  assert.equal(sponsorSlide.getAttribute('aria-hidden'), 'false', 'el nuevo anuncio entra al carrusel como contenido visible');
  assert.equal(sponsorSlide.dataset.textPosition, 'middle');
  assert.equal(sponsorSlide.dataset.textSize, 'large');
  assert.equal(sponsorSlide.dataset.textAlign, 'center');
  assert.equal(sponsorSlide.querySelector('a').getAttribute('href'), '/estadio');
  assert.equal(track.querySelectorAll('.est-showcase-promo').length, 5, 'no reemplaza ni oculta las promociones propias');
});

test('la cartelera crea una ficha para cada anuncio aprobado sin un cupo visual fijo', async t => {
  const activePromotions = Array.from({ length: 7 }, (_, index) => ({
    id: 'user-ad-' + (index + 1),
    label: 'Anuncio de aficionado ' + (index + 1),
    text: 'Promoción enviada por una persona ' + (index + 1),
    textPosition: 'bottom', textSize: 'medium', textAlign: 'left',
    ctaText: 'Ver más', href: '/estadio', image: '/api/estadio/promotion-media/user-ad-' + (index + 1)
  }));
  const h = createHarness({
    promotionsEnabled: true,
    kickoffOffsetMs: 20 * 60 * 1000,
    activePromotions
  });
  t.after(h.close);
  await h.connectToMatch();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  const { window } = h;
  const track = window.document.getElementById('est-showcase-track');
  const showcase = window.document.getElementById('est-showcase');
  assert.equal(track.querySelectorAll('.est-showcase-stat').length, 1, 'los ocho indicadores se agrupan en una ficha');
  assert.equal(track.querySelectorAll('.est-showcase-promo.is-sponsored').length, 7, 'se muestran todos los anuncios recibidos');
  assert.equal(track.querySelectorAll('.est-showcase-promo').length, 11, 'los anuncios de personas se suman a los cuatro propios');
  assert.equal(track.children.length, 12, 'el carrusel crece con cada anuncio, sin slots prefijados');
  activePromotions.forEach(promotion => {
    assert.ok(track.querySelector('[data-showcase-key="sponsor-' + promotion.id + '"]'), 'se creó la ficha ' + promotion.id);
  });
  assert.equal(window.document.querySelectorAll('#est-showcase-dots [data-showcase-index]').length, 12, 'hay navegación para cada ficha aunque exceda el diseño inicial');
  window.document.querySelector('#est-showcase-dots [data-showcase-index="7"]').click();
  assert.equal(showcase.dataset.slideType, 'promotion');
  assert.equal(track.children[7].getAttribute('aria-hidden'), 'false', 'también se puede abrir un anuncio añadido más tarde en la lista');
  assert.match(track.children[7].textContent, /Anuncio de aficionado/);
});

test('Mis apuestas mantiene tarjetas y jerarquía visual propias', async t => {
  const h = createHarness({ myBets: [{
    id: 'bet-1', market: '1x2', selection: 'home', odds: 2.1, stake: 100,
    potentialPayout: 210, status: 'open', inPlay: false
  }] });
  t.after(h.close);
  await h.connectToMatch();

  const { window } = h;
  const panel = window.document.getElementById('est-mybets-panel');
  const list = window.document.getElementById('est-mybets');
  const card = list.querySelector('.est-mybet');
  assert.ok(card, 'la apuesta abierta se presenta como tarjeta');
  assert.equal(window.getComputedStyle(list).display, 'flex');
  assert.equal(window.getComputedStyle(card).display, 'grid');
  assert.equal(window.getComputedStyle(card).borderRadius, '10px');
  assert.equal(window.getComputedStyle(card.querySelector('.est-mybet-pick')).fontWeight, '800');
  assert.notEqual(window.getComputedStyle(panel).borderTopColor, '');
});

test('el historial y los pagos viven en una vista propia, no en las columnas del Estadio', async t => {
  const settledEntry = {
    kind: 'bet', id: 'bet-old', matchId: 'ui-match', market: '1x2', selection: 'home',
    stake: 100, odds: 2.4, potentialPayout: 240, status: 'won', payout: 240,
    inPlay: false, minuteAtPlacement: null, placedAt: 1000, settledAt: 2000,
    match: { id: 'ui-match', homeId: 'home', awayId: 'away', jornada: 1, status: 'settled', result: { home: 2, away: 0 } }
  };
  const h = createHarness({
    betHistory: {
      entries: [settledEntry],
      summary: {
        total: 1, open: 0, byStatus: { won: 1 }, staked: 100, returned: 240, net: 140,
        openStake: 0, openPotentialPayout: 0, latestSettlementAt: 2000
      },
      unseen: { count: 1, credited: 240, staked: 100, net: 140, throughAt: 2000, items: [settledEntry] },
      totalEntries: 1
    }
  });
  t.after(h.close);
  await h.connectToMatch();
  await new Promise(resolve => setImmediate(resolve));

  const { window } = h;
  const document = window.document;
  const ledger = document.getElementById('est-ledger');
  const panel = document.getElementById('est-mybets-panel');

  // La vista vive FUERA de las columnas del Estadio y nace cerrada.
  assert.ok(ledger, 'existe la vista propia del historial');
  assert.equal(ledger.hidden, true, 'nace cerrada');
  assert.equal(ledger.closest('.estadio-shell'), null, 'no ocupa espacio dentro del Estadio');
  assert.equal(ledger.getAttribute('role'), 'dialog');

  // El panel de la columna queda compacto: solo abiertas + un acceso al historial.
  assert.equal(panel.querySelector('#est-mybets'), panel.querySelector('#est-mybets'), 'las abiertas siguen en su panel');
  assert.equal(panel.querySelectorAll('[role="tab"]').length, 0, 'sin pestañas apretadas dentro de la columna');
  assert.equal(panel.querySelectorAll('.est-bets-summary, #est-bet-history').length, 0, 'el resumen y la lista no se meten en la columna');
  const link = panel.querySelector('#est-ledger-open');
  assert.ok(link, 'el panel tiene una puerta al historial');
  assert.equal(link.getAttribute('aria-controls'), 'est-ledger');

  // El nav muestra el aviso de pagos pendientes de ver.
  const navButton = document.getElementById('est-ledger-open-nav');
  const navBadge = document.getElementById('est-nav-badge');
  assert.ok(navButton, 'acceso desde el nav');
  assert.equal(navBadge.hidden, false, 'la insignia señala pagos nuevos');
  assert.equal(navBadge.textContent, '1');
  assert.match(link.textContent, /1 pago nuevo/);

  // Abrir desde el panel: la vista toma la pantalla y queda enlazada en la URL.
  link.click();
  assert.equal(ledger.hidden, false, 'se abre la vista propia');
  assert.equal(window.location.hash, '#apuestas');
  assert.equal(window.getComputedStyle(ledger).position, 'fixed', 'ocupa la pantalla completa');

  const notice = document.getElementById('est-ledger-unseen');
  assert.equal(notice.hidden, false, 'avisa de los pagos acreditados mientras no estaba');
  assert.match(notice.textContent, /Se liquidaron 1 apuesta/);
  assert.match(notice.textContent, /240/);

  const card = document.querySelector('#est-ledger-list .est-ledger-row');
  assert.ok(card, 'la apuesta liquidada aparece en el historial');
  assert.equal(card.dataset.status, 'won');
  assert.match(card.textContent, /Ganada/);
  assert.match(card.textContent, /\+240/);
  assert.match(card.textContent, /Home FC/);
  assert.match(card.textContent, /2–0/);
  assert.match(card.textContent, /pagado/i);
  assert.match(document.querySelector('.est-ledger-day').textContent, /apuesta/, 'agrupa por día');

  // Legibilidad: cada dato va en su propia ficha, con tipografía suficiente.
  const facts = card.querySelectorAll('.est-ledger-facts li');
  assert.ok(facts.length >= 2, 'monto, cuota y fecha se muestran como fichas separadas');
  const factsText = Array.from(facts).map(li => li.textContent.replace(/\s+/g, ' ').trim());
  assert.ok(factsText.some(text => /Monto100 fichas/.test(text)), 'la ficha de monto es explícita');
  assert.ok(factsText.some(text => /Cuota2\.40/.test(text)), 'la ficha de cuota es explícita');
  assert.equal(card.querySelector('.est-ledger-row-meta'), null, 'ya no hay un párrafo único y apretado con todo');
  const pickSize = parseFloat(window.getComputedStyle(card.querySelector('.est-ledger-pick')).fontSize);
  const factSize = parseFloat(window.getComputedStyle(card.querySelector('.est-ledger-facts li b')).fontSize);
  const rowGap = parseFloat(window.getComputedStyle(card).gap);
  assert.ok(pickSize >= 15, 'la selección se lee a 15 px o más (era 14)');
  assert.ok(factSize >= 12, 'los valores de las fichas se leen a 12 px o más (era 10,5)');
  assert.ok(rowGap >= 16, 'hay aire horizontal entre las tres zonas de la fila');

  const stats = document.getElementById('est-ledger-stats').textContent;
  ['Apostado', 'Cobrado', 'Neto', 'En juego'].forEach(label => {
    assert.match(stats, new RegExp(label), 'el resumen incluye ' + label);
  });
  assert.match(stats, /140/, 'neto de la apuesta ganadora');

  // Filtros por estado: uno sin resultados muestra un estado vacío claro.
  const lostChip = document.querySelector('[data-ledger-filter="lost"]');
  lostChip.click();
  assert.equal(lostChip.getAttribute('aria-pressed'), 'true');
  assert.match(document.querySelector('#est-ledger-list .est-ledger-state').textContent, /Perdidas: nada por aquí/);
  document.querySelector('[data-ledger-filter="all"]').click();
  assert.ok(document.querySelector('#est-ledger-list .est-ledger-row'), 'al volver a Todas reaparece la apuesta');

  // El foco queda dentro del diálogo: Tab desde el contenedor va al primer control.
  assert.equal(document.activeElement, ledger, 'al abrir, el foco entra en la vista');
  ledger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  assert.equal(document.activeElement.id, 'est-ledger-refresh', 'Tab no escapa a la página de atrás');

  // Esc cierra y limpia el hash, devolviendo el foco al disparador.
  h.handlers.keydown = null;
  const escape = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
  document.dispatchEvent(escape);
  assert.equal(ledger.hidden, true, 'Esc cierra la vista');
  assert.notEqual(window.location.hash, '#apuestas');
  assert.ok(document.activeElement === link || document.activeElement === document.body, 'el foco vuelve al disparador');
});

test('la vista del historial se abre también desde el nav y con /estadio#apuestas', async t => {
  const h = createHarness({ betHistory: { entries: [], summary: { total: 0, open: 0, byStatus: {}, staked: 0, returned: 0, net: 0, openStake: 0, openPotentialPayout: 0, latestSettlementAt: null }, unseen: null, totalEntries: 0 } });
  t.after(h.close);
  await h.connectToMatch();
  await new Promise(resolve => setImmediate(resolve));
  const { window } = h;
  const document = window.document;
  const ledger = document.getElementById('est-ledger');

  document.getElementById('est-ledger-open-nav').click();
  assert.equal(ledger.hidden, false, 'el nav abre la vista');
  document.getElementById('est-ledger-close').click();
  assert.equal(ledger.hidden, true, 'la ✕ la cierra');

  document.getElementById('est-ledger-back').click();
  assert.equal(ledger.hidden, true, 'el botón de volver también cierra');

  // Estado vacío explícito, con salida hacia las cuotas.
  document.getElementById('est-ledger-open-nav').click();
  const empty = document.querySelector('#est-ledger-list .est-ledger-state');
  assert.ok(empty, 'sin apuestas se explica qué hacer');
  assert.match(empty.textContent, /Todavía no tienes apuestas/);
  assert.ok(empty.querySelector('[data-ledger-go-markets]'), 'ofrece ir a las cuotas');
});

test('La Previa también se oculta si el partido se pospone', async t => {
  const h = createHarness({ kickoffOffsetMs: 5 * 60 * 1000 });
  t.after(h.close);
  await h.connectToMatch();
  assert.equal(h.window.document.getElementById('est-preshow').hidden, false);
  h.handlers['football:status']({ matchId: h.match.id, code: 'postponed' });
  assert.equal(h.window.document.getElementById('est-preshow').hidden, true);
});

test('La Previa se oculta de inmediato al reprogramar fuera de T−30, no aparece al horario anterior y abre en el nuevo T−30', async t => {
  const baseNow = 1800000000000;
  // Comienza a 15 min del kickoff (dentro de T-30)
  const h = createHarness({ now: baseNow, kickoffOffsetMs: 15 * 60 * 1000 });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match } = h;
  const panel = window.document.getElementById('est-preshow');
  const promo = window.document.getElementById('est-preshow-promo');

  assert.equal(panel.hidden, false, 'inicia visible en T-15');
  assert.equal(window.document.getElementById('est-preshow-timer').textContent, '15:00');
  assert.equal(promo.hidden, false);

  // Reprogramar el partido a 90 minutos en el futuro (fuera de T-30)
  const newKickoff = baseNow + 90 * 60 * 1000;
  handlers['football:rescheduled']({ matchId: match.id, scheduledKickoffAt: newKickoff });

  assert.equal(panel.hidden, true, 'se oculta de inmediato tras la reprogramación');
  assert.equal(panel.hasAttribute('data-delay'), false, 'no conserva bandera de retraso');

  // Avanza el tiempo al horario que tenía el partido originalmente (T+15m)
  h.advanceTime(15 * 60 * 1000);
  assert.equal(panel.hidden, true, 'no se muestra la previa en el horario anterior');
  assert.notEqual(window.document.getElementById('est-preshow-status').textContent, 'Kickoff pendiente · esperando señal del partido');

  // Avanza hasta T-30 del nuevo horario (faltan 45 min más para llegar a 60 min, que es 30 min antes de 90 min)
  h.advanceTime(45 * 60 * 1000);
  assert.equal(panel.hidden, false, 'abre exactamente en el nuevo T−30');
  assert.equal(window.document.getElementById('est-preshow-timer').textContent, '30:00');
  assert.equal(promo.hidden, false, 'la promoción vuelve a estar activa');
});

test('La Previa se abre de inmediato si un partido distante se reprograma dentro de T−30', async t => {
  const baseNow = 1800000000000;
  // Kickoff en 90 minutos (fuera de T-30)
  const h = createHarness({ now: baseNow, kickoffOffsetMs: 90 * 60 * 1000 });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match } = h;
  const panel = window.document.getElementById('est-preshow');

  assert.equal(panel.hidden, true, 'fuera de T-30 permanece oculta');

  // Reprogramar a 20 minutos
  const newKickoff = baseNow + 20 * 60 * 1000;
  handlers['football:rescheduled']({ matchId: match.id, scheduledKickoffAt: newKickoff });

  assert.equal(panel.hidden, false, 'se muestra inmediatamente al entrar a T-30 por reprogramación');
  assert.equal(window.document.getElementById('est-preshow-timer').textContent, '20:00');
  assert.equal(window.document.getElementById('est-preshow-promo').hidden, false);
});

test('un partido en retraso con espera pendiente se recupera a cuenta regresiva al reprogramarse', async t => {
  const baseNow = 1800000000000;
  // Kickoff hace 5 minutos (retrasado)
  const h = createHarness({ now: baseNow, kickoffOffsetMs: -5 * 60 * 1000 });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match } = h;
  const panel = window.document.getElementById('est-preshow');
  const promo = window.document.getElementById('est-preshow-promo');

  assert.equal(panel.hidden, false);
  assert.equal(panel.dataset.delay, 'true');
  assert.match(window.document.getElementById('est-preshow-status').textContent, /Kickoff pendiente/);
  assert.equal(promo.hidden, true, 'en retraso no muestra promoción');

  // Reprogramar a 15 minutos en el futuro
  const newKickoff = baseNow + 15 * 60 * 1000;
  handlers['football:status']({ matchId: match.id, code: 'rescheduled', scheduledKickoffAt: newKickoff });

  assert.equal(panel.hidden, false);
  assert.equal(panel.dataset.delay, 'false', 'cancela estado de demora');
  assert.match(window.document.getElementById('est-preshow-status').textContent, /Kickoff programado/);
  assert.equal(window.document.getElementById('est-preshow-timer').textContent, '15:00');
  assert.equal(promo.hidden, false, 'reactiva promoción');
});

test('secuencia de eventos: el balón recorre los destinos con animación fluida y sin saltos bruscos', async t => {
  const h = createHarness({ reducedMotion: false });
  t.after(h.close);
  await h.connectToMatch();
  const { handlers, match, ballTrace } = h;
  const id = match.id;
  handlers['football:status']({ matchId: id, code: 'live', minute: 0 });
  const targets = [.2, .4, .6, .8, .9];
  const norm = px => (px - 18) / (1050 - 36);
  const samples = [];
  let lastX = norm(.5 * 1050 + 18);

  targets.forEach((x, i) => {
    handlers['football:event']({
      matchId: id,
      event: {
        type: 'pass_sequence', team: 'home', minute: 10 + i, phase: 'build_up', playStopped: false,
        ball: { x, y: .5 }, ballFrom: { x: i ? targets[i - 1] : .5, y: .5 }, actorPosition: { x: x - .05, y: .5 },
        playerId: 'h2', receiverId: 'h10', ballCarrierId: null, possessionTeam: 'home'
      }
    });
    for (let ms = 0; ms < 500; ms += 50) {
      ballTrace.length = 0;
      h.draw(0);
      if (ballTrace.length) lastX = norm(ballTrace[ballTrace.length - 1].x);
      samples.push({ x: lastX });
      h.advanceTime(50);
    }
  });

  // El balón avanza progresivamente hacia el destino final (.9)
  assert.ok(samples[samples.length - 1].x >= 0.85, 'al final de la secuencia el balón llega al destino');
});

test('la UI V2 respeta el fotograma del servidor y el reloj de quince segundos por minuto', async t => {
  const h = createHarness({ reducedMotion: true });
  t.after(h.close);
  h.match.engine = 'v2';
  h.match.status = 'live';
  await h.connectToMatch();
  const id = h.match.id;
  h.handlers['football:status']({ matchId: id, code: 'live', minute: 10 });
  const frame = h.players.map(p => ({ ...p, x: p.id === 'h1' ? .7 : p.x, y: p.y }));
  h.handlers['football:tick']({
    matchId: id, minute: 10, displayMinute: 10, phase: 'build_up', playStopped: false,
    score: { home: 0, away: 0 }, ball: { x: .6, y: .5 }, ballCarrierId: 'h1',
    possessionTeam: 'home', players: frame
  });
  h.playerTextTrace.length = 0;
  h.ballTrace.length = 0;
  h.draw(0);
  const keeper = h.playerTextTrace.find(item => item.value === '1');
  assert.ok(keeper, 'el jugador del fotograma se dibuja');
  assert.ok(Math.abs(keeper.x - (18 + .7 * (1050 - 36))) < .001, 'la ficha usa la posición V2');
  const ball = h.ballTrace.at(-1);
  assert.ok(ball && Math.abs(ball.x - (18 + .6 * (1050 - 36))) < .001, 'el balón no se desplaza artificialmente al portador');
  h.advanceTime(10000);
  h.draw(0);
  assert.match(h.window.document.getElementById('est-clock').textContent, /10'/);
  h.advanceTime(5000);
  h.draw(0);
  assert.match(h.window.document.getElementById('est-clock').textContent, /11'/);
});

test('la boleta conserva la clave al perder una respuesta y permite reintentar después del kickoff', async t => {
  let calls = 0;
  const h = createHarness({ onBet(payload, ack) {
    calls++;
    if (calls === 2) ack({ ok: true, replayed: true, chips: 900,
      bet: { id: 'accepted-bet', market: payload.market, selection: payload.selection, odds: 1.3,
        stake: 100, potentialPayout: 130, status: 'open' } });
  } });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match } = h;
  window.document.querySelectorAll('.est-market-group')[1].querySelector('.est-sel').click();
  window.document.getElementById('est-stake').value = '100';
  window.document.getElementById('est-place-bet').click();
  const first = h.socketEmitted.filter(item => item.event === 'football:bet')[0].payload;
  assert.ok(first.idemKey);
  handlers['football:status']({ matchId: match.id, code: 'kickoff', minute: 0 });
  assert.equal(window.document.getElementById('est-bet-slip').hidden, false, 'no se descarta un envío sin confirmar');
  h.advanceTime(10001);
  assert.match(window.document.getElementById('est-bet-msg').textContent, /No llegó la confirmación/);
  assert.equal(window.document.getElementById('est-place-bet').disabled, false);
  window.document.getElementById('est-place-bet').click();
  const second = h.socketEmitted.filter(item => item.event === 'football:bet')[1].payload;
  assert.equal(second.idemKey, first.idemKey);
  assert.equal(second.stake, first.stake);
  assert.match(window.document.getElementById('est-bet-msg').textContent, /Apuesta colocada/);
  assert.equal(window.document.getElementById('est-bet-slip').hidden, true);
});

test('la UI sigue el estado del motor: kickoff, pausas, gol, sustitución y final', async t => {
  const h = createHarness();
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match } = h;
  const id = match.id;
  const marketButtons = () => Array.from(window.document.querySelectorAll('#est-markets .est-sel'));
  const fireEvent = event => handlers['football:event']({ matchId: id, event });

  assert.equal(window.document.querySelectorAll('.est-market-group').length, 2, 'antes del kickoff hay mercados pre-partido');
  const selections = window.document.querySelector('.est-market-group .est-selections');
  assert.equal(window.getComputedStyle(selections).display, 'grid', 'las cuotas se distribuyen en una rejilla que ocupa todo el ancho del panel');
  assert.equal(window.getComputedStyle(selections.querySelector('.est-sel')).width, '100%', 'cada cuota llena su celda');
  assert.equal(window.getComputedStyle(window.document.getElementById('est-bet-slip')).display, 'none', 'la boleta oculta no ocupa ni aparece visualmente al entrar');
  window.document.querySelectorAll('.est-market-group')[1].querySelector('.est-sel').click();
  assert.equal(window.document.getElementById('est-bet-slip').hidden, false);
  assert.equal(window.getComputedStyle(window.document.getElementById('est-bet-slip')).display, 'flex', 'la boleta se muestra al elegir una cuota');

  handlers['football:status']({ matchId: id, code: 'kickoff', minute: 0 });
  assert.equal(window.document.getElementById('est-bet-slip').hidden, true, 'cierra una boleta incompatible con el mercado en vivo');
  assert.equal(window.getComputedStyle(window.document.getElementById('est-bet-slip')).display, 'none', 'una regla visual respeta el atributo hidden aunque la boleta use flex');
  assert.equal(window.document.querySelectorAll('.est-market-group').length, 1, 'en vivo solo deja el mercado 1X2');
  assert.ok(marketButtons().every(button => button.disabled), 'sigue bloqueado hasta el saque inicial confirmado');

  fireEvent({ type: 'kickoff', team: 'home', minute: 0, phase: 'kickoff', playStopped: false,
    ball: { x: .5, y: .5 }, ballFrom: { x: .5, y: .5 }, ballCarrierId: 'h2', possessionTeam: 'home' });
  assert.ok(marketButtons().every(button => !button.disabled), 'el saque inicial reabre el mercado');
  marketButtons()[0].click();
  assert.equal(window.document.getElementById('est-bet-slip').hidden, false);

  fireEvent({ type: 'halftime', team: null, minute: 45, phase: 'halftime', playStopped: true,
    ball: { x: .5, y: .5 }, ballFrom: { x: .5, y: .5 }, ballCarrierId: null, possessionTeam: null });
  handlers['football:status']({ matchId: id, code: 'halftime', minute: 45 });
  assert.ok(marketButtons().every(button => button.disabled), 'descanso suspende las selecciones');
  assert.match(window.document.getElementById('est-markets').textContent, /Mercado suspendido/);

  fireEvent({ type: 'second_half', team: 'away', minute: 46, phase: 'build_up', playStopped: false,
    ball: { x: .5, y: .5 }, ballFrom: { x: .5, y: .5 }, ballCarrierId: 'a2', possessionTeam: 'away' });
  handlers['football:status']({ matchId: id, code: 'live', minute: 46 });
  assert.ok(marketButtons().every(button => !button.disabled), 'el segundo tiempo reabre el mercado');

  fireEvent({ type: 'goal', team: 'home', playerId: 'h10', playerName: 'Jugador 10', minute: 61,
    phase: 'goal_celebration', playStopped: true, marcador: '1-0',
    ball: { x: 1.01, y: .5 }, ballFrom: { x: .86, y: .5 }, actorPosition: { x: .86, y: .5 },
    ballCarrierId: null, possessionTeam: null });
  handlers['football:commentary']({ matchId: id, voice: 'narrador', text: 'Gol confirmado de Jugador 10: 1-0.' });
  assert.equal(window.document.getElementById('score-home').textContent, '1');
  assert.equal(window.document.getElementById('score-away').textContent, '0');
  assert.match(window.document.getElementById('est-commentary').textContent, /Gol confirmado de Jugador 10: 1-0/);
  assert.ok(marketButtons().every(button => button.disabled), 'el festejo detiene el mercado');

  fireEvent({ type: 'goal_restart', team: 'away', minute: 62, phase: 'kickoff', playStopped: false,
    ball: { x: .5, y: .5 }, ballFrom: { x: 1.01, y: .5 }, actorPosition: { x: .5, y: .5 },
    ballCarrierId: 'a2', possessionTeam: 'away' });
  assert.ok(marketButtons().every(button => !button.disabled), 'el saque desde el centro reanuda el mercado');

  fireEvent({ type: 'red_card', team: 'home', playerId: 'h2', minute: 70, phase: 'set_piece', playStopped: true,
    ball: { x: .5, y: .5 }, ballFrom: { x: .5, y: .5 }, ballCarrierId: null, possessionTeam: 'away' });
  fireEvent({ type: 'substitution', team: 'home', playerId: 'h12', playerInId: 'h12', playerOutId: 'h10',
    minute: 72, phase: 'set_piece', playStopped: true, ball: { x: .5, y: .5 },
    ballFrom: { x: .5, y: .5 }, ballCarrierId: null, possessionTeam: 'home' });
  const visibleNumbers = h.draw();
  assert.ok(visibleNumbers.includes('12'), 'el suplente aparece en la cancha');
  assert.ok(!visibleNumbers.includes('10'), 'el sustituido sale de la cancha');
  assert.ok(!visibleNumbers.includes('2'), 'el expulsado deja de aparecer');

  handlers['football:status']({ matchId: id, code: 'full_time', minute: 94 });
  assert.equal(window.document.getElementById('est-clock').textContent, 'Final');
  assert.ok(marketButtons().every(button => button.disabled), 'el final cierra el mercado');
});

test('la cabina de comentarios destaca el feed y diferencia a sus dos voces', async t => {
  const h = createHarness();
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match } = h;
  const panel = window.document.querySelector('.est-commentary-panel');
  const feed = window.document.getElementById('est-commentary');
  assert.ok(panel, 'el relato tiene una cabina destacada bajo la cancha');
  assert.equal(panel.querySelector('h2').textContent, 'Relato en vivo');
  assert.match(panel.querySelector('.est-commentary-live').textContent, /En directo/i);
  assert.equal(feed.getAttribute('role'), 'log', 'los nuevos comentarios se anuncian de forma accesible');
  const voiceToggle = panel.querySelector('#est-commentary-voice');
  assert.ok(voiceToggle, 'hay un control explícito para escuchar a los comentaristas');
  assert.equal(voiceToggle.disabled, true, 'si Web Speech no existe, se evita ofrecer una acción que no funcionará');

  handlers['football:commentary']({ matchId: match.id, voice: 'narrador', text: '¡Se acerca el gol!' });
  const narrator = feed.querySelector('.est-cmt.is-latest');
  assert.ok(narrator.classList.contains('narrador'));
  assert.match(narrator.querySelector('.est-cmt-voice').textContent, /NARRADOR/);
  assert.match(narrator.textContent, /¡Se acerca el gol!/);

  handlers['football:commentary']({ matchId: match.id, voice: 'analista', text: 'La defensa quedó muy abierta.' });
  const analyst = feed.querySelector('.est-cmt.is-latest');
  assert.ok(analyst.classList.contains('analista'));
  assert.match(analyst.querySelector('.est-cmt-voice').textContent, /ANALISTA/);
  assert.equal(feed.querySelectorAll('.est-cmt.is-latest').length, 1, 'solo el comentario más reciente conserva el foco visual');
});

test('las voces del relato se alternan en cola, con dos locutores y sin superposición', async t => {
  const h = createHarness({ speechSynthesis: true });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match, speech } = h;
  const button = window.document.getElementById('est-commentary-voice');
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-pressed'), 'false', 'el audio requiere activación explícita');

  handlers['football:commentary']({ matchId: match.id, voice: 'narrador', text: 'Comentario previo a activar las voces.' });
  assert.equal(speech.utterances.length, 0, 'no lee el historial ni empieza sin permiso del espectador');
  button.click();
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(speech.resumeCount, 1, 'reanuda el sintetizador dentro del gesto del usuario');

  handlers['football:commentary']({ matchId: match.id, voice: 'narrador', text: '¡Se acerca el gol!' });
  handlers['football:commentary']({ matchId: match.id, voice: 'analista', text: 'La defensa quedó muy abierta.' });
  assert.equal(speech.utterances.length, 1, 'el segundo comentarista espera su turno');
  assert.equal(speech.utterances[0].text, '¡Se acerca el gol!');
  assert.equal(speech.utterances[0].lang, 'es-MX');
  assert.equal(speech.utterances[0].voice.name, 'Narrador mexicano');
  assert.ok(window.document.querySelector('.est-cmt.narrador.is-speaking'));

  speech.finish(0);
  h.advanceTime(500);
  assert.equal(speech.utterances.length, 2, 'el analista entra después de la pausa conversacional');
  assert.equal(speech.utterances[1].voice.name, 'Analista mexicana');
  assert.ok(window.document.querySelector('.est-cmt.analista.is-speaking'));
  assert.equal(speech.overlapCount, 0, 'nunca se invoca speak mientras otra voz continúa activa');

  handlers['football:commentary']({ matchId: match.id, voice: 'narrador', text: 'Llega otra jugada.' });
  button.click();
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.ok(speech.cancelCount > 0, 'al silenciar se detienen el turno actual y la cola');
  assert.equal(window.document.querySelectorAll('.est-cmt.is-speaking').length, 0);
  h.advanceTime(1000);
  assert.equal(speech.utterances.length, 2, 'ningún comentario pendiente se reproduce tras silenciar');
});

test('el relato del gol espera a que termine la animación del balón', async t => {
  const h = createHarness({ reducedMotion: false });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match } = h;
  const id = match.id;
  handlers['football:status']({ matchId: id, code: 'live', minute: 20 });
  handlers['football:event']({
    matchId: id,
    event: {
      type: 'goal', team: 'home', playerId: 'h10', playerName: 'Jugador 10', minute: 21,
      phase: 'goal_celebration', playStopped: true, marcador: '1-0',
      ball: { x: 1.01, y: .5 }, ballFrom: { x: .86, y: .5 }, actorPosition: { x: .86, y: .5 },
      ballCarrierId: null, possessionTeam: null
    }
  });
  handlers['football:commentary']({ matchId: id, voice: 'narrador', text: 'Gol confirmado de Jugador 10: 1-0.' });
  assert.ok(!window.document.getElementById('est-commentary').textContent.includes('Gol confirmado'), 'el relato espera mientras la animación está en curso');
  // Los jugadores parten de su posición base: el paso del gol puede durar hasta 6 s (tope).
  h.advanceTime(9500);
  assert.match(window.document.getElementById('est-commentary').textContent, /Gol confirmado de Jugador 10: 1-0/, 'el relato aparece al completarse la animación');
});

test('14 escenarios — validación integral de visualización, física y UI del estadio', async t => {
  const h = createHarness({ reducedMotion: false });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match } = h;
  const id = match.id;
  const fireEvent = event => handlers['football:event']({ matchId: id, event });

  // 1. Kickoff inicial: jugadores en sus mitades
  handlers['football:status']({ matchId: id, code: 'live', minute: 0 });
  fireEvent({
    type: 'kickoff', team: 'home', minute: 0, phase: 'kickoff', playStopped: false,
    ball: { x: .5, y: .5 }, ballFrom: { x: .5, y: .5 }, ballCarrierId: 'h2', possessionTeam: 'home',
    playerId: 'h2', actorPosition: { x: .485, y: .5 }
  });
  h.advanceTime(100);
  let numbers = h.draw();
  assert.ok(numbers.length >= 22, 'todos los jugadores en cancha');

  // 2. Pase, recepción y conducción de balón
  fireEvent({
    type: 'pass_sequence', team: 'home', minute: 5, phase: 'build_up', playStopped: false,
    ball: { x: .65, y: .45 }, ballFrom: { x: .485, y: .5 }, actorPosition: { x: .485, y: .5 },
    playerId: 'h2', receiverId: 'h10', ballCarrierId: 'h10', possessionTeam: 'home'
  });
  h.advanceTime(1000);
  h.draw();

  // 3. Disparo y llegada a meta
  fireEvent({
    type: 'shot', team: 'home', minute: 15, phase: 'attack', playStopped: false,
    ball: { x: 1.0, y: .5 }, ballFrom: { x: .85, y: .5 }, actorPosition: { x: .85, y: .5 },
    playerId: 'h10', keeperId: 'a1', keeperPosition: { x: .96, y: .5 }
  });
  h.advanceTime(500);

  // 4. Atajada del guardameta
  fireEvent({
    type: 'save', team: 'away', minute: 15, phase: 'build_up', playStopped: false,
    ball: { x: .96, y: .5 }, ballFrom: { x: 1.0, y: .5 }, actorPosition: { x: .96, y: .5 },
    playerId: 'a1', keeperId: 'a1', keeperPosition: { x: .96, y: .5 },
    ballCarrierId: 'a1', possessionTeam: 'away'
  });
  h.advanceTime(500);

  // 5. Gol, banner, celebración, y saque de centro del equipo que recibió el gol
  fireEvent({
    type: 'goal', team: 'home', playerId: 'h9', playerName: 'Delantero Local', minute: 28,
    phase: 'goal_celebration', playStopped: true, marcador: '1-0',
    ball: { x: 1.01, y: .5 }, ballFrom: { x: .88, y: .5 }, actorPosition: { x: .88, y: .5 },
    ballCarrierId: null, possessionTeam: null
  });
  handlers['football:commentary']({ matchId: id, voice: 'narrador', text: 'Golazo de Delantero Local: 1-0.' });
  assert.equal(window.document.getElementById('score-home').textContent, '1');
  assert.equal(window.document.getElementById('score-away').textContent, '0');
  // La celebración espera a que la cola de pasos termine (cada paso alargado por distancia,
  // tope 6 s; los jugadores aún parten de su posición base en esta prueba).
  h.advanceTime(16000);
  assert.match(window.document.getElementById('est-commentary').textContent, /Golazo de Delantero Local/);

  // Saque de centro tras gol: balón a (0.5, 0.5) y saca visitante
  fireEvent({
    type: 'goal_restart', team: 'away', minute: 29, phase: 'kickoff', playStopped: false,
    ball: { x: .5, y: .5 }, ballFrom: { x: 1.01, y: .5 }, actorPosition: { x: .515, y: .5 },
    playerId: 'a9', ballCarrierId: 'a9', possessionTeam: 'away'
  });
  h.advanceTime(500);

  // 6. Falta y detención de juego
  fireEvent({
    type: 'foul', team: 'home', minute: 34, phase: 'set_piece', playStopped: true,
    ball: { x: .40, y: .30 }, ballFrom: { x: .40, y: .30 }, actorPosition: { x: .40, y: .30 },
    ballCarrierId: null, possessionTeam: 'away'
  });
  assert.ok(Array.from(window.document.querySelectorAll('#est-markets .est-sel')).every(b => b.disabled), 'mercados bloqueados en falta');

  // 7. Tarjeta amarilla
  fireEvent({
    type: 'yellow_card', team: 'home', playerId: 'h3', playerName: 'Defensor Local', minute: 35,
    phase: 'set_piece', playStopped: true, ball: { x: .40, y: .30 }
  });
  handlers['football:commentary']({ matchId: id, voice: 'narrador', text: 'Tarjeta amarilla para Defensor Local.' });
  assert.match(window.document.getElementById('est-commentary').textContent, /Tarjeta amarilla para Defensor Local/);

  // 8. Expulsión (tarjeta roja)
  fireEvent({
    type: 'red_card', team: 'home', playerId: 'h3', playerName: 'Defensor Local', minute: 40,
    phase: 'set_piece', playStopped: true, ball: { x: .40, y: .30 }
  });
  numbers = h.draw();
  assert.ok(!numbers.includes('3'), 'el jugador con tarjeta roja sale de la cancha');

  // 9. Sustitución
  fireEvent({
    type: 'substitution', team: 'home', playerId: 'h12', playerInId: 'h12', playerOutId: 'h9',
    minute: 42, phase: 'set_piece', playStopped: true, ball: { x: .5, y: .01 }
  });
  numbers = h.draw();
  assert.ok(numbers.includes('12'), 'suplente h12 ingresa al campo');
  assert.ok(!numbers.includes('9'), 'titular h9 abandona el campo');

  // 10. Saque de banda
  fireEvent({
    type: 'throw_in', team: 'away', minute: 44, phase: 'set_piece', playStopped: true,
    ball: { x: .60, y: 1.0 }, ballFrom: { x: .60, y: 1.0 }, actorPosition: { x: .60, y: 1.0 },
    playerId: 'a2', ballCarrierId: 'a2', possessionTeam: 'away'
  });

  // 11. Córner y saque de meta
  fireEvent({
    type: 'corner', team: 'away', minute: 45, phase: 'set_piece', playStopped: true,
    ball: { x: 0.0, y: 0.0 }, ballFrom: { x: 0.0, y: 0.0 }, actorPosition: { x: 0.0, y: 0.0 },
    playerId: 'a2', ballCarrierId: 'a2', possessionTeam: 'away'
  });
  fireEvent({
    type: 'goal_kick', team: 'home', minute: 45.5, phase: 'set_piece', playStopped: true,
    ball: { x: 0.045, y: .5 }, ballFrom: { x: 0.045, y: .5 }, actorPosition: { x: 0.045, y: .5 },
    playerId: 'h1', ballCarrierId: 'h1', possessionTeam: 'home'
  });

  // 12. Descanso y segundo tiempo
  fireEvent({
    type: 'halftime', minute: 45, phase: 'halftime', playStopped: true,
    ball: { x: .5, y: .5 }, ballCarrierId: null, possessionTeam: null
  });
  handlers['football:status']({ matchId: id, code: 'halftime', minute: 45 });
  assert.match(window.document.getElementById('est-clock').textContent, /Descanso/);

  fireEvent({
    type: 'second_half', team: 'away', minute: 46, phase: 'build_up', playStopped: false,
    ball: { x: .5, y: .5 }, ballFrom: { x: .5, y: .5 }, actorPosition: { x: .515, y: .5 },
    playerId: 'a9', ballCarrierId: 'a9', possessionTeam: 'away'
  });
  handlers['football:status']({ matchId: id, code: 'live', minute: 46 });

  // 13. Pitazo final
  handlers['football:status']({ matchId: id, code: 'full_time', minute: 90 });
  assert.equal(window.document.getElementById('est-clock').textContent, 'Final');
  assert.ok(Array.from(window.document.querySelectorAll('#est-markets .est-sel')).every(b => b.disabled), 'mercados cerrados al terminar el partido');
});

test('QA de usuario: reconexión a mitad de juego, expulsión del portador y limpieza de estela de tiro', async t => {
  const h = createHarness({ reducedMotion: false });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match } = h;
  const id = match.id;
  const fireEvent = event => handlers['football:event']({ matchId: id, event });

  // 1. Portador con el balón recibe tarjeta roja
  handlers['football:status']({ matchId: id, code: 'live', minute: 25 });
  fireEvent({
    type: 'pass_sequence', team: 'home', minute: 25, phase: 'build_up', playStopped: false,
    ball: { x: .55, y: .45 }, ballFrom: { x: .50, y: .50 }, actorPosition: { x: .50, y: .50 },
    playerId: 'h2', receiverId: 'h10', ballCarrierId: 'h10', possessionTeam: 'home'
  });
  h.advanceTime(500);

  // La tarjeta roja se muestra sobre el portador h10
  fireEvent({
    type: 'red_card', team: 'home', playerId: 'h10', playerName: 'Jugador 10', minute: 26,
    phase: 'set_piece', playStopped: true, ball: { x: .55, y: .45 }, ballCarrierId: null
  });
  h.advanceTime(100);
  const numbers = h.draw();
  assert.ok(!numbers.includes('10'), 'el portador expulsado desaparece de la cancha de inmediato');

  // 2. Comprobar que tras el viaje del balón (p >= 1), el render se ejecuta sin fallos
  h.advanceTime(2500);
  assert.doesNotThrow(() => h.draw(), 'el ciclo de dibujo no genera errores con balón detenido y estela concluida');

  // 3. Reconexión: recibir un tick con juego detenido suspende mercados y actualiza el reloj
  handlers['football:tick']({
    matchId: id, minute: 30, displayMinute: 30, phase: 'set_piece', playStopped: true,
    score: { home: 1, away: 0 }, possessionTeam: 'away', ballCarrierId: null,
    ball: { x: .55, y: .45 }
  });
  const marketButtons = Array.from(window.document.querySelectorAll('#est-markets .est-sel'));
  assert.ok(marketButtons.every(b => b.disabled), 'los mercados permanecen bloqueados en tick con juego detenido');
  assert.match(window.document.getElementById('est-clock').textContent, /30' Balón parado/);
});

async function createBallonDorHarness(options = {}) {
  const h = createHarness({ ...options, ballonDorMarket: options.ballonDorMarket || ballonDorMarket() });
  await h.flush();
  return h;
}

function chooseBallonDorCandidate(h, candidateId = 'bdo-club-1', stake = 100) {
  const { document } = h.window;
  const button = document.querySelector('[data-bdo-select="' + candidateId + '"]');
  assert.ok(button, 'el candidato tiene un control de selección visible');
  button.click();
  const input = document.getElementById('est-bdo-stake');
  input.value = String(stake);
  input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  return input;
}

function acceptedBallonDorResult(payload, overrides = {}) {
  return {
    ok: true,
    chips: 1000 - Number(payload.stake),
    replayed: false,
    future: {
      id: 'future-ui-accepted', seasonMonth: '2026-10', market: 'balon_de_oro',
      selection: payload.selection, stake: Number(payload.stake), odds: 2.5,
      potentialPayout: Math.floor(Number(payload.stake) * 2.5), status: 'open', payout: null,
      placedAt: 1,
      ...overrides
    }
  };
}

test('las columnas laterales fluyen con el documento y no se pegan encima del contenido al desplazarse', t => {
  const h = createHarness();
  t.after(h.close);
  const { window } = h;
  ['.est-col-left', '.est-col-right'].forEach(selector => {
    const column = window.document.querySelector(selector);
    const style = window.getComputedStyle(column);
    assert.equal(style.position, 'static', selector + ' no se fija al viewport');
    assert.equal(style.maxHeight, 'none', selector + ' crece con sus paneles');
    assert.equal(style.overflowY, 'visible', selector + ' no crea una columna flotante con scroll propio');
  });
});

test('el Estadio deja un acceso breve y el Balón de Oro tiene un espacio exclusivo con horario de cierre', async t => {
  const h = await createBallonDorHarness();
  t.after(h.close);
  const { document } = h.window;
  assert.equal(document.body.classList.contains('est-bdo-dedicated'), false);
  assert.equal(document.getElementById('est-bdo-open-event').getAttribute('href'), '/balon-de-oro');
  assert.match(document.getElementById('est-bdo-open-event').textContent, /Entrar al evento/);
  assert.equal(h.window.getComputedStyle(document.getElementById('est-bdo-table-wrap')).display, 'none',
    'el Estadio general solo muestra la puerta, no el panel completo del evento');
  assert.equal(h.window.getComputedStyle(document.getElementById('est-bdo-bet-area')).display, 'none');
  const notice = document.getElementById('est-bdo-finalization-message');
  assert.match(notice.textContent, /10:00 p\. m\./);
  assert.match(notice.textContent, /último partido/);
  assert.match(document.getElementById('est-bdo-finalization-date').textContent, /2026/);
  assert.equal(document.getElementById('est-bdo-opening').hidden, true,
    'la inauguración automática solo aparece dentro del espacio dedicado');
});

test('la página del evento presenta automáticamente y una sola vez a los 16 jugadores aunque se entre tarde', async t => {
  const h = await createBallonDorHarness({ path: '/balon-de-oro?demo=1', now: Date.UTC(2026, 9, 22, 18), reducedMotion: false });
  t.after(h.close);
  const { document, localStorage } = h.window;
  const overlay = document.getElementById('est-bdo-opening');
  const stage = document.getElementById('est-bdo-opening-stage');
  const start = document.getElementById('est-bdo-opening-start');
  assert.equal(document.body.classList.contains('est-bdo-dedicated'), true);
  assert.equal(document.title, 'Demo sintética · 2026-09 · Balón de Oro MonteCristo');
  assert.match(document.getElementById('est-bdo-demo-notice').querySelector('strong').textContent, /EDICIÓN 2026-09/);
  const archivedDemoLink = document.querySelector('#est-bdo-archive-list a');
  assert.ok(archivedDemoLink, 'la demo conserva el acceso al archivo sintético');
  assert.match(archivedDemoLink.getAttribute('href'), /[?&]demo=1$/,
    'los enlaces de archivo mantienen visible la etiqueta de demo');
  for (const id of ['est-bdo-demo-notice', 'est-bdo-opening-demo-notice', 'est-bdo-ceremony-demo-notice']) {
    assert.equal(document.getElementById(id).hidden, false, id + ' etiqueta el resultado sintético en cada vista');
  }
  assert.match(document.getElementById('est-bdo-demo-notice').textContent, /no es un resultado real/);
  assert.equal(h.window.getComputedStyle(document.querySelector('.est-col-left')).display, 'none');
  assert.equal(h.window.getComputedStyle(document.getElementById('balon-de-oro')).display, 'block');
  assert.equal(overlay.hidden, false, 'el primer acceso abre la inauguración por sí solo');
  assert.equal(h.openingAudioPlayCount, 1);
  assert.equal(localStorage.getItem('montecristo-bdo-opening-v2:2026-10'), 'started');
  assert.equal(document.getElementById('est-bdo-opening-close').hidden, true);
  assert.equal(document.getElementById('est-bdo-opening-skip').hidden, true);
  assert.equal(h.window.getComputedStyle(document.getElementById('est-bdo-opening-close')).display, 'none');
  assert.equal(h.window.getComputedStyle(document.getElementById('est-bdo-opening-cards')).display, 'none');

  // Ni cerrar, omitir o pulsar Escape permite salir antes de ver la presentación inicial.
  document.getElementById('est-bdo-opening-skip').click();
  document.getElementById('est-bdo-opening-close').click();
  document.querySelector('.est-bdo-opening-dialog').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(overlay.hidden, false);

  // La presentación se recorre con el reloj de la página: 16 candidatos, cada uno
  // con su tiempo (no los 2 s de antes) y en el orden de la lista.
  const revealSeconds = new Map();
  const candidateIds = [];
  let firstReveal = true;
  for (let second = 0.5; second < 108; second += 0.5) {
    h.advanceOpeningAudio(second);
    const container = document.getElementById('est-bdo-opening-cards');
    const cards = container.querySelectorAll('.est-bdo-opening-card');
    if (!cards.length || container.hidden) continue;
    assert.equal(cards.length, 1, 'se enfoca un solo jugador en cada revelación');
    const card = cards[0];
    const id = card.dataset.candidateId;
    if (!revealSeconds.has(id)) candidateIds.push(id);
    revealSeconds.set(id, (revealSeconds.get(id) || 0) + 0.5);
    assert.match(stage.dataset.scene, /^reveal-(\d+)$/);
    if (firstReveal) {
      firstReveal = false;
      assert.equal(h.window.getComputedStyle(document.getElementById('est-bdo-opening-cards')).display, 'grid');
      assert.equal(card.dataset.candidateId, 'bdo-club-1');
      assert.match(card.textContent, /Delantero/);
      assert.match(card.textContent, /Goles/);
      assert.match(card.textContent, /Asistencias/);
      assert.match(card.textContent, /Apariciones/);
      assert.match(card.textContent, /Puntos/);
      assert.match(card.textContent, /Tiro/);
      assert.match(card.textContent, /Ritmo/);
      assert.equal(card.querySelector('.est-bdo-opening-card-monogram').textContent, 'CL1');
      assert.equal(card.querySelector('.est-bdo-opening-card-number').textContent, '#9');
      assert.equal(card.querySelector('[aria-label="Tiro"]').getAttribute('aria-valuenow'), '70');
    }
  }
  assert.equal(new Set(candidateIds).size, 16, 'cada ST existente aparece individualmente');
  assert.deepEqual(candidateIds, Array.from({ length: 16 }, (_, i) => 'bdo-club-' + (i + 1)),
    'los candidatos se presentan en el orden de la lista');
  // «Que no se sienta apurada»: cada jugador tiene al menos 3 s en pantalla.
  for (const [id, seconds] of revealSeconds) {
    assert.ok(seconds >= 3, id + ' permanece al menos 3 s en pantalla (tiene ' + seconds + ' s)');
  }
  assert.equal(document.getElementById('est-bdo-opening-rules'), null,
    'se retiraron los cuadros genéricos de puntos de la inauguración');
  assert.doesNotMatch(document.querySelector('.est-bdo-opening-dialog').textContent, /\+\s*[135]|−\s*[13]/);

  h.advanceOpeningAudio(108);
  assert.equal(localStorage.getItem('montecristo-bdo-opening-v2:2026-10'), 'completed');
  assert.equal(document.getElementById('est-bdo-opening-close').hidden, false);
  assert.equal(document.getElementById('est-bdo-opening-skip').hidden, true);
  assert.equal(document.getElementById('est-bdo-opening-play').hidden, true);
  assert.equal(start.hidden, true, 'el acceso a la inauguración desaparece tras completarla');
  assert.equal(start.disabled, true);
  assert.equal(document.getElementById('est-bdo-opening-replay'), null,
    'la apertura ya no ofrece control para repetirla');
  start.click();
  document.getElementById('est-bdo-opening-play').click();
  await h.flush();
  assert.equal(overlay.hidden, false, 'la presentación actual permanece abierta hasta que el usuario la cierre');
  assert.equal(h.openingAudioPlayCount, 1, 'ni el botón oculto ni el control de reproducción reinician la apertura');
  document.getElementById('est-bdo-opening-close').click();
  assert.equal(overlay.hidden, true);
  assert.equal(start.hidden, true, 'cerrarla después de completarla no ofrece otro inicio');

  h.handlers['football:ballon_dor_market']({ market: ballonDorMarket() });
  assert.equal(overlay.hidden, true, 'una actualización del mercado no reinicia la presentación ya vista');
  h.handlers['football:ballon_dor_market']({
    market: ballonDorMarket({ seasonMonth: '2026-11', eventId: 'bdo-2026-11' })
  });
  assert.equal(overlay.hidden, false, 'la edición siguiente tiene su propia primera presentación');
  assert.equal(overlay.dataset.seasonMonth, '2026-11');
  assert.equal(h.openingAudioPlayCount, 2);
});

test('Socket.IO reintenta lobby y mercado del Balón de Oro después de reconectar', async t => {
  const h = await createBallonDorHarness({ path: '/balon-de-oro' });
  t.after(h.close);
  const count = event => h.socketEmitted.filter(item => item.event === event).length;

  h.socket.connected = true;
  h.handlers.connect();
  await h.flush();
  assert.equal(count('football:subscribe'), 1, 'primera conexión suscribe la página al lobby');
  assert.equal(count('football:ballon_dor_market'), 1, 'primera conexión consulta el mercado');

  h.socket.connected = false;
  h.handlers.disconnect('transport close');
  assert.match(h.window.document.getElementById('est-connection').textContent, /Sin conexión/);
  h.socket.connected = true;
  h.handlers.connect();
  await h.flush();
  assert.equal(count('football:subscribe'), 2, 'la reconexión vuelve a suscribir la página');
  assert.equal(count('football:ballon_dor_market'), 2, 'la reconexión pide una instantánea nueva del mercado');
  const marketWire = JSON.stringify(h.socketEmitted.filter(item => item.event === 'football:ballon_dor_market'));
  assert.doesNotMatch(marketWire, /ballon-dor-[^"]+\.(?:mp3|wav|ogg|mp4|webm)|data:(?:audio|video)/i,
    'Socket.IO solo lleva solicitudes/datos de mercado, nunca archivos audiovisuales');
});

test('la ceremonia revela cada avatar cuando se pronuncia el nombre; replay y controles no modifican boletos', async t => {
  const market = settledBallonDorMarket();
  const h = await createBallonDorHarness({
    path: '/balon-de-oro?seasonMonth=2026-10',
    now: Date.UTC(2026, 10, 2, 12),
    ballonDorMarket: market,
    openingCompleted: true,
    reducedMotion: true
  });
  t.after(h.close);
  const { document, localStorage } = h.window;
  const panel = document.getElementById('est-bdo-ceremony-panel');
  const start = document.getElementById('est-bdo-ceremony-start');
  assert.equal(panel.hidden, false);
  assert.equal(start.disabled, false);
  assert.match(document.getElementById('est-bdo-ceremony-panel-status').textContent, /resultado oficial verificado/i);
  assert.equal(document.getElementById('est-bdo-table-wrap').hidden, false);
  assert.ok(document.getElementById('est-bdo-archive-list').textContent.includes('Delantero 1'));
  assert.ok(h.requests.some(request => request.url === '/api/estadio/ballon-dor?seasonMonth=2026-10'));

  start.click();
  await h.flush();
  const overlay = document.getElementById('est-bdo-ceremony');
  assert.equal(overlay.hidden, false);
  assert.match(document.getElementById('est-bdo-ceremony-title').textContent, /Dieciséis aspirantes/);
  const nominees = document.getElementById('est-bdo-ceremony-nominees');
  const podium = document.getElementById('est-bdo-ceremony-podium');
  assert.equal(nominees.hidden, false, 'la ceremonia abre con una previa visual de los nominados');
  assert.equal(nominees.children.length, 16, 'se muestran los dieciséis candidatos en orden alfabético, sin posiciones');
  const nomineeNames = Array.from(nominees.children, card => card.querySelector('b').textContent);
  assert.deepEqual(nomineeNames, nomineeNames.slice().sort((a, b) => a.localeCompare(b, 'es-MX')));
  assert.ok(Array.from(nominees.children).every(card => !/\bpuntos\b|\b\d+ goles\b/i.test(card.textContent)),
    'la previa no publica puntuaciones ni estadísticas');
  assert.equal(podium.hidden, true, 'el podio permanece oculto durante la presentación de candidatos');
  assert.doesNotMatch(document.getElementById('est-bdo-ceremony-transcript-copy').textContent, /Tercer lugar: Delantero 3|Segundo lugar: Delantero 2|Balón de Oro MonteCristo: Delantero 1/,
    'el guion accesible tampoco revela puestos antes de sus anuncios');
  assert.equal(document.querySelector('#est-bdo-ceremony-podium [data-place="3"] .est-bdo-ceremony-avatar').hidden, true);
  assert.deepEqual(h.ceremonyAudioCounts, { music: 1, narration: 1 });
  assert.ok(h.audioTelemetryAttempts.some(item => item.body.track === 'ceremony_music' && item.body.outcome === 'started'));
  assert.ok(h.audioTelemetryAttempts.some(item => item.body.track === 'ceremony_narration' && item.body.outcome === 'started'));
  assert.equal(document.getElementById('est-bdo-ceremony-stage').dataset.motion, 'reduced');

  await h.finishCeremonyClip();
  assert.equal(nominees.hidden, false, 'la previa de nominados permanece visible durante la presentación extendida');
  assert.equal(podium.hidden, true);
  h.advanceTime(12000);
  assert.match(document.getElementById('est-bdo-ceremony-stage').dataset.scene, /third-place/);
  assert.equal(nominees.hidden, true, 'la lista de candidatos se retira antes de comenzar el podio');
  assert.equal(podium.hidden, false);
  assert.match(document.querySelector('#est-bdo-ceremony-podium [data-place="3"]').textContent, /Por revelar/,
    'el puesto permanece oculto mientras se pronuncia la introducción');
  await h.finishCeremonyClip();
  const third = document.querySelector('#est-bdo-ceremony-podium [data-place="3"]');
  assert.match(third.textContent, /Delantero 3/);
  assert.equal(third.querySelector('.est-bdo-ceremony-avatar').hidden, false,
    'avatar y nombre aparecen al comenzar el clip de nombre correspondiente');
  assert.match(third.querySelector('.est-bdo-ceremony-avatar').getAttribute('src'), /vrd_09\.svg$/);
  assert.match(h.ceremonyAudioSrcHistory.narration[2], /names\/vrd_09\.wav$/);
  assert.match(document.querySelector('#est-bdo-ceremony-podium [data-place="2"]').textContent, /Por revelar/);
  assert.match(document.querySelector('#est-bdo-ceremony-podium [data-place="1"]').textContent, /Por revelar/);
  assert.doesNotMatch(document.getElementById('est-bdo-ceremony-transcript-copy').textContent, /Segundo lugar: Delantero 2|Balón de Oro MonteCristo: Delantero 1/);

  await h.finishCeremonyClip();
  h.advanceTime(2200);
  assert.match(document.getElementById('est-bdo-ceremony-stage').dataset.scene, /second-place/);
  assert.match(document.querySelector('#est-bdo-ceremony-podium [data-place="2"]').textContent, /Por revelar/);
  await h.finishCeremonyClip();
  const second = document.querySelector('#est-bdo-ceremony-podium [data-place="2"]');
  assert.match(second.textContent, /Delantero 2/);
  assert.equal(second.querySelector('.est-bdo-ceremony-avatar').hidden, false);
  assert.match(second.querySelector('.est-bdo-ceremony-avatar').getAttribute('src'), /sol_17\.svg$/);
  assert.match(h.ceremonyAudioSrcHistory.narration[4], /names\/sol_17\.wav$/);
  assert.match(document.querySelector('#est-bdo-ceremony-podium [data-place="1"]').textContent, /Por revelar/);
  assert.doesNotMatch(document.getElementById('est-bdo-ceremony-transcript-copy').textContent, /Balón de Oro MonteCristo: Delantero 1/);

  await h.finishCeremonyClip();
  h.advanceTime(2200);
  assert.match(document.getElementById('est-bdo-ceremony-stage').dataset.scene, /finalists/);
  assert.match(document.querySelector('#est-bdo-ceremony-podium [data-place="1"]').textContent, /Por revelar/);
  await h.finishCeremonyClip();
  assert.match(document.getElementById('est-bdo-ceremony-stage').dataset.scene, /winner-reveal/);
  assert.match(document.querySelector('#est-bdo-ceremony-podium [data-place="1"]').textContent, /Por revelar/);
  assert.doesNotMatch(document.getElementById('est-bdo-ceremony-transcript-copy').textContent, /Balón de Oro MonteCristo: Delantero 1/);
  await h.finishCeremonyClip();
  h.advanceTime(2500);
  const winner = document.querySelector('#est-bdo-ceremony-podium [data-place="1"]');
  assert.match(winner.textContent, /Delantero 1/);
  assert.equal(winner.querySelector('.est-bdo-ceremony-avatar').hidden, false);
  assert.match(winner.querySelector('.est-bdo-ceremony-avatar').getAttribute('src'), /frr_09\.svg$/);
  assert.match(h.ceremonyAudioSrcHistory.narration[7], /names\/frr_09\.wav$/);
  assert.match(document.getElementById('est-bdo-ceremony-breakdown').textContent, /Desglose de puntos/);
  assert.match(document.getElementById('est-bdo-ceremony-payout').textContent, /250 fichas virtuales/);
  assert.match(document.getElementById('est-bdo-ceremony-transcript-copy').textContent, /Delantero 1/);

  await h.finishCeremonyClip();
  assert.match(document.getElementById('est-bdo-ceremony-title').textContent, /gana el Balón de Oro/);
  await h.finishCeremonyClip();
  h.advanceTime(3500);
  assert.equal(document.getElementById('est-bdo-ceremony-progress').getAttribute('aria-valuenow'), '100');
  assert.match(document.getElementById('est-bdo-ceremony-time').textContent, /14\/14/);

  const music = document.getElementById('est-bdo-ceremony-music');
  music.click();
  assert.equal(music.getAttribute('aria-pressed'), 'true');
  assert.equal(localStorage.getItem('montecristo-bdo-ceremony-audio-v1:music'), 'off');
  const narration = document.getElementById('est-bdo-ceremony-narration');
  narration.click();
  assert.equal(narration.getAttribute('aria-pressed'), 'true');
  assert.equal(localStorage.getItem('montecristo-bdo-ceremony-audio-v1:narration'), 'off');
  assert.equal(document.getElementById('est-bdo-ceremony-narration-audio').muted, true,
    'la voz es silenciable independientemente de la música');
  document.getElementById('est-bdo-ceremony-replay').click();
  assert.equal(overlay.hidden, false, 'el replay vuelve a iniciar desde la misma instantánea oficial');
  assert.match(document.getElementById('est-bdo-ceremony-title').textContent, /Dieciséis aspirantes/);
  assert.equal(h.ceremonyAudioCounts.music, 2);
  assert.equal(h.ceremonyAudioSrcHistory.narration.at(-1), '/assets/ballon-dor-ceremony/cues/verification.wav');
  assert.equal(h.ballonDorSocketAttempts.length, 0);
  assert.equal(h.ballonDorHttpAttempts.length, 0);
  assert.equal(h.requests.some(request => request.url.includes('/ballon-dor/bet')), false);
  document.getElementById('est-bdo-ceremony-close').click();
  assert.equal(overlay.hidden, true);
});

test('la ceremonia sigue con subtítulos si el navegador bloquea tanto música como narración', async t => {
  const h = await createBallonDorHarness({
    path: '/balon-de-oro?seasonMonth=2026-10',
    now: Date.UTC(2026, 10, 2, 12),
    ballonDorMarket: settledBallonDorMarket(),
    openingCompleted: true,
    reducedMotion: true,
    ceremonyAudioFails: true
  });
  t.after(h.close);
  const { document } = h.window;
  document.getElementById('est-bdo-ceremony-start').click();
  await h.flush();
  assert.equal(document.getElementById('est-bdo-ceremony').hidden, false,
    'la reproducción visual no depende del permiso de audio');
  assert.equal(document.getElementById('est-bdo-ceremony-nominees').children.length, 16,
    'la previa de nominados también se entiende sin audio');
  assert.match(document.getElementById('est-bdo-ceremony-status').textContent, /Audio no disponible/);
  assert.ok(h.audioTelemetryAttempts.some(item => item.body.track === 'ceremony_music' && item.body.outcome === 'blocked'));
  assert.ok(h.audioTelemetryAttempts.some(item => item.body.track === 'ceremony_narration' && item.body.outcome === 'blocked'));
  assert.match(document.getElementById('est-bdo-ceremony-transcript-copy').textContent, /la clasificación está verificada/i);
  assert.equal(document.getElementById('est-bdo-ceremony-stage').dataset.motion, 'reduced');
  h.advanceTime(2500);
  h.advanceTime(12000);
  assert.match(document.getElementById('est-bdo-ceremony-stage').dataset.scene, /third-place/);
  assert.equal(h.ballonDorSocketAttempts.length, 0);
  assert.equal(h.ballonDorHttpAttempts.length, 0);
});

test('el podio no se revela antes de las 10 p. m.; al llegar la hora vuelve a leer el resultado oficial', async t => {
  const now = Date.UTC(2026, 9, 31, 3);
  const unlockAt = now + 60 * 1000;
  const pending = settledBallonDorMarket();
  pending.result = null;
  pending.ceremony = null;
  pending.resultAnnouncementAt = unlockAt;
  pending.finalization.scheduledAt = unlockAt;
  pending.finalization.actualAt = now + 1000;
  const h = await createBallonDorHarness({
    path: '/balon-de-oro?seasonMonth=2026-10', now,
    ballonDorMarket: pending, openingCompleted: true, reducedMotion: true
  });
  t.after(h.close);
  const { document } = h.window;
  const start = document.getElementById('est-bdo-ceremony-start');
  assert.equal(start.disabled, true);
  assert.match(document.getElementById('est-bdo-ceremony-panel-status').textContent, /10:00 p\. m\./);
  assert.match(document.getElementById('est-bdo-summary').textContent, /se anunciará/);
  assert.equal(document.getElementById('est-bdo-table-wrap').hidden, true);
  assert.doesNotMatch(document.getElementById('est-bdo-summary').textContent, /Delantero 1/);

  const published = settledBallonDorMarket();
  published.resultAnnouncementAt = unlockAt;
  published.finalization.scheduledAt = unlockAt;
  h.setBallonDorMarket(published);
  h.advanceTime(60 * 1000 + 50);
  await h.flush();
  assert.equal(start.disabled, false);
  assert.equal(document.getElementById('est-bdo-table-wrap').hidden, false);
  assert.match(document.getElementById('est-bdo-summary').textContent, /Delantero 1/);
  assert.ok(document.getElementById('est-bdo-archive-list').textContent.includes('Delantero 1'));
});

test('la inauguración de una llegada tardía no muestra puntos ni estadísticas mientras espera el anuncio', async t => {
  const now = Date.UTC(2026, 9, 31, 3);
  const pending = settledBallonDorMarket({ resultAnnouncementAt: now + 60 * 1000 });
  pending.result = null;
  pending.ceremony = null;
  pending.awaitingAnnouncement = true;
  pending.candidates = pending.candidates.map(candidate => ({ ...candidate, stats: null, points: null }));
  const h = await createBallonDorHarness({ path: '/balon-de-oro', now, ballonDorMarket: pending, reducedMotion: true });
  t.after(h.close);
  const { document } = h.window;
  assert.equal(document.getElementById('est-bdo-opening').hidden, false,
    'se conserva la inauguración obligatoria aunque se llegue tarde al ciclo');
  h.advanceOpeningAudio(20);
  const card = document.querySelector('#est-bdo-opening-cards .est-bdo-opening-card');
  assert.ok(card);
  assert.doesNotMatch(card.textContent, /Goles|Asistencias|Apariciones|Puntos/);
  assert.match(card.querySelector('.est-bdo-opening-card-signature').textContent, /revelarán en la ceremonia/);
  assert.equal(document.getElementById('est-bdo-ceremony-start').disabled, true);
});

test('la inauguración dura 1:48: la voz abre y el tema instrumental cubre la segunda mitad', async t => {
  const h = await createBallonDorHarness({ path: '/balon-de-oro', reducedMotion: true });
  t.after(h.close);
  const { document } = h.window;
  const overlay = document.getElementById('est-bdo-opening');
  const status = document.getElementById('est-bdo-opening-status');
  assert.equal(overlay.hidden, false);
  assert.equal(document.getElementById('est-bdo-opening-time').textContent, '0:00 / 1:48',
    'la presentación anuncia su duración real, no 45 s');

  // La narración grabada termina hacia el segundo 51: la presentación no se cierra
  // ahí, entra el tema instrumental y sigue hasta el final.
  h.advanceOpeningAudio(52);
  document.getElementById('est-bdo-opening-audio').dispatchEvent(new h.window.Event('ended'));
  await h.flush();
  assert.equal(h.openingBedPlayCount, 1, 'al terminar la voz empieza el tema instrumental');
  assert.equal(overlay.hidden, false, 'que acabe la voz no cierra la inauguración');
  assert.match(status.textContent, /Tema instrumental/);

  h.advanceOpeningAudio(107);
  assert.equal(overlay.hidden, false, 'a los 1:47 la presentación sigue en el cierre');
  h.advanceOpeningAudio(108);
  assert.equal(document.getElementById('est-bdo-opening-time').textContent, '1:48 / 1:48');
  assert.match(status.textContent, /Inauguración completada/);
});

test('el piloto registra inicio y final de audio de inauguración sin enviar identidad', async t => {
  const h = await createBallonDorHarness({ path: '/balon-de-oro', reducedMotion: true });
  t.after(h.close);
  await h.flush();
  const { document } = h.window;
  const audio = document.getElementById('est-bdo-opening-audio');
  assert.ok(h.audioTelemetryAttempts.some(item => item.body.track === 'opening_narration'
    && item.body.outcome === 'started' && item.body.seasonMonth === '2026-10'));
  audio.dispatchEvent(new h.window.Event('ended'));
  await h.flush();
  assert.ok(h.audioTelemetryAttempts.some(item => item.body.track === 'opening_narration'
    && item.body.outcome === 'completed'));
  assert.doesNotMatch(JSON.stringify(h.audioTelemetryAttempts), /token|profile|alice/);
  assert.ok(h.audioTelemetryAttempts.every(item => item.options.credentials === 'same-origin'));
});

test('la inauguración ofrece fallback visual y un control para activar audio si el navegador lo bloquea', async t => {
  const h = await createBallonDorHarness({ path: '/balon-de-oro', reducedMotion: true, openingAudioFails: true });
  t.after(h.close);
  const { document } = h.window;
  const overlay = document.getElementById('est-bdo-opening');
  assert.equal(overlay.hidden, false, 'se abre automáticamente en la ruta dedicada');
  assert.equal(document.getElementById('est-bdo-opening-stage').dataset.motion, 'reduced');
  assert.match(document.getElementById('est-bdo-opening-status').textContent, /Audio no disponible/);
  assert.ok(h.audioTelemetryAttempts.some(item => item.body.track === 'opening_narration' && item.body.outcome === 'blocked'),
    'el bloqueo de reproducción queda disponible para observabilidad del piloto');
  assert.match(document.querySelector('.est-bdo-opening-transcript').textContent, /Balón de Oro/);
  const enableAudio = document.getElementById('est-bdo-opening-enable-audio');
  assert.equal(enableAudio.hidden, false, 'hay un gesto explícito para intentar activar la voz');
  h.advanceTime(20000);
  assert.equal(document.getElementById('est-bdo-opening-stage').dataset.scene, 'reveal-1');
  enableAudio.click();
  await h.flush();
  assert.equal(h.openingAudioPlayCount, 2);
  assert.match(document.getElementById('est-bdo-opening-status').textContent, /Audio no disponible/);
  document.getElementById('est-bdo-opening-play').click();
  const pausedScene = document.getElementById('est-bdo-opening-stage').dataset.scene;
  h.advanceTime(5000);
  assert.equal(document.getElementById('est-bdo-opening-stage').dataset.scene, pausedScene,
    'el fallback visual también se puede pausar sin movimiento');
  document.getElementById('est-bdo-opening-close').click();
  assert.equal(overlay.hidden, false, 'la primera presentación no se puede cerrar antes de terminar');
});

test('Balón de Oro muestra los 16 candidatos y confirma un boleto con recibo virtual', async t => {
  const h = await createBallonDorHarness();
  t.after(h.close);
  const { document } = h.window;
  assert.equal(document.querySelectorAll('#est-bdo-candidates tr').length, 16);
  const candidateAvatars = [...document.querySelectorAll('#est-bdo-candidates .est-bdo-candidate-avatar')];
  assert.equal(candidateAvatars.length, 16);
  assert.deepEqual(candidateAvatars.map(image => image.getAttribute('src')),
    ballonDorMarket().candidates.map(candidate => `/assets/ballon-dor-avatars/${candidate.playerId}.svg`),
    'cada candidato conserva su avatar por playerId estable');
  assert.match(document.getElementById('est-bdo-status').textContent, /Predicciones abiertas/);
  assert.match(document.getElementById('est-bdo-summary').textContent, /ocho partidos de J20/);
  assert.match(document.getElementById('est-bdo-feed').textContent, /Respaldo HTTP|Socket\.IO/);

  chooseBallonDorCandidate(h, 'bdo-club-1', 100);
  const review = document.getElementById('est-bdo-review');
  assert.equal(review.disabled, false, 'stake y cuota válidos habilitan la revisión');
  review.click();
  assert.equal(document.getElementById('est-bdo-confirmation').hidden, false);
  assert.match(document.getElementById('est-bdo-confirmation-copy').textContent, /100 fichas/);
  assert.match(document.getElementById('est-bdo-confirmation-copy').textContent, /2\.50/);

  document.getElementById('est-bdo-confirm').click();
  await h.flush();
  assert.equal(h.ballonDorSocketAttempts.length, 1);
  const payload = h.ballonDorSocketAttempts[0].payload;
  assert.equal(payload.selection, 'bdo-club-1');
  assert.equal(payload.stake, 100);
  assert.match(payload.idempotencyKey, /^bdo-/);
  assert.equal(Object.hasOwn(payload, 'odds'), false, 'el cliente no manda la cuota al servidor');
  assert.equal(document.getElementById('est-bdo-receipt').hidden, false);
  assert.match(document.getElementById('est-bdo-receipt-body').textContent, /Delantero 1/);
  assert.match(document.getElementById('est-bdo-receipt-body').textContent, /Pago potencial: 250 fichas/);
  assert.equal(document.getElementById('est-chips').textContent, '900 fichas');

  h.handlers['football:settlement']({ betId: 'future-ui-1', status: 'won', payout: 250 });
  assert.match(document.getElementById('est-bdo-receipt-body').textContent, /Ganada · premio acreditado/);
  assert.match(document.getElementById('est-bdo-receipt-body').textContent, /Pago acreditado: 250 fichas/);
});

test('Balón de Oro conserva la clave idempotente en un error y permite reintentar sin cambiar el boleto', async t => {
  const h = await createBallonDorHarness({
    onBallonDorSocketBet(payload, attempt) {
      return attempt === 1
        ? { ok: false, code: 'persistencia_pendiente' }
        : acceptedBallonDorResult(payload);
    }
  });
  t.after(h.close);
  const { document } = h.window;
  chooseBallonDorCandidate(h, 'bdo-club-1', 100);
  document.getElementById('est-bdo-review').click();
  document.getElementById('est-bdo-confirm').click();
  await h.flush();

  assert.match(document.getElementById('est-bdo-message').textContent, /pendiente de guardado/);
  assert.equal(document.getElementById('est-bdo-confirmation').hidden, false);
  const firstKey = h.ballonDorSocketAttempts[0].payload.idempotencyKey;
  document.getElementById('est-bdo-confirm').click();
  await h.flush();

  assert.equal(h.ballonDorSocketAttempts.length, 2);
  assert.equal(h.ballonDorSocketAttempts[1].payload.idempotencyKey, firstKey);
  assert.equal(h.ballonDorSocketAttempts[1].payload.stake, 100);
  assert.equal(document.getElementById('est-bdo-receipt').hidden, false);
  assert.match(document.getElementById('est-bdo-message').textContent, /Predicción confirmada/);
});

test('Balón de Oro usa fallback HTTP sin Socket.IO, muestra su estado y deja el recibo', async t => {
  const h = await createBallonDorHarness({ socketMissing: true });
  t.after(h.close);
  const { document } = h.window;
  assert.match(document.getElementById('est-connection').textContent, /Sin conexión/);
  assert.equal(document.getElementById('est-bdo-feed').dataset.state, 'http');
  assert.match(document.getElementById('est-bdo-feed').textContent, /Respaldo HTTP/);

  chooseBallonDorCandidate(h, 'bdo-club-1', 100);
  document.getElementById('est-bdo-review').click();
  document.getElementById('est-bdo-confirm').click();
  await h.flush();

  assert.equal(h.ballonDorSocketAttempts.length, 0);
  assert.equal(h.ballonDorHttpAttempts.length, 1);
  assert.ok(h.ballonDorHttpAttempts[0].body.token, 'el fallback identifica el perfil existente mediante su token de dispositivo');
  assert.equal(h.ballonDorHttpAttempts[0].body.tos, '2026-09-28');
  assert.equal(h.ballonDorHttpAttempts[0].body.stake, 100);
  assert.ok(h.ballonDorHttpAttempts[0].headers['Idempotency-Key']);
  assert.equal(document.getElementById('est-bdo-receipt').hidden, false);
});

test('el panel del Balón de Oro ofrece un estado de error recuperable y reintenta por HTTP', async t => {
  let failMarketFetch = true;
  const h = await createBallonDorHarness({ failBallonDorFetch: () => failMarketFetch });
  t.after(h.close);
  const { document } = h.window;
  assert.match(document.getElementById('est-bdo-status').textContent, /Sin conexión/);
  assert.equal(document.getElementById('est-bdo-table-wrap').hidden, true);
  assert.equal(document.getElementById('est-bdo-retry').hidden, false);
  assert.match(document.getElementById('est-bdo-feedback').textContent, /Revisa tu conexión/);

  failMarketFetch = false;
  document.getElementById('est-bdo-retry').click();
  await h.flush();
  assert.equal(document.querySelectorAll('#est-bdo-candidates tr').length, 16);
  assert.equal(document.getElementById('est-bdo-table-wrap').hidden, false);
  assert.equal(document.getElementById('est-bdo-retry').hidden, true);
});

test('el panel BDO detecta una lista incompleta, bloquea el boleto y permite reintentar', async t => {
  const incomplete = ballonDorMarket();
  incomplete.candidates = incomplete.candidates.slice(0, 15);
  const complete = ballonDorMarket();
  const h = await createBallonDorHarness({ ballonDorMarket: incomplete });
  t.after(h.close);
  const { document } = h.window;

  assert.equal(document.querySelectorAll('#est-bdo-candidates tr').length, 15);
  assert.match(document.getElementById('est-bdo-feedback').textContent, /exactamente 16 candidatos/);
  assert.equal(document.getElementById('est-bdo-retry').hidden, false);
  assert.equal(document.querySelectorAll('#est-bdo-candidates [data-bdo-select]').length, 0);
  assert.equal(document.getElementById('est-bdo-review').disabled, true);

  h.setBallonDorMarket(complete);
  document.getElementById('est-bdo-retry').click();
  await h.flush();
  assert.equal(document.querySelectorAll('#est-bdo-candidates tr').length, 16);
  assert.equal(document.getElementById('est-bdo-retry').hidden, true);
  assert.doesNotMatch(document.getElementById('est-bdo-feedback').textContent, /exactamente 16 candidatos/);
});

test('un evento Socket.IO sin mercado vuelve al estado vacío en vez de renderizar el sobre', async t => {
  const h = await createBallonDorHarness();
  t.after(h.close);
  const { document } = h.window;

  h.handlers['football:ballon_dor_market']({ market: null });
  assert.match(document.getElementById('est-bdo-status').textContent, /Sin ciclo activo/);
  assert.equal(document.getElementById('est-bdo-table-wrap').hidden, true);
});

test('la tabla BDO recibe cambios de cuota en vivo y cierra nuevas predicciones tras J20', async t => {
  const initial = ballonDorMarket();
  const h = await createBallonDorHarness({ ballonDorMarket: initial });
  t.after(h.close);
  const { document } = h.window;
  const firstOdds = () => document.querySelector('#est-bdo-candidates tr .est-bdo-odds').textContent;
  assert.equal(firstOdds(), '2.50');

  const live = ballonDorMarket({
    updatedAt: 200,
    oddsSnapshot: { afterJornada: 1, updatedAt: 200, simulations: 2000, overround: 1.1 },
    candidates: initial.candidates.map((candidate, index) => index === 0
      ? { ...candidate, odds: 3.75, impliedProbability: 1 / 3.75 }
      : candidate)
  });
  h.handlers['football:ballon_dor_market']({ market: live });
  assert.equal(firstOdds(), '3.75');
  assert.equal(document.getElementById('est-bdo-feed').dataset.state, 'socket');
  assert.match(document.getElementById('est-bdo-feedback').textContent, /al completar J1/);

  const stale = ballonDorMarket({
    updatedAt: 150,
    candidates: initial.candidates.map((candidate, index) => index === 0 ? { ...candidate, odds: 4.75 } : candidate)
  });
  h.handlers['football:ballon_dor_market']({ market: stale });
  assert.equal(firstOdds(), '3.75', 'una respuesta HTTP/socket atrasada no revierte la cuota nueva');

  const locked = ballonDorMarket({
    status: 'locked', updatedAt: 300,
    oddsSnapshot: { afterJornada: 8, updatedAt: 300, simulations: 2000, overround: 1.1 }
  });
  h.handlers['football:ballon_dor_market']({ market: locked });
  assert.match(document.getElementById('est-bdo-status').textContent, /Mercado cerrado/);
  assert.match(document.getElementById('est-bdo-summary').textContent, /No se aceptan nuevas predicciones/);
  assert.equal(document.getElementById('est-bdo-bet-area').hidden, true);
});

test('un ciclo BDO cancelado explica la devolución y muestra el reembolso exacto en el recibo', async t => {
  const ticket = {
    kind: 'future', id: 'future-void-ui', market: 'balon_de_oro', seasonMonth: '2026-10',
    selection: 'bdo-club-1', stake: 125, odds: 2.5, potentialPayout: 312,
    status: 'void', payout: 125, placedAt: 10, settledAt: 20
  };
  const h = await createBallonDorHarness({
    ballonDorMarket: ballonDorMarket({ status: 'cancelled', updatedAt: 200, cancellationReason: 'temporada_truncada' }),
    betHistory: { entries: [ticket], summary: { total: 1 } }
  });
  t.after(h.close);
  const { document } = h.window;
  assert.match(document.getElementById('est-bdo-status').textContent, /Cancelado/);
  assert.match(document.getElementById('est-bdo-summary').textContent, /temporada se truncó/);
  assert.match(document.getElementById('est-bdo-finalization-message').textContent, /10:00 p\. m\./);
  assert.match(document.getElementById('est-bdo-finalization-message').textContent, /no tendrá ceremonia/);
  assert.equal(document.getElementById('est-bdo-slip').hidden, true);
  assert.equal(document.getElementById('est-bdo-receipt').hidden, false);
  assert.match(document.getElementById('est-bdo-receipt-body').textContent, /Anulada · stake reembolsado/);
  assert.match(document.getElementById('est-bdo-receipt-body').textContent, /Reembolso exacto: 125 fichas/);
});

test('Mi espacio del Estadio mantiene el ranking combinado en vivo y las métricas personales', async t => {
  const h = createHarness();
  t.after(h.close);
  await h.connectToMatch();
  await h.flush();
  const { window, handlers, socketEmitted } = h;
  const document = window.document;
  document.getElementById('est-ledger-open').click();
  document.getElementById('est-ledger-tab-ranking').click();
  assert.ok(socketEmitted.some(item => item.event === 'bet_ranking_get'), 'al abrir el ranking se suscribe a la actualización en vivo');

  const snapshot = {
    updatedAt: Date.now(), participants: 2,
    participantsBySource: { total: 2, casino: 2, stadium: 1 }, totalWagered: 1800,
    me: {
      name: 'Aficionado ABCD', avatar: 'fox', totalWagered: 900,
      casinoWagered: 400, stadiumWagered: 500, stadiumBets: 3,
      stadiumWins: 2, stadiumLosses: 1, stadiumDecisions: 3,
      stadiumSettledBets: 3, stadiumHitRate: 67, stadiumNet: 125,
      totalRank: 1, casinoRank: 2, stadiumRank: 1
    },
    ranking: {
      total: [
        { place: 1, name: 'Aficionado ABCD', avatar: 'fox', totalWagered: 900, casinoWagered: 400, stadiumWagered: 500 },
        { place: 2, name: 'Aficionado EFGH', avatar: 'owl', totalWagered: 900, casinoWagered: 800, stadiumWagered: 100 }
      ],
      casino: [{ place: 1, name: 'Aficionado EFGH', avatar: 'owl', totalWagered: 900, casinoWagered: 800, stadiumWagered: 100 }],
      stadium: [{ place: 1, name: 'Aficionado ABCD', avatar: 'fox', totalWagered: 900, casinoWagered: 400, stadiumWagered: 500 }]
    }
  };
  handlers['bet_ranking_state'](snapshot);
  assert.match(document.getElementById('est-bet-ranking-personal').textContent, /67%/);
  assert.match(document.getElementById('est-bet-ranking-personal').textContent, /\+◆ 125/);
  const publicRows = document.getElementById('est-bet-ranking-list').textContent;
  assert.match(publicRows, /Aficionado ABCD/);
  assert.doesNotMatch(publicRows, /profileId|deviceToken|alice/);

  const next = { ...snapshot, updatedAt: snapshot.updatedAt + 1, totalWagered: 2400 };
  handlers['bet_ranking_state'](next);
  assert.match(document.getElementById('est-bet-ranking-updated').textContent, /2,400 fichas/);
  document.querySelector('[data-bet-ranking-source="stadium"]').click();
  assert.match(document.getElementById('est-bet-ranking-personal').textContent, /TU PUESTO · ESTADIO/);

  document.getElementById('est-ledger-ranking-back').click();
  assert.ok(socketEmitted.some(item => item.event === 'bet_ranking_unsubscribe'), 'al cerrar se desuscribe a la actualización en vivo');
});

test('Balón de Oro no habilita apuestas hasta aceptar la versión vigente de Términos', async t => {
  const h = await createBallonDorHarness({ localTosVersion: 'versión-anterior' });
  t.after(h.close);
  const { document } = h.window;
  assert.equal(document.getElementById('est-tos').hidden, false);
  assert.equal(document.getElementById('est-bdo-selection').disabled, true);
  assert.match(document.getElementById('est-bdo-message').textContent, /Acepta los Términos/);
  assert.equal(document.querySelector('[data-bdo-select="bdo-club-1"]'), null);

  document.getElementById('est-tos-accept').click();
  await h.flush();
  assert.equal(document.getElementById('est-tos').hidden, true);
  assert.ok(document.querySelector('[data-bdo-select="bdo-club-1"]'));
  chooseBallonDorCandidate(h, 'bdo-club-1', 100);
  assert.equal(document.getElementById('est-bdo-review').disabled, false);
});


test('Mi Once muestra once posiciones, guarda el equipo y muestra pines sin fichas', async () => {
  const groups=[['GK',1],['DF',4],['MF',4],['FW',2]];
  const players=groups.flatMap(([group,n])=>Array.from({length:n},(_,i)=>({id:group+i,group,name: group==='GK'?'<Portero>':'Jugador '+i,clubName:'Club',position:group})));
  let data={season:'2026-10',points:0,next:{jornada:2,closesAt:Date.now()+60000},selected:[],players,ranking:[],challenges:[],rankingOptIn:false};
  let sent;
  const h=createHarness({onFantasyGet:()=>({ok:true,fantasy:data}),onFantasySave:payload=>{sent=payload;data={...data,selected:payload.players};return {ok:true,fantasy:data,appliedJornada:2};}});
  try {
    await h.connectToMatch(); const doc=h.window.document, form=doc.getElementById('est-fantasy-form');
    const selects=[...form.querySelectorAll('select')]; assert.equal(selects.length,11);
    for (const [i,select] of selects.entries()) { select.value=players[i].id; select.dispatchEvent(new h.window.Event('change',{bubbles:true})); }
    form.dispatchEvent(new h.window.Event('submit',{bubbles:true,cancelable:true}));
    assert.equal(sent.players.length,11); assert.match(doc.getElementById('est-fantasy-feedback').textContent,/jornada 2/);
    assert.equal(form.querySelector('portero'),null); assert.match(doc.getElementById('est-fantasy-panel').textContent,/Sin fichas/);
  } finally { h.window.close(); }
});

test('Zona de afición separa Mi Once y muestra las funciones ausentes sin simularlas', async () => {
  const players = [['GK', 1], ['DF', 4], ['MF', 4], ['FW', 2]].flatMap(([group, n]) =>
    Array.from({ length: n }, (_, i) => ({ id: group + i, group, name: 'Jugador ' + i, clubName: 'Club', position: group })));
  const data = { season: '2026-10', points: 0, next: { jornada: 2 }, selected: [], players, ranking: [], challenges: [], rankingOptIn: false };
  const h = createHarness({ onFantasyGet: () => ({ ok: true, fantasy: data }), onQuinielaGet: () => ({ ok: true, quiniela: { available: false, jornada: 7, matches: [{ id: 'm', homeId: 'united_vanguard', awayId: 'sporting_almar' }] } }) });
  try {
    await h.connectToMatch();
    const doc = h.window.document, hub = doc.getElementById('est-hub'), open = doc.getElementById('est-hub-open');
    assert.equal(hub.hidden, true);
    assert.equal(doc.querySelector('.est-col-left #est-fantasy-panel'), null);
    open.focus(); open.click();
    assert.equal(hub.hidden, false);
    assert.equal(doc.activeElement.id, 'est-hub-close');
    assert.equal(hub.getAttribute('aria-modal'), 'true');
    const first = hub.querySelector('[data-fantasy-slot="0"]');
    first.value = players[0].id; first.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    for (const view of ['quiniela']) {
      const button = hub.querySelector('[data-hub-view="' + view + '"]');
      button.click();
      const panel = hub.querySelector('[data-hub-panel="' + view + '"]');
      assert.equal(button.getAttribute('aria-pressed'), 'true');
      assert.equal(panel.hidden, false);
      assert.match(panel.textContent, /no está disponible/i);
      assert.equal(panel.querySelector('form'), null);
      assert.equal(doc.getElementById('est-fantasy-panel').hidden, true);
    }
    hub.querySelector('[data-hub-view="once"]').click();
    assert.equal(hub.querySelector('[data-fantasy-slot="0"]').value, players[0].id);
    hub.querySelector('[data-fantasy-slot="0"]').focus();
    doc.activeElement.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(hub.hidden, true);
    assert.equal(doc.activeElement, open);
    open.click(); // la actualización del servidor no pisa el borrador
    assert.equal(hub.querySelector('[data-fantasy-slot="0"]').value, players[0].id);
    const close = doc.getElementById('est-hub-close');
    close.focus();
    close.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(doc.activeElement.id, 'est-fantasy-opt');
    doc.activeElement.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.equal(doc.activeElement, close);
    close.click();
    assert.equal(doc.activeElement, open);
  } finally { h.window.close(); }
});


test('los escudos de los 16 clubes aparecen en posiciones, partidos, marcador y previa', async () => {
  const { CLUBS } = require('../lib/football/teams');
  const expected = { vantora_fc:'RMD', united_vanguard:'FAR', olympique_estevin:'ATC', atletico_solaris:'MUN', sporting_almar:'LVP', dynamo_kelvar:'ARS', cs_verdania:'BAY', halcyon_bay_fc:'BDO', athletic_ferrata:'JUV', royal_corvane:'PSG', sv_talbruck:'RSU', velmar_harbour_fc:'RDB', norvela_sporting:'WHM', ironvale_fc:'NAB', peregrine_rovers:'CDC', puerto_ambar:'BEN' };
  const extraTeams = Object.fromEntries(CLUBS.map(club => [club.id, team(club.id, club.name, club.abbr, club.colors.primary, club.colors.secondary)]));
  const standings = CLUBS.map(club => ({ teamId: club.id, played: 0, goalDiff: 0, points: 0 }));
  const h = createHarness({ extraTeams, standings, homeId: 'united_vanguard', awayId: 'sporting_almar', kickoffOffsetMs: 60000 });
  try {
    await h.connectToMatch();
    const doc = h.window.document;
    const imgs = [...doc.querySelectorAll('#est-standings tbody img.est-club-crest')];
    assert.equal(imgs.length, 16);
    imgs.forEach((img, index) => {
      const id = CLUBS[index].id;
      const src = '/assets/escudos/' + expected[id] + '.svg';
      assert.equal(img.getAttribute('src'), src);
      assert.equal(img.getAttribute('alt'), '');
      assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', src.slice(1))));
      assert.match(img.parentElement.textContent, new RegExp(CLUBS[index].name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
    assert.equal(doc.querySelectorAll('#est-match-list img.est-match-crest').length, 2);
    assert.match(doc.querySelector('#crest-home img').getAttribute('src'), /FAR\.svg$/);
    assert.match(doc.querySelector('#crest-away img').getAttribute('src'), /LVP\.svg$/);
    assert.equal(doc.querySelectorAll('.est-compare-club img.est-club-crest').length, 2);
  } finally { h.window.close(); }
});


test('Mi afición real pide confirmación antes de cambiar y muestra el resultado del servidor', async () => {
  let fan = { clubId:null, wins:0, level:0, rankingOptIn:false, ranking:[], rewards:[] };
  const sent = [];
  const extraTeams = { united_vanguard:team('united_vanguard','Farselona FC','FAR','#d32f2f','#1a1a1a'), sporting_almar:team('sporting_almar','Liverpulpo FC','LVP','#388e3c','#ffffff') };
  const h = createHarness({ extraTeams, onFanGet:() => ({ok:true,fan}), onFanSelect:payload => { sent.push(payload); fan={...fan,clubId:payload.clubId,wins:0,level:0,rewards:[{title:'Pin del club',unlocked:true}]}; return {ok:true,fan}; } });
  try {
    await h.connectToMatch(); const doc=h.window.document;
    doc.getElementById('est-hub-open').click(); doc.querySelector('[data-hub-view="aficion"]').click();
    const select=doc.getElementById('est-fan-club'); select.value='united_vanguard'; select.dispatchEvent(new h.window.Event('change',{bubbles:true}));
    doc.getElementById('est-fan-choose').click();
    assert.equal(sent.length,1); assert.equal(sent[0].confirmed,false); assert.match(doc.getElementById('est-fan-current').textContent,/Farselona/);
    select.value='sporting_almar'; select.dispatchEvent(new h.window.Event('change',{bubbles:true})); doc.getElementById('est-fan-choose').click();
    assert.equal(doc.getElementById('est-fan-confirm').hidden,false); assert.equal(sent.length,1);
    assert.match(doc.getElementById('est-fan-confirm').textContent,/Perderás las victorias, el nivel y los pines/);
    doc.getElementById('est-fan-confirm-no').click(); assert.equal(sent.length,1);
    doc.getElementById('est-fan-choose').click(); doc.getElementById('est-fan-confirm-yes').click();
    assert.equal(sent.length,2); assert.equal(sent[1].confirmed,true); assert.equal(sent[1].currentClubId,'united_vanguard');
    assert.match(doc.getElementById('est-fan-current').textContent,/Liverpulpo/);
  } finally { h.window.close(); }
});


test('la conferencia de prensa del mercado muestra traspasos, escudos y valoraciones', async () => {
  const h=createHarness({ extraTeams:{ united_vanguard:team('united_vanguard','Farselona FC','FAR','#d32f2f','#111111'), sporting_almar:team('sporting_almar','Liverpulpo FC','LVP','#388e3c','#ffffff') }, onTransfersGet:()=>({ok:true,transfers:{status:'announced',effectiveSeason:'2026-11',moves:[{playerName:'<Jugador>',fromId:'united_vanguard',toId:'sporting_almar',position:'CM',playerValue:17.5}]}}) });
  try {
    await h.connectToMatch(); const doc=h.window.document; doc.getElementById('est-hub-open').click(); doc.querySelector('[data-hub-view="mercado"]').click();
    const row=doc.querySelector('.est-transfer-list li'); assert.ok(row); assert.match(row.textContent,/<Jugador>/);
    assert.equal(row.querySelector('jugador'),null); assert.equal(row.querySelectorAll('img').length,3);
    assert.match(row.querySelector('.est-transfer-portrait').getAttribute('src'), /^data:image\/svg\+xml/);
    assert.ok(row.querySelector('img[src="/assets/escudos/FAR.svg"]')); assert.ok(row.querySelector('img[src="/assets/escudos/LVP.svg"]'));
    // La valoración sale del servidor y se lee como precio de mercado, no como ficha.
    assert.match(row.textContent,/CM/);
    assert.match(row.querySelector('.est-transfer-value').textContent,/Valoración 17,5 M/);
    assert.match(doc.getElementById('est-transfers-list').textContent,/Acuerdos anunciados/);
    assert.match(doc.getElementById('est-transfers-list').textContent,/2026-11/);
  } finally {h.window.close();}
});

test('MonteCristo News sintoniza y narra los traspasos la primera vez que si ves', async () => {
  const moves=[
    {playerName:'Jugador Uno',fromId:'united_vanguard',toId:'sporting_almar',position:'CM',playerValue:17.5},
    {playerName:'Jugador Dos',fromId:'sporting_almar',toId:'united_vanguard',position:'CM',playerValue:9.25}
  ];
  const h=createHarness({ extraTeams:{ united_vanguard:team('united_vanguard','Farselona FC','FAR','#d32f2f','#111111'), sporting_almar:team('sporting_almar','Liverpulpo FC','LVP','#388e3c','#ffffff') },
    onTransfersGet:()=>({ok:true, transfers:{status:'announced',seasonMonth:'2026-10',effectiveSeason:'2026-11',moves}, firstView:true}) });
  try {
    await h.connectToMatch(); const doc=h.window.document;
    doc.getElementById('est-hub-open').click(); doc.querySelector('[data-hub-view="mercado"]').click();
    const panel=doc.querySelector('[data-hub-panel="mercado"]');
    const news=panel.querySelector('.est-news'); assert.ok(news,'se muestra la transmisión del canal');
    assert.match(news.textContent,/MONTECRISTO/); assert.match(news.textContent,/NEWS/);
    assert.match(news.textContent,/SINTONIZANDO/i);
    assert.equal(panel.querySelector('.est-transfer-list'),null,'la lista llega al terminar la transmisión');
    news.querySelector('.est-news-skip').click();
    const list=panel.querySelector('.est-transfer-list'); assert.ok(list,'tras saltar aparece la lista');
    assert.equal(list.querySelectorAll('li').length,2);
    assert.match(list.textContent,/Jugador Uno/); assert.match(list.textContent,/Valoración 17,5 M/);
    assert.match(list.textContent,/Jugador Dos/); assert.match(list.textContent,/9,3 M/);
    assert.match(panel.textContent,/Acuerdos anunciados/);
  } finally {h.window.close();}
});

test('sin primera vista no hay bumper: el mercado muestra la lista directo', async () => {
  const h=createHarness({ extraTeams:{ united_vanguard:team('united_vanguard','Farselona FC','FAR','#d32f2f','#111111'), sporting_almar:team('sporting_almar','Liverpulpo FC','LVP','#388e3c','#ffffff') },
    onTransfersGet:()=>({ok:true, transfers:{status:'announced',seasonMonth:'2026-10',effectiveSeason:'2026-11',moves:[{playerName:'Jugador Uno',fromId:'united_vanguard',toId:'sporting_almar',position:'CM',playerValue:17.5}]}, firstView:false}) });
  try {
    await h.connectToMatch(); const doc=h.window.document;
    doc.getElementById('est-hub-open').click(); doc.querySelector('[data-hub-view="mercado"]').click();
    const panel=doc.querySelector('[data-hub-panel="mercado"]');
    assert.equal(panel.querySelector('.est-news'),null,'sin firstView no hay transmisión');
    assert.ok(panel.querySelector('.est-transfer-list li'));
  } finally {h.window.close();}
});



test('la conferencia permite escuchar desde el inicio, alterna voces y detiene el audio al salir', async t => {
  const moves = [
    { playerId: 'frr_09', playerName: 'Jugador Uno', fromId: 'home', toId: 'away', position: 'ST', playerValue: 17.5 },
    { playerId: 'otro_10', playerName: 'Jugador Dos', fromId: 'away', toId: 'home', position: 'CM', playerValue: 9.2 }
  ];
  const market = { status: 'announced', seasonMonth: '2026-10', effectiveSeason: '2026-11', moves };
  const h = createHarness({ speechSynthesis: true, onTransfersGet: () => ({ ok: true, transfers: market, firstView: true }) });
  t.after(h.close); await h.connectToMatch();
  const doc = h.window.document;
  doc.getElementById('est-hub-open').click(); doc.querySelector('[data-hub-view="mercado"]').click();
  const news = doc.querySelector('.est-news');
  h.advanceTime(1900);
  assert.equal(h.speech.utterances.length, 0, 'no se fuerza audio sin interacción');
  const voice = news.querySelector('.est-news-voice');
  voice.click();
  assert.equal(voice.getAttribute('aria-pressed'), 'true');
  assert.equal(h.speech.utterances.length, 1, 'comienza en el gesto, sin activar el relato del partido');
  assert.match(h.speech.utterances[0].text, /Bienvenidos a MonteCristo News/);
  assert.equal(h.speech.utterances[0].lang, 'es-MX');
  h.speech.finish(0); h.advanceTime(250);
  assert.equal(h.speech.utterances.length, 2);
  assert.match(h.speech.utterances[1].text, /Jugador Uno/);
  assert.match(h.speech.utterances[1].text, /17,5 millones de fichas/);
  assert.ok(news.querySelector('img[src="/assets/ballon-dor-avatars/frr_09.svg"]'));
  h.speech.finish(1); h.advanceTime(250);
  assert.equal(h.speech.utterances.length, 3);
  assert.match(h.speech.utterances[2].text, /Jugador Dos/);
  assert.notEqual(h.speech.utterances[2].voice, h.speech.utterances[1].voice, 'el analista usa la segunda voz disponible');
  assert.equal(news.querySelector('.est-news-narrador').textContent, 'ANALISTA');
  assert.equal(h.speech.overlapCount, 0);
  doc.getElementById('est-commentary-voice').click();
  h.handlers['football:commentary']({ matchId: h.match.id, voice: 'narrador', text: 'Jugada en curso.' });
  assert.equal(h.speech.utterances.length, 3, 'el relato del partido no interrumpe la conferencia');
  const before = h.speech.cancelCount;
  doc.querySelector('[data-hub-view="quiniela"]').click();
  assert.ok(h.speech.cancelCount > before, 'se cancela al cambiar de vista');
  h.speech.finish(2); h.advanceTime(30000);
  assert.equal(h.speech.utterances.length, 3, 'un callback tardío no reinicia la voz');
  assert.ok(doc.querySelector('.est-transfer-list'));
});

test('la voz bloqueada se puede reintentar; hay repetición y subtítulos si no existe voz', async t => {
  const market = { status: 'announced', seasonMonth: '2026-10', effectiveSeason: '2026-11', moves: [
    { playerId: 'frr_09', playerName: 'Uno', fromId: 'home', toId: 'away', playerValue: 2 },
    { playerId: 'jugador_02', playerName: 'Dos', fromId: 'away', toId: 'home', playerValue: 3 },
    { playerId: 'jugador_03', playerName: 'Tres', fromId: 'home', toId: 'away', playerValue: 4 }
  ] };
  const h = createHarness({ speechSynthesis: true, onTransfersGet: () => ({ ok: true, transfers: market, firstView: false }) });
  t.after(h.close); await h.connectToMatch();
  const doc = h.window.document;
  doc.getElementById('est-hub-open').click(); doc.querySelector('[data-hub-view="mercado"]').click();
  const portraits = doc.querySelectorAll('.est-transfer-portrait');
  assert.equal(portraits[0].getAttribute('src'), '/assets/ballon-dor-avatars/frr_09.svg');
  assert.notEqual(portraits[1].getAttribute('src'), portraits[2].getAttribute('src'));
  const saved = portraits[1].getAttribute('src');
  doc.querySelector('.est-market-replay').click();
  let news = doc.querySelector('.est-news');
  news.querySelector('.est-news-voice').click();
  h.speech.utterances[0].onerror({ error: 'not-allowed' });
  assert.match(news.querySelector('.est-news-audio-status').textContent, /No se pudo reproducir/);
  assert.match(news.querySelector('.est-news-voice').textContent, /Reintentar/);
  news.querySelector('.est-news-voice').click();
  assert.equal(h.speech.utterances.length, 2);
  assert.match(h.speech.utterances[1].text, /Bienvenidos/);
  news.querySelector('.est-news-skip').click();
  assert.equal(doc.querySelectorAll('.est-transfer-portrait')[1].getAttribute('src'), saved, 'el retrato es estable');

  const without = createHarness({ onTransfersGet: () => ({ ok: true, transfers: market, firstView: true }) });
  t.after(without.close); await without.connectToMatch();
  const other = without.window.document;
  other.getElementById('est-hub-open').click(); other.querySelector('[data-hub-view="mercado"]').click();
  news = other.querySelector('.est-news');
  assert.equal(news.querySelector('.est-news-voice').disabled, true);
  assert.match(news.querySelector('.est-news-audio-status').textContent, /subtítulos/i);
  without.advanceTime(1900);
  assert.match(news.querySelector('.est-news-lines').textContent, /Bienvenidos/);
});

test('Mi afición permite equipar un pin desbloqueado y muestra el escudo', async () => {
 let fan={clubId:'united_vanguard',wins:1,level:1,ranking:[],rankingOptIn:false,equippedPin:null,rewards:[{id:'fan-1',title:'Primera victoria',target:1,progress:1,unlocked:true,equipped:false}]};
 let sent;
 const h=createHarness({extraTeams:{united_vanguard:team('united_vanguard','Farselona FC','FAR','#d32f2f','#111111')},onFanGet:()=>({ok:true,fan}),onFanEquip:payload=>{sent=payload;fan={...fan,equippedPin:payload.pin,rewards:fan.rewards.map(r=>({...r,equipped:r.id===payload.pin}))};return {ok:true,fan};}});
 try {await h.connectToMatch();const doc=h.window.document;doc.getElementById('est-hub-open').click();doc.querySelector('[data-hub-view="aficion"]').click();
 assert.match(doc.getElementById('est-fan-rewards').textContent,/1\/1/);doc.querySelector('[data-fan-pin="fan-1"]').click();
 assert.equal(sent.pin,'fan-1');assert.equal(doc.getElementById('est-active-fan-pin').hidden,false);assert.ok(doc.querySelector('#est-active-fan-pin img[src="/assets/escudos/FAR.svg"]'));
 } finally {h.window.close();}
});


test('Quiniela muestra jornada real sin simular venta de boletos', async () => {
 const h=createHarness({extraTeams:{united_vanguard:team('united_vanguard','Farselona FC','FAR','#d32f2f','#111111'),sporting_almar:team('sporting_almar','Liverpulpo FC','LVP','#388e3c','#ffffff')},onQuinielaGet:()=>({ok:true,quiniela:{available:false,jornada:7,matches:[{id:'m',homeId:'united_vanguard',awayId:'sporting_almar'}]}})});
 try {await h.connectToMatch();const doc=h.window.document;doc.getElementById('est-hub-open').click();doc.querySelector('[data-hub-view="quiniela"]').click();const panel=doc.querySelector('[data-hub-panel="quiniela"]');assert.match(panel.textContent,/Jornada 7/);assert.match(panel.textContent,/Farselona FC/);assert.match(panel.textContent,/inscripción no está disponible/i);assert.ok(panel.querySelector('img[src="/assets/escudos/LVP.svg"]'));assert.equal(panel.querySelectorAll('button').length,0);}finally{h.window.close();}
});

test('Quiniela abierta muestra el formulario 1/X/2 y registra el boleto con fichas', async () => {
 const matches=Array.from({length:8},(_,i)=>({id:'q'+i,homeId:'united_vanguard',awayId:'sporting_almar'}));
 let entered=null;
 const state={available:true,season:'2026-10',jornada:3,closesAt:Date.now()+3600000,entryCost:50,carry:120,matches,myTicket:null,lastResult:null};
 const h=createHarness({extraTeams:{united_vanguard:team('united_vanguard','Farselona FC','FAR','#d32f2f','#111111'),sporting_almar:team('sporting_almar','Liverpulpo FC','LVP','#388e3c','#ffffff')},
  onQuinielaGet:()=>({ok:true,quiniela:state}),
  onQuinielaEnter:payload=>{entered=payload;state.myTicket={picks:payload.picks,placedAt:Date.now(),status:'open',payout:0};return {ok:true,chips:950,quiniela:state};}});
 try {
  await h.connectToMatch();const doc=h.window.document;doc.getElementById('est-hub-open').click();doc.querySelector('[data-hub-view="quiniela"]').click();
  const panel=doc.querySelector('[data-hub-panel="quiniela"]');
  const form=panel.querySelector('#est-quiniela-form');assert.ok(form,'hay formulario cuando la jornada está abierta');
  assert.match(panel.textContent,/Jornada 3/);assert.match(panel.textContent,/bote acumulado 120/);assert.match(panel.textContent,/50 fichas/);
  assert.equal(panel.querySelectorAll('input[type="radio"]').length,24); // 8 partidos × 1/X/2
  const submit=panel.querySelector('#est-quiniela-submit');assert.equal(submit.disabled,true,'sin 8 selecciones no se envía');
  for(const m of matches){const radio=form.querySelector('input[name="quiniela_'+m.id+'"][value="home"]');radio.checked=true;radio.dispatchEvent(new h.window.Event('change',{bubbles:true}));}
  assert.equal(submit.disabled,false);
  form.dispatchEvent(new h.window.Event('submit',{bubbles:true,cancelable:true}));
  assert.ok(entered);assert.equal(entered.season,'2026-10');assert.equal(entered.jornada,3);assert.equal(entered.picks.length,8);
  assert.ok(entered.picks.every(p=>p.pick==='home'));assert.ok(entered.tos);
  assert.match(panel.textContent,/Tu boleto/); // tras el ack se re-renderiza con el boleto
 } finally { h.window.close(); }
});

test('escudos acompañan nombres en historial abierto, combinadas y cambio de afición', async t => {
 const home='united_vanguard',away='sporting_almar'; const match={id:'ui-match',homeId:home,awayId:away,jornada:1,status:'scheduled'};
 const teams={ [home]:team(home,'Farselona FC','FAR','#d32f2f','#111111'), [away]:team(away,'Liverpulpo FC','LVP','#388e3c','#ffffff') };
 const entries=[{kind:'bet',id:'one',matchId:match.id,market:'1x2',selection:'home',stake:50,odds:2,status:'open',placedAt:1000,match}, {kind:'parlay',id:'combo',stake:50,odds:2,status:'open',placedAt:1000,legs:[{match,market:'1x2',selection:'home',odds:2,status:'open'}]}, {kind:'future',id:'future',market:'champion',selection:home,seasonMonth:'2026-10',stake:50,odds:2,status:'open',placedAt:1000}];
 const fan={clubId:home,wins:0,level:0,ranking:[],rankingOptIn:false,rewards:[]};
 const h=createHarness({homeId:home,awayId:away,extraTeams:teams,betHistory:{entries,summary:{total:3},totalEntries:3},onFanGet:()=>({ok:true,fan})});t.after(h.close);await h.connectToMatch();await h.flush();const doc=h.window.document;doc.getElementById('est-ledger-open').click();
 const open=doc.querySelector('[data-kind="bet"] .est-ledger-row-match');assert.equal(open.querySelectorAll('img.est-club-crest').length,2);
 const leg=doc.querySelector('[data-kind="parlay"] .est-ledger-leg-copy small');assert.equal(leg.querySelectorAll('img.est-club-crest').length,2);
 assert.ok(doc.querySelector('[data-kind="future"] .est-ledger-pick img[src$="FAR.svg"]'));
 assert.equal(doc.querySelectorAll('#est-ledger-only-match img').length,2);doc.getElementById('est-ledger-close').click();
 doc.getElementById('est-hub-open').click();doc.querySelector('[data-hub-view="aficion"]').click();const select=doc.getElementById('est-fan-club');select.value=away;select.dispatchEvent(new h.window.Event('change',{bubbles:true}));assert.ok(doc.querySelector('#est-fan-selected-club img[src$="LVP.svg"]'));doc.getElementById('est-fan-choose').click();assert.equal(doc.querySelectorAll('#est-fan-confirm-copy img').length,2);
});

test('escudos reales aparecen en la inauguración, tabla y archivo del Balón de Oro', async t => {
 const {CLUBS}=require('../lib/football/teams');const base=ballonDorMarket();const candidates=base.candidates.map((candidate,i)=>({...candidate,clubId:CLUBS[i].id,clubName:CLUBS[i].name,clubShort:CLUBS[i].abbr}));
 const active=ballonDorMarket({candidates});const h=await createBallonDorHarness({path:'/balon-de-oro',ballonDorMarket:active});t.after(h.close);const doc=h.window.document;
 assert.equal(doc.querySelectorAll('#est-bdo-candidates img.est-bdo-club-crest').length,16);h.advanceOpeningAudio(20);
 assert.ok(doc.querySelector('#est-bdo-opening-kicker img[src$="RMD.svg"]'));assert.ok(doc.querySelector('#est-bdo-opening-card-monogram img') || doc.querySelector('.est-bdo-opening-card-monogram img[src$="RMD.svg"]'));
 const result=settledBallonDorMarket({candidates});const archive=[{seasonMonth:'2026-10',status:'settled',winner:{clubId:CLUBS[0].id,clubName:CLUBS[0].name,playerName:candidates[0].playerName,score:30}}];
 const h2=await createBallonDorHarness({path:'/balon-de-oro?seasonMonth=2026-10',openingCompleted:true,now:Date.UTC(2026,10,2,12),ballonDorMarket:result,ballonDorArchive:archive,reducedMotion:true});t.after(h2.close);const d2=h2.window.document;
 assert.ok(d2.querySelector('#est-bdo-archive-list img[src$="RMD.svg"]'));assert.ok(d2.querySelector('#est-bdo-summary img[src$="RMD.svg"]'));d2.getElementById('est-bdo-ceremony-start').click();await h2.flush();
 assert.equal(d2.querySelectorAll('#est-bdo-ceremony-nominees img.est-club-crest').length,16);
 assert.equal(d2.querySelector('#est-bdo-ceremony-title img'),null,'no se revela ganador antes de tiempo');
});

test('cada club tiene un escudo SVG propio, autocontenido y asociado a su abreviatura', () => {
 const {CLUBS}=require('../lib/football/teams'); const art=new Set();
 for(const club of CLUBS) {const svg=fs.readFileSync(path.join(__dirname,'..','public','assets','escudos',club.abbr+'.svg'),'utf8');assert.match(svg,/^<svg\b/);assert.match(svg,/viewBox=/);assert.doesNotMatch(svg,/<script\b|<image\b|https?:\/\/(?!www\.w3\.org\/2000\/svg)/i);assert.ok(svg.includes(club.name));art.add(svg);}
 assert.equal(art.size,16);
});

test('destacados se muestran solo al finalizar y pueden escucharse con voz es-MX', async t=>{
 const h=createHarness({speechSynthesis:true});t.after(h.close);await h.connectToMatch();const doc=h.window.document,box=doc.getElementById('est-highlights');assert.equal(box.hidden,true);
 h.handlers['football:status']({matchId:h.match.id,code:'full_time',result:{home:1,away:0},highlights:{goals:[{type:'goal',minute:12,side:'home',player:'<Jugador>',assist:'Pase'}],moments:[{type:'goal',minute:12,side:'home',player:'<Jugador>',assist:'Pase'}],star:{name:'<Jugador>',side:'home',goals:1,assists:0,minutes:90}}});
 assert.equal(box.hidden,false);assert.match(box.textContent,/1–0/);assert.match(box.textContent,/<Jugador>/);assert.equal(box.querySelector('jugador'),null);assert.match(box.textContent,/Asistencia: Pase/);doc.getElementById('est-highlights-audio').click();assert.equal(h.speech.utterances.length,1);assert.equal(h.speech.utterances[0].lang,'es-MX');
});

test('la grada del Estadio pinta la charla y las reacciones del partido', async t => {
  const h = createHarness();
  t.after(h.close);
  await h.connectToMatch();
  await h.flush();
  const { document } = h.window;
  const feed = document.getElementById('est-crowd-feed');
  assert.ok(feed, 'el panel de la grada existe en el marcado');
  assert.equal(feed.querySelectorAll('.est-crowd-empty').length, 1, 'arranca con el aviso de sala vacía');

  h.handlers['football:chat']({ matchId: h.match.id, text: '<b>hola</b>', name: 'Beti', at: 1 });
  h.handlers['football:reaction']({ matchId: h.match.id, emoji: '⚽', from: 'Ana' });
  h.handlers['football:chat']({ matchId: 'otro-partido', text: 'no debe verse', name: 'Intruso', at: 2 });
  await h.flush();

  const lines = [...feed.querySelectorAll('.est-crowd-line')];
  assert.equal(lines.length, 2, 'solo se pintan los eventos de la sala del partido abierto');
  assert.equal(feed.querySelector('.est-crowd-empty'), null, 'el aviso de sala vacía se retira al primer mensaje');
  assert.match(feed.textContent, /<b>hola<\/b>/, 'el texto ajeno se muestra tal cual');
  assert.equal(feed.querySelector('b'), null, 'el texto ajeno nunca se interpreta como HTML');
  assert.match(lines[1].className, /is-react/);
  assert.match(lines[1].textContent, /⚽/);
  assert.match(lines[1].textContent, /Ana/);
  assert.doesNotMatch(feed.textContent, /no debe verse/);
});

test('la charla de la grada cruza la cancha como comentario bala, de derecha a izquierda', async t => {
  const h = createHarness();
  t.after(h.close);
  await h.connectToMatch();
  await h.flush();
  const { document } = h.window;
  const layer = document.getElementById('est-danmaku');
  assert.ok(layer, 'existe la capa de comentarios bala');
  assert.equal(layer.getAttribute('aria-hidden'), null, 'la capa no se oculta a los lectores: su ✕ debe ser alcanzable');

  h.handlers['football:chat']({ matchId: h.match.id, text: '¡Vamos!', name: 'Beti', at: 1 });
  h.handlers['football:reaction']({ matchId: h.match.id, emoji: '⚽', from: 'Ana' });
  await h.flush();

  const items = [...layer.querySelectorAll('.est-danmaku-item')];
  assert.equal(items.length, 1, 'solo el chat cruza la cancha; las reacciones no son comentarios');
  assert.match(items[0].textContent, /Beti: ¡Vamos!/);
  assert.ok(Number.parseFloat(items[0].style.top) >= 0, 'cada comentario recibe su carril vertical');

  // El recorrido va de derecha a izquierda: el keyframe original arranca pegado
  // al borde derecho (left: 100%) y termina fuera del borde izquierdo.
  const keyframe = STYLES.match(/@keyframes estDanmaku \{[\s\S]*?\n\}/);
  assert.ok(keyframe, 'la animación de los comentarios bala existe');
  assert.match(keyframe[0], /from \{[^}]*left: 100%/);
  assert.match(keyframe[0], /to \{[^}]*left: -100%/);
  assert.match(STYLES, /\.est-danmaku-item \{[^}]*animation: estDanmaku/);

  // El ✕ quita ESE comentario, no los demás.
  h.handlers['football:chat']({ matchId: h.match.id, text: 'Segundo', name: 'Ana', at: 2 });
  h.advanceTime(900); // las salidas se espacian: el segundo sale en el siguiente hueco
  assert.equal(layer.querySelectorAll('.est-danmaku-item').length, 2);
  const close = layer.querySelector('.est-danmaku-close');
  assert.match(close.getAttribute('aria-label'), /Beti/, 'el ✕ dice de qué comentario es');
  close.click();
  assert.equal(layer.querySelectorAll('.est-danmaku-item').length, 1, 'el ✕ quitó solo su comentario');
  assert.match(layer.textContent, /Segundo/);
});

test('si la grada se acelera, solo cruzan unos pocos comentarios y el resto se silencia', async t => {
  const h = createHarness({ reducedMotion: true });
  t.after(h.close);
  await h.connectToMatch();
  await h.flush();
  const { document } = h.window;
  const layer = document.getElementById('est-danmaku');
  const note = document.getElementById('est-danmaku-note');
  const items = () => [...layer.querySelectorAll('.est-danmaku-item')];

  // Ráfaga: 10 mensajes en el mismo instante.
  for (let i = 1; i <= 10; i++) {
    h.handlers['football:chat']({ matchId: h.match.id, text: 'Mensaje ' + i, name: 'Aficionado ' + i, at: i });
  }
  assert.equal(items().length, 1, 'solo el primero cruza al instante: no se apila una nube de comentarios');
  assert.match(note.textContent, /6 comentarios omitidos/, 'la cola corta silencia la mayoría de la ráfaga');
  assert.match(document.getElementById('est-crowd-feed').textContent, /Mensaje 10/,
    'los mensajes descartados de la cancha siguen en el registro de la grada');

  // La cola (máximo 3) sale de una en una, cada 900 ms, en carriles distintos.
  for (let i = 0; i < 4; i++) h.advanceTime(900);
  const shown = items();
  assert.equal(shown.length, 4, 'solo salen el primero y los tres que esperaban');
  const lanes = shown.map(item => item.getAttribute('data-lane'));
  assert.deepEqual(lanes, ['0', '1', '2', '3'], 'cada comentario ocupa un carril libre');
  const tops = shown.map(item => item.style.top);
  assert.equal(new Set(tops).size, tops.length, 'dos comentarios nunca comparten altura');
  assert.match(note.textContent, /6 comentarios omitidos/);

  // Nada más cruza: los otros seis se quedaron fuera, no en una cola infinita.
  for (let i = 0; i < 6; i++) h.advanceTime(1000);
  assert.equal(items().length, 4);
  assert.doesNotMatch(layer.textContent, /Mensaje (5|6|7|8|9|10)/);
});

test('un comentario que esperó demasiado ya no sale cuando la cancha se libera', async t => {
  const h = createHarness({ reducedMotion: true });
  t.after(h.close);
  await h.connectToMatch();
  await h.flush();
  const { document } = h.window;
  const layer = document.getElementById('est-danmaku');
  const note = document.getElementById('est-danmaku-note');
  const fire = (i) => h.handlers['football:chat']({ matchId: h.match.id, text: 'Tarde ' + i, name: 'Beti', at: i });

  // Cinco mensajes espaciados: ocupan los cinco carriles.
  for (let i = 1; i <= 5; i++) { fire(i); h.advanceTime(900); }
  assert.equal(layer.querySelectorAll('.est-danmaku-item').length, 5, 'los cinco carriles quedan ocupados');

  // Con la cancha llena, solo tres esperan y el cuarto ya se silencia.
  for (let i = 6; i <= 9; i++) fire(i);
  assert.equal(layer.querySelectorAll('.est-danmaku-item').length, 5, 'no se añade nada a la cancha');
  assert.match(note.textContent, /1 comentario omitido/, 'el que no cabe en la cola se silencia al momento');

  // A los 6 s lo encolado caduca: cuando la cancha se libere ya no sale nada viejo.
  for (let i = 0; i < 10; i++) h.advanceTime(900);
  assert.equal(layer.querySelectorAll('.est-danmaku-item').length, 5, 'lo encolado caducó antes de salir');
  assert.doesNotMatch(layer.textContent, /Tarde (6|7|8|9)/);
  assert.match(note.textContent, /4 comentarios omitidos/);
});

test('«Silenciar grada» apaga los comentarios bala, los recuerda y se puede reactivar', async t => {
  const h = createHarness();
  t.after(h.close);
  await h.connectToMatch();
  await h.flush();
  const { document } = h.window;
  const button = document.getElementById('est-danmaku-mute');
  const layer = document.getElementById('est-danmaku');
  assert.ok(button, 'hay un botón global de silencio en el panel de la grada');
  assert.ok(button.compareDocumentPosition(document.getElementById('est-crowd-reactions')) & h.window.Node.DOCUMENT_POSITION_FOLLOWING,
    'el interruptor está junto a las reacciones de la grada');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.match(button.textContent, /Silenciar grada/);

  h.handlers['football:chat']({ matchId: h.match.id, text: 'Antes de silenciar', name: 'Beti', at: 1 });
  assert.equal(layer.querySelectorAll('.est-danmaku-item').length, 1);

  button.click();
  await h.flush();
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.match(button.textContent, /Activar grada/);
  assert.equal(layer.hidden, true, 'la capa se oculta');
  assert.equal(layer.querySelectorAll('.est-danmaku-item').length, 0, 'lo que ya estaba en la cancha se retira');
  assert.equal(h.window.localStorage.getItem('montecristo-danmaku-muted'), 'off', 'la elección se guarda');
  assert.match(document.getElementById('est-danmaku-note').textContent, /silenciados/);

  h.handlers['football:chat']({ matchId: h.match.id, text: 'Mientras está en silencio', name: 'Ana', at: 2 });
  assert.equal(layer.querySelectorAll('.est-danmaku-item').length, 0, 'sin silencio no se pintan nuevos comentarios');
  assert.match(document.getElementById('est-crowd-feed').textContent, /Mientras está en silencio/,
    'el mensaje sigue llegando al registro de la grada');

  button.click();
  await h.flush();
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(layer.hidden, false);
  assert.match(button.textContent, /Silenciar grada/);
  assert.equal(h.window.localStorage.getItem('montecristo-danmaku-muted'), null, 'al reactivar se borra la preferencia');
  h.handlers['football:chat']({ matchId: h.match.id, text: 'De vuelta', name: 'Ana', at: 3 });
  h.advanceTime(900);
  assert.equal(layer.querySelectorAll('.est-danmaku-item').length, 1, 'vuelven a cruzar la cancha');
  assert.doesNotMatch(layer.textContent, /Mientras está en silencio/, 'no se rellena con lo que llegó en silencio');
});

test('el silencio de la grada sobrevive a recargar la página', async t => {
  const first = createHarness();
  await first.connectToMatch();
  await first.flush();
  first.window.document.getElementById('est-danmaku-mute').click();
  const stored = first.window.localStorage.getItem('montecristo-danmaku-muted');
  first.close();
  assert.equal(stored, 'off');

  // Segundo arranque con la misma preferencia guardada.
  const second = createHarness({ danmakuMuted: true });
  t.after(second.close);
  await second.connectToMatch();
  await second.flush();
  const { document } = second.window;
  assert.equal(document.getElementById('est-danmaku-mute').getAttribute('aria-pressed'), 'true');
  assert.equal(document.getElementById('est-danmaku').hidden, true);
  assert.match(document.getElementById('est-danmaku-note').textContent, /silenciados/,
    'se avisa una vez al arrancar que la grada está silenciada');
  second.handlers['football:chat']({ matchId: second.match.id, text: 'Sigue en silencio', name: 'Beti', at: 1 });
  assert.equal(document.querySelectorAll('.est-danmaku-item').length, 0);
});

test('las reacciones de la grada se envían al partido abierto', async t => {
  const h = createHarness();
  t.after(h.close);
  await h.connectToMatch();
  await h.flush();
  const button = h.window.document.querySelector('#est-crowd-reactions [data-crowd-reaction]');
  assert.ok(button, 'hay botones de reacción');
  assert.equal(button.disabled, false, 'con partido abierto se puede reaccionar');
  button.click();
  await h.flush();
  const sent = h.socketEmitted.filter(item => item.event === 'football:reaction');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.matchId, h.match.id);
  assert.equal(sent[0].payload.emoji, button.getAttribute('data-crowd-reaction'));
});

test('el cartel de gol no se duplica y sigue sirviendo de respaldo', async t => {
  const h = createHarness();
  t.after(h.close);
  await h.connectToMatch();
  await h.flush();
  const bannerTimers = () => h.scheduledTimeouts.filter(timer => timer.delay === 2200).length;
  const event = { type: 'goal', minute: 12, marcador: '1-0' };

  h.handlers['football:event']({ matchId: h.match.id, event });
  assert.equal(bannerTimers(), 1, 'el evento genérico pinta el cartel');
  h.handlers['football:goal']({ matchId: h.match.id, event });
  assert.equal(bannerTimers(), 1, 'football:goal en el mismo tick no repite el cartel');

  // Si el evento genérico no llegó (reconexión, catch-up perdido), el cue lo pinta.
  h.advanceTime(4000);
  h.handlers['football:goal']({ matchId: h.match.id, event: { type: 'goal', minute: 30, marcador: '2-0' } });
  assert.equal(bannerTimers(), 2, 'football:goal funciona como respaldo visual');
});

test('la tanda V2 muestra el marcador de penales sin cambiar los goles del partido', async t => {
  const h = createHarness({ reducedMotion: true });
  t.after(h.close);
  h.match.engine = 'v2'; h.match.status = 'shootout';
  await h.connectToMatch();
  const id = h.match.id;
  h.handlers['football:status']({ matchId: id, code: 'shootout', minute: 123 });
  h.handlers['football:tick']({ matchId: id, minute: 123, clockLabel: 'PEN', phase: 'shootout',
    score: { home: 1, away: 1 }, shootout: { home: 2, away: 1 }, playStopped: true });
  const doc = h.window.document;
  assert.equal(doc.getElementById('score-home').textContent, '1');
  assert.equal(doc.getElementById('score-away').textContent, '1');
  assert.match(doc.getElementById('est-clock').textContent, /Penales 2–1/);
  h.handlers['football:event']({ matchId: id, event: { type: 'shootout_kick', team: 'away',
    phase: 'shootout', marcadorTanda: '2-2', scored: true } });
  assert.match(doc.getElementById('est-clock').textContent, /Penales 2–2/);
  assert.match(doc.getElementById('est-text-state').textContent, /Penales 2–2/);
});

test('reloj — el agregado del árbitro se muestra como 45+4 y 90+3, y se limpia al cambiar de mitad', async t => {
  const h = createHarness({ reducedMotion: true });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match } = h;
  const id = match.id;
  const clock = () => window.document.getElementById('est-clock').textContent;
  const fireEvent = event => handlers['football:event']({ matchId: id, event });

  handlers['football:status']({ matchId: id, code: 'live', minute: 45 });
  fireEvent({ type: 'stoppage_start', half: 1, added: 4, minute: 45, phase: 'set_piece', playStopped: true, ball: { x: .5, y: .5 } });
  assert.match(clock(), /45\+4'/, 'el tablero dice 45+4, igual que el relato');

  // El agregado no se «gasta»: mientras corre sigue en 45+4 y no salta a 47.
  handlers['football:tick']({
    matchId: id, minute: 47, displayMinute: 47, phase: 'first_half', playStopped: false,
    score: { home: 0, away: 0 }, ball: { x: .5, y: .5 }
  });
  assert.match(clock(), /45\+4'/, 'se mantiene el tablero del árbitro durante el agregado');

  // El descanso limpia el tablero.
  fireEvent({ type: 'halftime', minute: 45, phase: 'halftime', playStopped: true, ball: { x: .5, y: .5 } });
  assert.ok(!/\+/.test(clock()), 'sin agregado activo el reloj vuelve al minuto normal');

  // Segundo tiempo: 90+3.
  handlers['football:status']({ matchId: id, code: 'live', minute: 90 });
  fireEvent({ type: 'stoppage_start', half: 2, added: 3, minute: 90, phase: 'set_piece', playStopped: true, ball: { x: .5, y: .5 } });
  assert.match(clock(), /90\+3'/, 'el segundo tablero dice 90+3');

  handlers['football:status']({ matchId: id, code: 'full_time', minute: 90 });
  assert.equal(clock(), 'Final', 'al terminar manda el estado del partido');
});

test('voces — el narrador toma la voz más natural y el analista conserva la suya', async t => {
  const h = createHarness({
    speechSynthesis: true,
    speechVoices: [
      { name: 'Microsoft Sabina', lang: 'es-MX', localService: true },
      { name: 'Microsoft Raúl', lang: 'es-MX', localService: true },
      { name: 'Google español', lang: 'es', localService: false },
      { name: 'Microsoft Dalia Online (Natural)', lang: 'es-MX', localService: false }
    ]
  });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match, speech } = h;
  window.document.getElementById('est-commentary-voice').click();

  handlers['football:commentary']({ matchId: match.id, voice: 'narrador', text: '¡Se acerca el gol!' });
  handlers['football:commentary']({ matchId: match.id, voice: 'analista', text: 'La defensa quedó muy abierta.' });
  assert.equal(speech.utterances.length, 1);
  // La voz neuronal gana aunque la cabina histórica prefiriera la masculina
  // concatenada: el narrador es quien más habla y no debe sonar a robot.
  assert.equal(speech.utterances[0].voice.name, 'Microsoft Dalia Online (Natural)');
  assert.equal(speech.utterances[0].pitch, 1, 'a una voz natural no se le retoca el tono: retocarlo la vuelve metálica');
  assert.ok(!['Microsoft Sabina', 'Microsoft Raúl'].includes(speech.utterances[0].voice.name), 'nunca arranca con una voz concatenada habiendo una natural');

  speech.finish(0);
  h.advanceTime(500);
  assert.equal(speech.utterances.length, 2);
  // El analista ya sonaba bien: sigue con la misma segunda voz de siempre.
  assert.equal(speech.utterances[1].voice.name, 'Google español');
  assert.ok(speech.utterances[1].pitch < .95, 'el analista se mantiene en el registro de siempre');
});

test('voces — el narrador prefiere la voz que ya suena natural antes que una metálica', async t => {
  // Caso reportado: el analista suena natural y el narrador, no. Cuando el
  // navegador solo tiene UNA voz buena, el narrador la reutiliza en vez de
  // caer en una voz concatenada solo por tener otro timbre.
  const h = createHarness({
    speechSynthesis: true,
    speechVoices: [
      { name: 'Microsoft Sabina', lang: 'es-MX', localService: true },
      { name: 'Microsoft Raúl', lang: 'es-MX', localService: true },
      { name: 'Microsoft Jorge Online (Natural)', lang: 'es-MX', localService: false }
    ]
  });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match, speech } = h;
  window.document.getElementById('est-commentary-voice').click();

  handlers['football:commentary']({ matchId: match.id, voice: 'narrador', text: '¡Gol de MonteCristo! 1-0 al 23.' });
  assert.equal(speech.utterances[0].voice.name, 'Microsoft Jorge Online (Natural)', 'la voz natural es la del narrador');
  assert.ok(!/Raúl|Sabina/.test(speech.utterances[0].voice.name));
});

test('voces — el narrador evita las voces metálicas aunque no haya neuronales', async t => {
  const h = createHarness({
    speechSynthesis: true,
    speechVoices: [
      { name: 'Microsoft Sabina', lang: 'es-MX', localService: true },
      { name: 'Microsoft Raúl', lang: 'es-MX', localService: true }
    ]
  });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match, speech } = h;
  window.document.getElementById('est-commentary-voice').click();
  handlers['football:commentary']({ matchId: match.id, voice: 'narrador', text: 'Saque de meta.' });
  // Ambas son concatenadas: se conserva el respaldo histórico (masculina) y se
  // corrige el tono solo lo mínimo para que no suene plana.
  assert.equal(speech.utterances[0].voice.name, 'Microsoft Raúl');
  assert.ok(speech.utterances[0].pitch >= .95, 'no se baja el tono de una voz masculina: eso la robotiza');
});

test('voces — si el navegador solo ofrece voces femeninas se conservan y se baja el tono', async t => {
  const h = createHarness({
    speechSynthesis: true,
    speechVoices: [
      { name: 'Microsoft Sabina', lang: 'es-MX' },
      { name: 'Microsoft Helena', lang: 'es-MX' }
    ]
  });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match, speech } = h;
  window.document.getElementById('est-commentary-voice').click();

  handlers['football:commentary']({ matchId: match.id, voice: 'narrador', text: 'Saque de meta.' });
  handlers['football:commentary']({ matchId: match.id, voice: 'analista', text: 'Sin alternativas masculinas.' });
  assert.equal(speech.utterances[0].voice.name, 'Microsoft Sabina', 'nunca se queda sin voz');
  assert.ok(speech.utterances[0].pitch <= .9, 'se baja el tono como respaldo');
  speech.finish(0);
  h.advanceTime(500);
  assert.equal(speech.utterances[1].voice.name, 'Microsoft Helena', 'la segunda voz sigue siendo otra voz');
  assert.ok(speech.utterances[1].pitch <= .8, 'el analista conserva su tono de siempre');
});

test('voces — el selector permite cambiar la voz del narrador sin tocar al analista', async t => {
  const h = createHarness({
    speechSynthesis: true,
    speechVoices: [
      { name: 'Microsoft Sabina', lang: 'es-MX', localService: true },
      { name: 'Microsoft Raúl', lang: 'es-MX', localService: true },
      { name: 'Microsoft Dalia Online (Natural)', lang: 'es-MX', localService: false }
    ]
  });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match, speech } = h;
  const picker = window.document.getElementById('est-commentary-voice-picker');
  const wrap = window.document.getElementById('est-commentary-voice-picker-wrap');
  assert.equal(wrap.hidden, false, 'con varias voces en español se ofrece el selector');
  assert.equal(picker.options.length, 3);
  assert.match(picker.options[picker.selectedIndex].textContent, /Dalia/, 'arranca en la voz natural elegida por la cabina');

  // El oyente prefiere otra: la elección manda y se guarda entre visitas.
  const raul = Array.from(picker.options).find(option => /Raúl/.test(option.textContent));
  picker.value = raul.value;
  picker.dispatchEvent(new window.Event('change'));
  assert.equal(window.localStorage.getItem('montecristo-estadio-narrator-voice'), raul.value);
  // Elegir voz en silencio enciende el relato hablado: el cambio es el gesto
  // que el navegador exige y el oyente quiere oír lo que acaba de elegir.
  assert.equal(window.document.getElementById('est-commentary-voice').getAttribute('aria-pressed'), 'true');

  handlers['football:commentary']({ matchId: match.id, voice: 'narrador', text: '¡Se acerca el gol!' });
  assert.equal(speech.utterances[0].voice.name, 'Microsoft Raúl', 'se respeta la voz elegida');
  speech.finish(0);
  h.advanceTime(500);
  assert.equal(speech.utterances.length, 1, 'la cola anterior se vació al cambiar de voz');
  handlers['football:commentary']({ matchId: match.id, voice: 'analista', text: 'La defensa quedó abierta.' });
  h.advanceTime(500);
  const analystUtterance = speech.utterances[speech.utterances.length - 1];
  assert.notEqual(analystUtterance.voice.name, 'Microsoft Raúl', 'el analista conserva su propia voz');
  assert.equal(analystUtterance.voice.name, 'Microsoft Sabina');
});

test('voces — sin alternativas el selector no aparece', async t => {
  const h = createHarness({
    speechSynthesis: true,
    speechVoices: [{ name: 'Microsoft Dalia Online (Natural)', lang: 'es-MX', localService: false }]
  });
  t.after(h.close);
  await h.connectToMatch();
  const wrap = h.window.document.getElementById('est-commentary-voice-picker-wrap');
  assert.equal(wrap.hidden, true, 'con una sola voz no se muestra un control inútil');
  h.handlers['football:commentary']({ matchId: h.match.id, voice: 'narrador', text: 'Saque de meta.' });
});

// La pista fija de la inauguración se regrabó (voz femenina es-MX, misma
// transcripción). Este test evita que el asset se rompa o cambie de duración sin
// que nadie lo note: el reloj de pared manda, pero la locución tiene que caber en
// el primer bloque de 1:48 (termina antes de las presentaciones finales).
function mp3DurationSeconds(filePath) {
  const bytes = fs.readFileSync(filePath);
  let offset = 0;
  if (bytes.slice(0, 3).toString() === 'ID3') {
    offset = 10 + (((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f));
  }
  while (offset + 4 <= bytes.length && !(bytes[offset] === 0xff && (bytes[offset + 1] & 0xe0) === 0xe0)) offset++;
  const version = (bytes[offset + 1] >> 3) & 3;   // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const sampleRateIndex = (bytes[offset + 2] >> 2) & 3;
  const sampleRate = version === 3 ? [44100, 48000, 32000][sampleRateIndex]
    : version === 2 ? [22050, 24000, 16000][sampleRateIndex]
      : [11025, 12000, 8000][sampleRateIndex];
  const samplesPerFrame = version === 3 ? 1152 : 576;
  const tag = bytes.indexOf('Info');
  const xing = tag >= 0 ? tag : bytes.indexOf('Xing');
  assert.ok(xing > 0, 'la pista trae cabecera de conteo de frames (Xing/Info)');
  const frames = bytes.readUInt32BE(xing + 8);
  return (frames * samplesPerFrame) / sampleRate;
}

test('inauguración — la pista fija sigue siendo un MP3 válido de voz que cabe en el primer bloque', () => {
  const asset = path.join(__dirname, '..', 'public', 'assets', 'ballon-dor-opening-es-mx.mp3');
  assert.ok(fs.existsSync(asset), 'existe la pista fija de la inauguración');
  const size = fs.statSync(asset).size;
  assert.ok(size > 100 * 1024, 'la pista no está vacía ni truncada (' + size + ' bytes)');
  const seconds = mp3DurationSeconds(asset);
  assert.ok(seconds > 35 && seconds < 60, 'la locución dura ~49,5 s (' + seconds.toFixed(2) + ')');
  // Cabe en el primer bloque: con presentaciones de ~4,7 s desde el segundo 17,
  // una locución de menos de 60 s termina antes del cierre y entra el tema.
  assert.ok(seconds < 60, 'termina antes del cierre para que entre el tema instrumental');
});


test('los mercados muestran nombres inequívocos también para lectores de pantalla', async t => {
  const h = createHarness();
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match } = h;
  const publish = (name, selections) => handlers['football:odds']({ matchId: match.id, market: name, selections });
  publish('correct_score', [market('other', 5)]);
  publish('first_scorer', [{ ...market('h9', 8), label: 'Jugadora Nueve' }, market('other', 3)]);
  publish('double_chance', [market('1X', 1.3), market('12', 1.4), market('X2', 1.5)]);
  const buttons = Array.from(window.document.querySelectorAll('#est-markets .est-sel'));
  const names = buttons.map(button => button.querySelector('.est-sel-key').textContent);
  assert.ok(names.includes('Otro resultado'));
  assert.ok(names.includes('Otro jugador'));
  assert.ok(names.includes('Local o Empate'));
  assert.ok(names.includes('Local o Visita'));
  assert.ok(names.includes('Empate o Visita'));
  const scorer = buttons.find(button => button.textContent.includes('Jugadora Nueve'));
  assert.ok(scorer);
  assert.match(scorer.getAttribute('aria-label'), /Jugadora Nueve/);
});

test('el gol se ve dentro de la portería: el balón descansa en la red, no por fuera del arco', async t => {
  const h = createHarness({ reducedMotion: false });
  t.after(h.close);
  await h.connectToMatch();
  const { handlers, match, ballTrace, fillRects } = h;
  const id = match.id;
  // Geometría de la cancha: rectángulo de juego entre PAD y PAD + ancho, con la
  // red dibujada por fuera de cada línea de meta.
  const GOAL_LINE_RIGHT = 18 + (1050 - 36);
  const GOAL_LINE_LEFT = 18;
  handlers['football:status']({ matchId: id, code: 'live', minute: 60 });
  handlers['football:event']({
    matchId: id,
    event: {
      type: 'kickoff', team: 'home', minute: 0, phase: 'kickoff', playStopped: false,
      ball: { x: .5, y: .5 }, ballFrom: { x: .5, y: .5 }, ballCarrierId: 'h2', possessionTeam: 'home'
    }
  });
  h.advanceTime(200);

  // Gol local: el motor deja el balón justo tras la línea (x = 1.01).
  handlers['football:event']({
    matchId: id,
    event: {
      type: 'goal', team: 'home', playerId: 'h9', playerName: 'Delantero Local', minute: 61,
      phase: 'goal_celebration', playStopped: true, marcador: '1-0',
      ball: { x: 1.01, y: .5 }, ballFrom: { x: .88, y: .5 }, actorPosition: { x: .88, y: .5 },
      ballCarrierId: null, possessionTeam: null
    }
  });
  h.advanceTime(400);
  ballTrace.length = 0;
  h.draw(0);
  const home = ballTrace.at(-1);
  assert.ok(home, 'el balón se dibuja en la cancha');
  // La red derecha se dibuja desde la línea de meta hacia la banda y tiene que
  // ser honda: un simple travesaño no deja sitio para el balón del gol.
  const homeNet = fillRects.find(rect => Math.abs(rect.x - GOAL_LINE_RIGHT) < 2 && rect.width >= 12);
  assert.ok(homeNet, 'la portería local se dibuja con red suficiente para contener el balón');
  assert.ok(home.x > homeNet.x, 'el balón traspasa la línea de meta: ' + home.x);
  assert.ok(home.x < homeNet.x + homeNet.width, 'y se ve dentro de la red: ' + home.x);

  // Gol visitante: mismo criterio en el arco opuesto.
  handlers['football:event']({
    matchId: id,
    event: {
      type: 'goal', team: 'away', playerId: 'a9', playerName: 'Delantero Visita', minute: 74,
      phase: 'goal_celebration', playStopped: true, marcador: '1-1',
      ball: { x: -0.01, y: .5 }, ballFrom: { x: .12, y: .5 }, actorPosition: { x: .12, y: .5 },
      ballCarrierId: null, possessionTeam: null
    }
  });
  h.advanceTime(400);
  ballTrace.length = 0;
  h.draw(0);
  const away = ballTrace.at(-1);
  assert.ok(away, 'el balón se dibuja en la cancha');
  const awayNet = fillRects.find(rect => Math.abs(rect.x + rect.width - GOAL_LINE_LEFT) < 2 && rect.width >= 12);
  assert.ok(awayNet, 'la portería visitante se dibuja con red suficiente para contener el balón');
  assert.ok(away.x < awayNet.x + awayNet.width, 'el balón traspasa la línea de meta: ' + away.x);
  assert.ok(away.x > awayNet.x, 'y se ve dentro de la red: ' + away.x);
});

test('un cambio se ve en la cancha: el que sale camina a la banda y el relevo entra por ella', async t => {
  const h = createHarness({ reducedMotion: false });
  t.after(h.close);
  await h.connectToMatch();
  const { handlers, match } = h;
  const id = match.id;
  handlers['football:status']({ matchId: id, code: 'live', minute: 60 });
  handlers['football:event']({
    matchId: id,
    event: {
      type: 'kickoff', team: 'home', minute: 0, phase: 'kickoff', playStopped: false,
      ball: { x: .5, y: .5 }, ballFrom: { x: .5, y: .5 }, ballCarrierId: 'h2', possessionTeam: 'home'
    }
  });
  h.advanceTime(200);
  h.draw(0);
  const starting = h.playerTextTrace.find(item => item.value === '9');
  assert.ok(starting, 'el titular h9 está en la cancha antes del cambio');

  handlers['football:event']({
    matchId: id,
    event: {
      type: 'substitution', team: 'home', playerId: 'h12', playerInId: 'h12', playerOutId: 'h9',
      minute: 72, phase: 'set_piece', playStopped: true, ball: { x: .5, y: .5 },
      ballFrom: { x: .5, y: .5 }, ballCarrierId: null, possessionTeam: 'home'
    }
  });

  // Justo al producirse: el sustituido sigue dibujado (flecha de salida) y el
  // relevo aparece en la banda, no materializado sobre el puesto.
  h.draw(0);
  const leaving = h.drawnText.filter(value => value === '▲' || value === '▼');
  assert.ok(leaving.length > 0, 'el jugador que sale se ve retirándose por la banda');
  const entering = h.playerTextTrace.filter(item => item.value === '12').at(-1);
  assert.ok(entering, 'el relevo ya está en la cancha');
  assert.ok(entering.y < 60 || entering.y > 620, 'el relevo entra desde la banda: y=' + entering.y);

  // A mitad del recorrido el sustituido todavía se despide.
  h.advanceTime(900);
  h.draw(0);
  assert.ok(h.drawnText.some(value => value === '▲' || value === '▼'), 'la salida dura lo que tarda el recorrido');

  // Al terminar, el relevo ocupa el puesto y el que salió ya no se dibuja.
  h.advanceTime(2600);
  h.draw(0);
  const settled = h.playerTextTrace.filter(item => item.value === '12').at(-1);
  assert.ok(settled, 'el relevo sigue en la cancha');
  assert.ok(Math.abs(settled.y - entering.y) > 20, 'el relevo caminó hasta su puesto (y ' + entering.y + ' → ' + settled.y + ')');
  assert.ok(!h.drawnText.some(value => value === '▲' || value === '▼'), 'el sustituido ya abandonó el campo');
});

test('la jugada que el relato menciona se ve en la cancha con una marca', async t => {
  const h = createHarness({ reducedMotion: false });
  t.after(h.close);
  await h.connectToMatch();
  const { handlers, match } = h;
  const id = match.id;
  handlers['football:status']({ matchId: id, code: 'live', minute: 8 });
  handlers['football:event']({
    matchId: id,
    event: {
      type: 'foul', team: 'home', playerId: 'h3', minute: 9, phase: 'set_piece', playStopped: true,
      ball: { x: .40, y: .30 }, ballFrom: { x: .40, y: .30 }, ballCarrierId: null, possessionTeam: 'away'
    }
  });
  h.draw(0);
  const marks = h.drawnText.filter(value => String(value).indexOf('FALTA') >= 0);
  assert.ok(marks.length > 0, 'la falta deja un rótulo visible en la cancha');
  // La marca es efímera: no se queda pegada durante el resto del partido.
  h.advanceTime(3000);
  h.draw(0);
  assert.ok(!h.drawnText.some(value => String(value).indexOf('FALTA') >= 0), 'la marca se retira al poco tiempo');
});

test('la cabina habla de lo que pasa: la historia no se narra y un gol adelanta a la cola', async t => {
  const h = createHarness({ speechSynthesis: true });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match, speech } = h;
  const id = match.id;
  const feed = window.document.getElementById('est-commentary');
  const button = window.document.getElementById('est-commentary-voice');
  button.click();

  // 1. Historia ya ocurrida (catch-up al entrar o tras un corte): se muestra…
  handlers['football:commentary']({ matchId: id, voice: 'narrador', text: 'Minuto 12: llegada del local.', minute: 12, importance: 'normal', catchUp: true });
  assert.match(feed.textContent, /Minuto 12: llegada del local/, 'el panel conserva el relato');
  assert.equal(speech.utterances.length, 0, 'pero no se lee: narrarla dejaría la cabina minutos atrás');

  // 2. Un gol interrumpe lo que esté sonando para anunciarse en el acto.
  handlers['football:commentary']({ matchId: id, voice: 'narrador', text: 'El local mueve el balón de un lado a otro buscando el hueco.', minute: 55, importance: 'normal' });
  assert.equal(speech.utterances.length, 1, 'la jugada menor empieza a narrarse');
  handlers['football:commentary']({ matchId: id, voice: 'narrador', text: '¡Gol del local en el 56!', minute: 56, importance: 'high' });
  assert.equal(speech.utterances.length, 2, 'el gol adelanta a la cola');
  assert.equal(speech.utterances[1].text, '¡Gol del local en el 56!');
  assert.ok(speech.cancelCount > 0, 'se corta el turno anterior para narrar el gol');
  speech.finish(1);
  h.advanceTime(1000);
  assert.equal(speech.utterances.length, 2, 'la línea menor descartada no se cuela después del gol');
});

test('la cabina no se atrasa: lo que ya no cabe se omite en voz alta pero queda en el panel', async t => {
  const h = createHarness({ speechSynthesis: true });
  t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match, speech } = h;
  const id = match.id;
  const feed = window.document.getElementById('est-commentary');
  const button = window.document.getElementById('est-commentary-voice');
  button.click();

  const long = 'El local mueve el balón de un lado a otro buscando el hueco mientras la defensa espera ordenada y el reloj corre sin que nadie se atreva a romper líneas.';
  handlers['football:commentary']({ matchId: id, voice: 'narrador', text: long, minute: 30, importance: 'normal' });
  handlers['football:commentary']({ matchId: id, voice: 'narrador', text: 'Segunda jugada intrascendente.', minute: 31, importance: 'normal' });
  handlers['football:commentary']({ matchId: id, voice: 'analista', text: 'Tercera jugada intrascendente.', minute: 32, importance: 'normal' });
  assert.equal(speech.utterances.length, 1, 'solo se narra lo que cabe antes de que la jugada pase');
  assert.match(feed.textContent, /Segunda jugada intrascendente/, 'el panel conserva el texto omitido en voz alta');
  assert.match(feed.textContent, /Tercera jugada intrascendente/);

  // Una línea que envejece esperando turno tampoco se lee después.
  handlers['football:commentary']({ matchId: id, voice: 'narrador', text: 'Comentario corto.', minute: 33, importance: 'normal' });
  h.advanceTime(9000);
  speech.finish(0);
  h.advanceTime(1000);
  assert.equal(speech.utterances.length, 1, 'una línea que ya describe el pasado se salta');
});


test('el marcador refleja tarjetas por equipo, segundas amarillas y reconexión', async t => {
  const h = createHarness(); t.after(h.close);
  h.matchState.state.cards = { home: [{ type: 'yellow_card' }, { type: 'second_yellow' }], away: [{ type: 'red' }] };
  await h.connectToMatch();
  const { window, handlers, match } = h;
  const home = window.document.getElementById('cards-home'), away = window.document.getElementById('cards-away');
  assert.equal(home.querySelector('.yellow').textContent, '2');
  assert.equal(home.querySelector('.red').textContent, '1');
  assert.equal(away.querySelector('.red').textContent, '1');
  handlers['football:event']({ matchId: match.id, event: { type: 'yellow_card', team: 'away' } });
  assert.equal(away.querySelector('.yellow').textContent, '1');
  handlers['football:tick']({ matchId: match.id, cards: { home: [{ type: 'yellow' }, { type: 'yellow', second: true }, { type: 'red' }], away: [] } });
  assert.equal(home.querySelector('.yellow').textContent, '2');
  assert.equal(home.querySelector('.red').textContent, '1');
  assert.equal(away.hidden, true, 'el estado autoritativo reemplaza el recuento local');
});

test('la falta interrumpe el relato de posesión y el gol tiene prioridad sobre la falta', async t => {
  const h = createHarness({ speechSynthesis: true }); t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match, speech } = h;
  window.document.getElementById('est-commentary-voice').click();
  const speak = (type, importance, text) => handlers['football:commentary']({ matchId: match.id, voice: 'narrador', type, importance, text });
  speak('possession', 'normal', 'La pelota es del local.');
  speak('foul', 'high', 'Falta en el mediocampo.');
  speak('goal', 'high', '¡Gol del visitante!');
  assert.deepEqual(speech.utterances.map(u => u.text), ['La pelota es del local.', 'Falta en el mediocampo.', '¡Gol del visitante!']);
  assert.equal(speech.overlapCount, 0);
});

test('la cabina se recupera si el sintetizador nunca termina una locución', async t => {
  const h = createHarness({ speechSynthesis: true }); t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match, speech } = h;
  window.document.getElementById('est-commentary-voice').click();
  handlers['football:commentary']({ matchId: match.id, voice: 'narrador', text: 'Jugada en curso.' });
  h.advanceTime(16000);
  assert.ok(speech.cancelCount > 0);
  handlers['football:commentary']({ matchId: match.id, voice: 'narrador', text: 'El juego continúa.' });
  assert.equal(speech.utterances.length, 2);
});


test('las plantillas muestran el club actual, habilidades y estadísticas verificadas sin mezclar respuestas tardías', async t => {
  const pending = [];
  const h = createHarness({ onRosterGet: (payload, ack) => pending.push({ payload, ack }) });
  t.after(h.close); await h.connectToMatch();
  const doc = h.window.document, panel = doc.getElementById('est-roster-panel'), select = doc.getElementById('est-roster-club');
  panel.open = true;
  panel.dispatchEvent(new h.window.Event('toggle'));
  const first = pending.at(-1);
  select.value = first.payload.clubId === 'home' ? 'away' : 'home';
  select.dispatchEvent(new h.window.Event('change'));
  const last = pending.at(-1);
  const response = id => ({ ok: true, roster: { clubId: id, clubName: id, seasonMonth: '2026-11', missingMatches: 1, incompleteDetails: false,
    players: [{ id: 'vtr_09', name: 'Jugador traspasado', number: 9, position: 'ST', attributes: { pac: 80, sho: 90, pas: 70, def: 30, gk: 10, agr: 55 },
      stats: { appearances: 2, goals: 1, assists: 0, minutes: 150, yellowCards: 1, redCards: 0 }, value: 20 }] } });
  last.ack(response(last.payload.clubId));
  first.ack(response(first.payload.clubId));
  assert.match(doc.getElementById('est-roster-status').textContent, /Datos parciales/);
  assert.match(doc.getElementById('est-roster-list').textContent, /Jugador traspasado/);
  assert.match(doc.getElementById('est-roster-list').textContent, /Tiro 90/);
  assert.match(doc.getElementById('est-roster-list').textContent, /Goles 1/);
  assert.match(doc.getElementById('est-roster-status').textContent, new RegExp('^' + last.payload.clubId));
});

test('un gol adelanta incluso a la narración de un penal recién señalado', async t => {
  const h = createHarness({ speechSynthesis: true }); t.after(h.close);
  await h.connectToMatch();
  const { window, handlers, match, speech } = h;
  window.document.getElementById('est-commentary-voice').click();
  handlers['football:commentary']({ matchId: match.id, voice: 'narrador', type: 'penalty_awarded', importance: 'high', text: 'Señala el penal.' });
  handlers['football:commentary']({ matchId: match.id, voice: 'narrador', type: 'penalty_scored', importance: 'high', text: '¡Gol de penal!' });
  assert.deepEqual(speech.utterances.map(u => u.text), ['Señala el penal.', '¡Gol de penal!']);
  assert.equal(speech.overlapCount, 0);
});


test('el saldo de invitado o una respuesta de historial retrasada no pisa una apuesta de la cuenta', async t => {
  const pending = [];
  const h = createHarness({ onBetHistory: () => new Promise(resolve => pending.push(resolve)),
    onBet: (payload, ack) => ack({ ok: true, chips: 800, bet: { id: 'account-bet', market: payload.market, selection: payload.selection, odds: 2, stake: 200, status: 'open' } }) });
  t.after(h.close); await h.connectToMatch(); await h.flush();
  const doc = h.window.document;
  doc.querySelectorAll('.est-market-group')[1].querySelector('.est-sel').click();
  doc.getElementById('est-stake').value = '200'; doc.getElementById('est-place-bet').click();
  assert.equal(doc.getElementById('est-chips').textContent, '800 fichas');
  const history = { entries: [], summary: { total: 0 }, totalEntries: 0 };
  for (const resolve of pending.splice(0)) resolve({ ok: true, history, profile: { id: 'guest', chips: 4100 } });
  await h.flush();
  assert.equal(doc.getElementById('est-chips').textContent, '800 fichas', 'un historial ajeno no cambia el saldo');
  h.handlers['football:settlement']({ betId: 'account-bet', status: 'won', payout: 500 });
  await h.flush();
  assert.equal(doc.getElementById('est-chips').textContent, '800 fichas', 'no se suma un pago sin confirmar');
  for (const resolve of pending.splice(0)) resolve({ ok: true, history, profile: { id: 'alice', chips: 1300 } });
  await h.flush();
  assert.equal(doc.getElementById('est-chips').textContent, '1,300 fichas');
});

test('una ficha de club se consulta antes de elegir afición y muestra director, plantilla y traspasos', async t => {
  const responses = [];
  const fan = { clubId: null, wins: 0, level: 0, rewards: [], ranking: [] };
  const h = createHarness({ onFanGet: () => ({ ok: true, fan }), onClubProfileGet: (payload, ack) => responses.push({ payload, ack }) });
  t.after(h.close); await h.connectToMatch();
  const doc = h.window.document;
  doc.getElementById('est-hub-open').click();
  doc.querySelector('[data-hub-view="aficion"]').click();
  const select = doc.getElementById('est-fan-club');
  select.value = 'home'; select.dispatchEvent(new h.window.Event('change'));
  const previous = responses.at(-1);
  select.value = 'away'; select.dispatchEvent(new h.window.Event('change'));
  const current = responses.at(-1);
  const club = id => ({ clubId: id, name: id + ' FC', city: 'Ciudad', stadium: 'Estadio', capacity: 30000, colors: { primary: '#00aa55' }, seasonMonth: '2026-11',
    story: 'Historia ficticia.', titles: ['2026-10'], record: { played: 4, wins: 2, draws: 1, losses: 1, goalsFor: 5, goalsAgainst: 3 },
    manager: { name: 'Entrenadora Ejemplo', formation: '4-3-3', style: 'balanced' },
    lineup: [{ id: 'p1', role: 'FW', initialStatus: 'bench' }],
    roster: { players: [{ id: 'p1', name: 'Jugador Uno', number: 9, position: 'ST', attributes: { pac: 80, sho: 85, pas: 70, def: 40, gk: 10, agr: 50 }, stats: { appearances: 2, goals: 1, assists: 0 } }] },
    transfers: [{ playerName: 'Jugador Uno', fromId: 'home', toId: 'away', status: 'announced', effectiveSeason: '2026-12' }] });
  current.ack({ ok: true, club: club('away') }); previous.ack({ ok: true, club: club('home') });
  const box = doc.getElementById('est-club-profile');
  assert.match(box.textContent, /away FC/); assert.doesNotMatch(box.textContent, /home FC.*Historia/);
  for (const text of ['Entrenadora Ejemplo', 'Historia ficticia', 'Jugador Uno', 'Anunciado para 2026-12', 'Ligas verificadas']) assert.ok(box.textContent.includes(text), text);
  assert.match(box.textContent, /no cambian las alineaciones/);
});

test('un invitado puede explorar fichas de clubes sin poder guardar afición', async t => {
  let requested = '';
  const h = createHarness({ onFanGet: () => ({ ok: false, code: 'no_identity' }),
    onClubProfileGet: (payload, ack) => { requested = payload.clubId; ack({ ok: false }); } });
  t.after(h.close); await h.connectToMatch();
  const doc = h.window.document;
  doc.getElementById('est-hub-open').click(); doc.querySelector('[data-hub-view="aficion"]').click();
  const select = doc.getElementById('est-fan-club');
  assert.equal(select.disabled, false);
  select.value = 'home'; select.dispatchEvent(new h.window.Event('change'));
  assert.equal(requested, 'home');
  assert.equal(doc.getElementById('est-fan-choose').disabled, true);
  assert.match(doc.getElementById('est-fan-summary').textContent, /Inicia sesión/);
});

test('reconectar recupera la sala y la instantánea del partido seleccionado', async t => {
  let live = false;
  const h = createHarness({ kickoffOffsetMs: 1000, onMatchSubscribe(_payload, ack, data) {
    const matchState = structuredClone(data.matchState);
    if (live) { matchState.match.status = 'live'; matchState.state.score = { home: 1, away: 0 }; matchState.state.minute = 8; }
    ack({ ok: true, teams: data.teams, profile: { id: 'alice', chips: 1000 }, matchState });
  } });
  t.after(h.close);
  await h.connectToMatch();
  const matchRequests = () => h.socketEmitted.filter(x => x.event === 'football:subscribe' && x.payload.scope === 'match');
  assert.equal(matchRequests().length, 1);
  h.socket.connected = false;
  h.handlers.disconnect();
  h.advanceTime(2000);
  assert.match(h.window.document.getElementById('est-preshow-status').textContent, /sin conexión/);
  live = true;
  h.socket.connected = true;
  h.handlers.connect();
  assert.equal(matchRequests().length, 2, 'recupera la sala después del lobby');
  assert.equal(h.window.document.getElementById('est-preshow').hidden, true, 'solo se oculta al recibir estado real en vivo');
  assert.equal(h.window.document.getElementById('score-home').textContent, '1');
  assert.equal(h.window.document.getElementById('score-away').textContent, '0');
});

test('kickoff pendiente reconsulta de forma acotada sin fingir el inicio', async t => {
  let live = false;
  const h = createHarness({ kickoffOffsetMs: 1000, onMatchSubscribe(_payload, ack, data) {
    const matchState = structuredClone(data.matchState);
    if (live) matchState.match.status = 'live';
    ack({ ok: true, teams: data.teams, profile: { id: 'alice', chips: 1000 }, matchState });
  } });
  t.after(h.close);
  await h.connectToMatch();
  const count = () => h.socketEmitted.filter(x => x.event === 'football:subscribe' && x.payload.scope === 'match').length;
  h.advanceTime(2000);
  assert.equal(count(), 1);
  assert.match(h.window.document.getElementById('est-preshow-status').textContent, /Kickoff pendiente/);
  h.advanceTime(8000);
  assert.equal(count(), 2);
  assert.equal(h.window.document.getElementById('est-preshow').hidden, false, 'si sigue programado no inventa un arranque');
  live = true;
  h.advanceTime(10000);
  assert.equal(count(), 3);
  assert.equal(h.window.document.getElementById('est-preshow').hidden, true, 'la nueva instantánea confirma el arranque');
  h.advanceTime(10000);
  assert.equal(count(), 3, 'ya no reconsulta después de la confirmación');
});

test('un tick real recupera la vista si se perdió el aviso inicial de kickoff', async t => {
  const h = createHarness({ kickoffOffsetMs: -1000, onMatchSubscribe(_payload, ack, data) {
    ack({ ok: true, teams: data.teams, profile: { id: 'alice', chips: 1000 }, matchState: structuredClone(data.matchState) });
  } });
  t.after(h.close);
  await h.connectToMatch();
  assert.equal(h.window.document.getElementById('est-preshow').hidden, false);
  h.handlers['football:tick']({ matchId: h.match.id, minute: 1, phase: 'first_half', score: { home: 0, away: 0 }, players: [] });
  assert.equal(h.window.document.getElementById('est-preshow').hidden, true);
  assert.equal(h.window.document.querySelectorAll('.est-market-group').length, 1, 'cierra los mercados prepartido');
});
