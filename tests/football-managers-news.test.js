'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FootballStore } = require('../lib/football-store');
const { createTeamLineup } = require('../lib/football/match-state');
const { publicTransfers, planTransfers } = require('../lib/football/transfers');
const { clubProfile } = require('../lib/football/club-profile');
const { resolveClubTactics, evaluateSeasonManagers } = require('../lib/football/managers');
const { buildClubNews } = require('../lib/football/club-news');
const { prepareMatchInputs } = require('../lib/football/v2/inputs');
const { createMatch } = require('../lib/football/v2/simulator');
const { generateReplay } = require('../lib/football/v2/adapter');

function withStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managers-news-'));
  const store = new FootballStore(path.join(dir, 'football.json'));
  t.after(() => {
    try { store.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

test('un DT con mal rendimiento es despedido al cerrar temporada y MonteCristo News anuncia la contratación del nuevo DT', t => {
  const store = withStore(t);
  const oct = store.generateSeason('2026-10');
  const crisisClub = oct.config.find(c => c.id === 'united_vanguard');
  const champClub = oct.config.find(c => c.id === 'vantora_fc');
  const oldManagerName = crisisClub.manager.name;

  // Asentamos toda la temporada 2026-10: Farselona FC pierde todos sus partidos; Real Mandril gana todos.
  let settledTime = Date.UTC(2026, 9, 2, 12);
  for (const m of oct.calendar.matches) {
    if (m.desempate) continue;
    settledTime += 3600_000;
    let score = { home: 1, away: 1 };
    if (m.homeId === champClub.id) score = { home: 3, away: 0 };
    else if (m.awayId === champClub.id) score = { home: 0, away: 3 };
    else if (m.homeId === crisisClub.id) score = { home: 0, away: 2 };
    else if (m.awayId === crisisClub.id) score = { home: 2, away: 0 };
    store.settleMatch(m.id, score, { now: settledTime, seasonMonth: '2026-10' });
  }
  store.closeSeason('2026-10');

  const evaluations = evaluateSeasonManagers(oct);
  const crisisEval = evaluations.find(r => r.clubId === crisisClub.id);
  assert.equal(crisisEval.poorPerformance, true);
  assert.equal(crisisEval.sacked, true, 'el peor DT es marcado para despido');

  const nov = store.generateSeason('2026-11');
  const updatedClub = nov.config.find(c => c.id === crisisClub.id);
  assert.notEqual(updatedClub.manager.name, oldManagerName, 'se contrata un nuevo DT para la nueva temporada');
  assert.equal(updatedClub.manager.previousManager.name, oldManagerName, 'queda registro del DT despedido');
  assert.equal(updatedClub.tactics.formation, updatedClub.manager.preferredFormation, 'el nuevo DT implanta su formación');

  // Ningún DT activo está duplicado entre los 16 clubes.
  assert.equal(new Set(nov.config.map(c => c.manager.id)).size, 16);

  // MonteCristo News anuncia el despido y la contratación desde el día 1 de la nueva temporada.
  const novStart = Date.UTC(2026, 10, 2, 18);
  const feed = publicTransfers(nov, novStart, { previousLeague: oct });
  assert.equal(feed.status, 'scheduled');
  const coachAnnouncement = feed.clubNews.find(item => item.type === 'coach_change' && item.clubId === crisisClub.id);
  assert.ok(coachAnnouncement, 'MonteCristo News incluye el anuncio de cambio de DT');
  assert.match(coachAnnouncement.headline, new RegExp(updatedClub.manager.name));
  assert.match(coachAnnouncement.spoken, new RegExp(oldManagerName));
  assert.match(coachAnnouncement.spoken, new RegExp(updatedClub.manager.name));

  const champAnnouncement = feed.clubNews.find(item => item.type === 'season_champion');
  assert.ok(champAnnouncement, 'MonteCristo News anuncia también al club campeón vigente');
  assert.equal(champAnnouncement.clubId, champClub.id);

  const dossier = clubProfile(store, crisisClub.id, novStart);
  assert.equal(dossier.manager.name, updatedClub.manager.name);
  assert.equal(dossier.manager.previousManager.name, oldManagerName);
});

test('el DT elige al mejor jugador disponible del plantel (incluso dorsal > 11) para el once titular', t => {
  const store = withStore(t);
  const league = store.generateSeason('2026-11');
  const club = league.config[0];
  const starterSt = club.squad.find(p => p.num === 9 && p.pos === 'ST');
  const reserveSt = club.squad.find(p => p.num === 17 && p.pos === 'ST');
  assert.ok(starterSt && reserveSt);

  // Bajamos al dorsal 9 y convertimos al dorsal 17 en figura indiscutible.
  starterSt.attrs = { ...starterSt.attrs, sho: 42, pac: 45, pas: 44 };
  reserveSt.attrs = { ...reserveSt.attrs, sho: 95, pac: 94, pas: 88 };
  club.tactics.formation = '4-2-3-1'; // un único puesto FW titular

  const lineup = createTeamLineup(club);
  const chosenReserve = lineup.players.find(p => p.id === reserveSt.id);
  const benchedNine = lineup.players.find(p => p.id === starterSt.id);
  assert.equal(chosenReserve.initialStatus, 'active', 'el DT alinea al mejor delantero aunque lleve el dorsal 17');
  assert.equal(benchedNine.initialStatus, 'bench');
});

test('una mala racha provoca cambio táctico de formación del DT, alerta de banquillo y publicación en MonteCristo News', t => {
  const store = withStore(t);
  const league = store.generateSeason('2026-11');
  const club = league.config.find(c => c.id === 'vantora_fc');
  const baseFormation = club.tactics.formation;
  const clubMatches = league.calendar.matches.filter(m => !m.desempate && (m.homeId === club.id || m.awayId === club.id)).slice(0, 3);

  let at = Date.UTC(2026, 10, 5, 12);
  for (const m of clubMatches) {
    at += 3600_000;
    const score = m.homeId === club.id ? { home: 0, away: 3 } : { home: 3, away: 0 };
    store.settleMatch(m.id, score, { now: at, seasonMonth: '2026-11' });
  }

  const resolved = resolveClubTactics(club, league, at + 1000);
  assert.equal(resolved.changed, true, 'el DT cambia la formación tras 3 goleadas en contra');
  assert.notEqual(resolved.formation, baseFormation);

  const nextMatch = league.calendar.matches.find(m => m.status === 'scheduled' && (m.homeId === club.id || m.awayId === club.id));
  const inputs = prepareMatchInputs({ league, match: nextMatch, asOf: at + 1000, seed: 42 });
  const side = nextMatch.homeId === club.id ? 'home' : 'away';
  assert.equal(inputs[side].formation, resolved.formation, 'la preparación V2 congela la nueva formación del DT');
  assert.equal(inputs[side].manager.name, club.manager.name);

  const news = buildClubNews({ league, at: at + 1000 });
  assert.ok(news.some(n => n.type === 'tactical_shift' && n.clubId === club.id), 'MonteCristo News publica el cambio de formación');
  assert.ok(news.some(n => n.type === 'coach_pressure' && n.clubId === club.id), 'MonteCristo News publica la alerta de banquillo en riesgo');
});

test('en partido V2 el DT realiza sustituciones con criterio táctico y puede cambiar la formación en el segundo tiempo', t => {
  const store = withStore(t);
  const league = store.generateSeason('2026-11');
  const match = league.calendar.matches[0];
  const baseInput = prepareMatchInputs({ league, match, asOf: Date.UTC(2026, 10, 1, 12), seed: 777 });

  // Forzamos una diferencia clara y dibujo 4-2-3-1 en el visitante para observar ajustes de banquillo y pizarra en vivo.
  let sawManagerSub = false;
  let sawInMatchFormationShift = false;
  for (let seed = 1; seed <= 24; seed++) {
    const input = JSON.parse(JSON.stringify(baseInput));
    input.seed = seed;
    input.home.ratings = { elo: 1680, att: 1.32, def: 0.75, gk: 1.2 };
    input.away.ratings = { elo: 1360, att: 0.78, def: 1.28, gk: 0.85 };
    const sim = createMatch(input);
    while (!sim.snapshot().ended) sim.step(2000);
    const subs = sim.eventsAfter(-1).filter(e => e.type === 'substitution');
    if (subs.some(e => e.managerName && e.coachReason)) sawManagerSub = true;
    if (subs.some(e => e.formation && e.previousFormation && e.formation !== e.previousFormation)) {
      sawInMatchFormationShift = true;
      const keyHex = String(seed).padStart(64, 'a');
      const replay = generateReplay(input, keyHex);
      assert.ok(replay.frameCount > 1000, 'el adaptador de replay codifica sin errores los cambios de formación en vivo');
      break;
    }
  }
  assert.equal(sawManagerSub, true, 'los cambios del simulador registran al DT y su motivo táctico');
  assert.equal(sawInMatchFormationShift, true, 'el DT ejecuta cambio de formación en vivo cuando el marcador lo exige');
});

test('los DT compran jugadores en el mercado manteniendo plantillas válidas a lo largo de cuatro temporadas seguidas', t => {
  const store = withStore(t);
  const months = ['2026-10', '2026-11', '2026-12', '2027-01'];
  for (const month of months) {
    const league = store.generateSeason(month);
    const plan = planTransfers(league);
    assert.ok(plan && plan.moves.length === 8, `plan válido en ${month}`);
    for (const move of plan.moves) {
      const buyer = league.config.find(c => c.id === move.toId);
      assert.equal(move.managerName, buyer.manager.name, 'cada compra está firmada por el DT del club comprador');
    }
    const published = publicTransfers(league, Date.parse(`${month}-20T18:00:00Z`));
    assert.equal(published.status, 'announced');
    for (const move of published.moves) {
      assert.ok(move.signingReason && move.signingReason.includes(move.managerName));
      assert.ok(move.tacticalNeed);
    }
    assert.equal(new Set(league.config.flatMap(c => c.squad.map(p => p.id))).size, 288);
    for (const club of league.config) {
      assert.equal(club.squad.length, 18);
      assert.ok(club.squad.filter(p => p.pos === 'GK').length >= 2);
      assert.ok(club.squad.filter(p => p.pos === 'CM').length >= 1);
      assert.ok(club.squad.filter(p => p.pos === 'ST').length >= 1);
    }
  }
});
