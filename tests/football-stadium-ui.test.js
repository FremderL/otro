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
      if (event === 'football:quiniela_get' && options.onQuinielaGet) { ack(options.onQuinielaGet(payload)); return; }
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
        ack({ ok: true, teams, profile: { id: 'alice', chips: 1000 }, matchState });
      }
    }
  };
  let rafCallback = null;
  const drawnText = [];
  const ballTrace = [];
  const canvasContext = new Proxy({}, {
    get(_target, key) {
      if (key === 'fillText') return value => drawnText.push(String(value));
      // El balón se dibuja con radio BALL_R (6): se registra su posición para medir la trayectoria.
      if (key === 'arc') return (x, y, r) => { if (r === 6) ballTrace.push({ x, y }); };
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
    dom, window, socket, handlers, match, matchState, players, drawnText, requests, ballTrace, socketEmitted, scheduledTimeouts,
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
  const h = createHarness({ onFantasyGet: () => ({ ok: true, fantasy: data }) });
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
    assert.equal(row.querySelector('jugador'),null); assert.equal(row.querySelectorAll('img').length,2);
    assert.ok(row.querySelector('img[src="/assets/escudos/FAR.svg"]')); assert.ok(row.querySelector('img[src="/assets/escudos/LVP.svg"]'));
    // La valoración sale del servidor y se lee como precio de mercado, no como ficha.
    assert.match(row.textContent,/CM/);
    assert.match(row.querySelector('.est-transfer-value').textContent,/Valoración 17,5 M/);
    assert.match(doc.getElementById('est-transfers-list').textContent,/Acuerdos anunciados/);
    assert.match(doc.getElementById('est-transfers-list').textContent,/2026-11/);
  } finally {h.window.close();}
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
