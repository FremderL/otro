'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const fanClub = require('../lib/football/fan-club');
const { publicFanPin } = require('../lib/football/fan-club-profile');
const { buildClubNews } = require('../lib/football/club-news');
const { CLUBS } = require('../lib/football/teams');
const { generateCalendar } = require('../lib/football/fixtures');
const { LoteriaService } = require('../lib/loteria/service');
const { recordOutcome, publicProgress } = require('../lib/progression');
const { ProfileStore } = require('../lib/profile-store');
const { createCommunityStore } = require('../lib/community-store');
const { installCommunityRoutes } = require('../lib/community-http');
const { csrfToken } = require('../lib/account-auth-http');

function buildCompletedChampionLeague(seasonMonth, championClubId, settledAt) {
  const calendar = generateCalendar(seasonMonth, CLUBS);
  const league = {
    seasonMonth,
    config: CLUBS.map(c => ({ ...c })),
    calendar
  };
  for (const match of league.calendar.matches) {
    match.status = 'settled';
    match.settledAt = settledAt;
    if (match.homeId === championClubId) {
      match.result = { home: 3, away: 0 };
    } else if (match.awayId === championClubId) {
      match.result = { home: 0, away: 3 };
    } else {
      match.result = { home: 1, away: 1 };
    }
  }
  return league;
}

test('Mi afición: niveles 0..5, títulos equipables, estrella de campeón causal, 0 fichas y MonteCristo News', () => {
  assert.deepEqual([0, 1, 3, 5, 10, 20].map(fanClub.level), [0, 1, 2, 3, 4, 5]);

  const champId = CLUBS[0].id;
  const otherId = CLUBS[1].id;
  const league = buildCompletedChampionLeague('2026-10', champId, 5000);
  const leagues = new Map([['2026-10', league]]);

  const loyalFan = { id: 'loyal-1', name: 'Hincha', chips: 1000, footballFanClub: null };
  const lateFan = { id: 'late-1', name: 'Tardío', chips: 1000, footballFanClub: null };

  // Loyal fan se une ANTES de liquidarse la liga (joinedAt = 1000 <= 5000).
  assert.equal(fanClub.select(loyalFan, champId, null, false, 1000).ok, true);
  // Late fan se une DESPUÉS de haberse cerrado esa liga (joinedAt = 6000 > 5000).
  assert.equal(fanClub.select(lateFan, champId, null, false, 6000).ok, true);

  loyalFan.footballFanClub.rankingOptIn = true;
  const profiles = new Map([[loyalFan.id, loyalFan], [lateFan.id, lateFan]]);
  fanClub.syncProfiles(profiles, leagues, 7000);

  const loyalView = fanClub.snapshot(loyalFan, profiles, leagues, 7000);
  assert.equal(loyalView.wins, 30, 'ganó los 30 partidos de la liga');
  assert.equal(loyalView.level, 5, 'alcanza el nivel máximo 5');
  assert.equal(loyalView.championships, 1, 'registra el campeonato vivido desde su adhesión');
  assert.deepEqual(loyalView.championSeasons, ['2026-10']);
  assert.equal(loyalFan.chips, 1000, 'Mi afición es 100 % cosmética: jamás altera fichas');

  const champReward = loyalView.rewards.find(r => r.id === 'fan-champ');
  assert.equal(champReward?.unlocked, true);
  const champTitle = loyalView.titles.find(t => t.id === 'title-campeon');
  assert.equal(champTitle?.unlocked, true);

  // Quien llegó después del cierre NO recibe retroactivamente el título pasado.
  const lateView = fanClub.snapshot(lateFan, profiles, leagues, 7000);
  assert.equal(lateView.championships, 0);
  assert.equal(lateView.rewards.find(r => r.id === 'fan-champ')?.unlocked, false);

  // Aunque se archive la liga antigua, championSeasons persiste en el perfil.
  loyalFan.footballFanClub.equippedPin = 'fan-champ';
  loyalFan.footballFanClub.equippedTitle = 'title-campeon';
  const afterArchive = fanClub.snapshot(loyalFan, profiles, new Map(), 8000);
  assert.equal(afterArchive.championships, 1);
  const pubPin = publicFanPin(loyalFan);
  assert.equal(pubPin.pin, 'fan-champ');
  assert.equal(pubPin.pinBadge, '🏆');
  assert.match(pubPin.titleLabel, /Campeón con /);

  // MonteCristo News narra tanto el pulso como la estrella en la grada sin datos personales.
  const fanRankWithMilestones = fanClub.ranking(profiles, leagues, 7000, undefined, { includeMilestones: true });
  const news = buildClubNews({ league, at: 7000, fanRanking: fanRankWithMilestones });
  const milestoneItem = news.find(item => item.type === 'fan_milestone');
  assert.ok(milestoneItem, 'MonteCristo News publica el hito fan_milestone');
  assert.equal(milestoneItem.clubId, champId);
  assert.match(milestoneItem.spoken, /estrella oficial de campeón/i);
  assert.equal(/loyal-1|Hincha/.test(JSON.stringify(news)), false, 'ningún dato personal se filtra a noticias');

  // Al cambiar de club con confirmación se reinician pines, títulos y campeonatos.
  assert.equal(fanClub.select(loyalFan, otherId, champId, true, 9000).ok, true);
  assert.equal(publicFanPin(loyalFan), null);
  assert.equal(fanClub.snapshot(loyalFan, profiles, new Map(), 9000).championships, 0);
});

test('Lotería expone y pinta el pin de Mi afición en la lista de participantes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loteria-fanpin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ProfileStore(path.join(dir, 'profiles.json'));
  store.persistProfile = async () => store.saveNow();
  const ana = store.getOrCreate('ana-lot', 'Ana', 'fox');
  ana.footballFanClub = {
    clubId: 'vantora_fc',
    joinedAt: 100,
    rankingOptIn: false,
    wins: 6,
    wonMatchIds: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'],
    championSeasons: [],
    equippedPin: 'fan-3',
    equippedTitle: 'title-leyenda'
  };
  store.saveNow();

  const service = new LoteriaService({
    profiles: store,
    statePath: path.join(dir, 'loteria.json'),
    now: () => 1000
  });
  await service.start();
  t.after(() => service.stop());

  const joined = await service.join(ana.id, { name: 'Ana', avatar: 'fox' });
  assert.equal(joined.ok, true);
  const snap = service.snapshotFor(ana.id);
  assert.equal(snap.game.players[0].fanPin?.pin, 'fan-3');
  assert.equal(snap.game.players[0].fanPin?.pinBadge, '★');

  // Renderizado JSDOM en public/loteria.js
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'loteria.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'loteria.js'), 'utf8');
  let connectHandler = null;
  let stateHandler = null;
  const dom = new JSDOM(html, {
    url: 'http://localhost:3000/loteria',
    runScripts: 'outside-only',
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      win.io = () => ({
        connected: true,
        on(ev, cb) {
          if (ev === 'connect') connectHandler = cb;
          if (ev === 'loteria_state') stateHandler = cb;
        },
        emit(ev, _payload, ack) {
          if (ev === 'loteria_subscribe' && typeof ack === 'function') {
            return ack({ ok: true, state: snap, you: service.youFor(ana.id) });
          }
          if (typeof ack === 'function') ack({ ok: true });
        }
      });
    }
  });
  t.after(() => dom.window.close());
  dom.window.eval(script);
  if (connectHandler) connectHandler();
  if (stateHandler) stateHandler(snap);
  const badgeImg = dom.window.document.querySelector('#loteria-players img.fan-pin-fan-3');
  assert.ok(badgeImg, 'la lista de jugadores de Lotería muestra el pin equipado con su nivel');
  assert.equal(dom.window.document.querySelector('#loteria-players .fan-pin-emblem')?.textContent, '★');
});

test('Clubes sociales: misiones cooperativas semanales, reparto equitativo, podio con trofeos permanentes, Salón de la Fama y privacidad', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clubs-full-suite-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pepper = Buffer.alloc(32, 21).toString('base64');
  const config = { accountSessionsEnabled: true, appOrigin: '', sessionPepper: pepper };

  const profiles = new ProfileStore(path.join(dir, 'profiles.json'));
  profiles.seasons.current = '2026-10';
  profiles.seasons.clubTreasury.seasonKey = '2026-10';

  const community = createCommunityStore(path.join(dir, 'community.json'), '');
  profiles.isEligibleForClubPodium = clubId => {
    const clubs = community.getState().clubs;
    return clubs.some(c => c.id === clubId && c.visibility === 'public');
  };
  profiles.onAfterSeasonReset = ({ fromMonth }) => {
    const publicById = new Map(community.getState().clubs.filter(c => c.visibility === 'public').map(c => [c.id, c]));
    const closed = (profiles.seasons.clubTreasury.history || []).find(h => h.seasonKey === fromMonth);
    if (!closed) return;
    closed.top.filter(item => publicById.has(item.clubId) && item.balance > 0).slice(0, 3).forEach((w, idx) => {
      const club = publicById.get(w.clubId);
      for (const m of club.members) {
        const p = profiles.getProfile(m.profileId);
        p.clubSeasonBadges = [...(p.clubSeasonBadges || []), { seasonKey: fromMonth, clubId: club.id, clubName: club.name, place: idx + 1 }];
      }
    });
  };

  function makeAccount(id, username, name) {
    const p = profiles.getOrCreate(id, name, 'fox');
    p.username = username;
    p.chips = 2000;
    return p;
  }
  const alice = makeAccount('alice-id', 'alice', 'Alicia');
  const bob = makeAccount('bob-id', 'bob', 'Roberto');
  const carol = makeAccount('carol-id', 'carol', 'Carolina');
  const dave = makeAccount('dave-id', 'dave', 'David');
  profiles.saveNow();

  const busyInTable = new Set();
  const app = express();
  installCommunityRoutes(app, {
    config,
    resolveSession: async req => {
      const profile = profiles.getProfile(req.get('x-test-profile'));
      return profile ? { profile, session: { id: `sess-${profile.id}` } } : null;
    },
    getProfiles: () => profiles,
    getCommunityStore: () => community,
    canMoveChips: id => !busyInTable.has(id)
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  config.appOrigin = `http://127.0.0.1:${server.address().port}`;

  async function api(route, { actor = alice.id, method = 'GET', body, idem } = {}) {
    const headers = { 'x-test-profile': actor, origin: config.appOrigin };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['x-csrf-token'] = csrfToken(`sess-${actor}`, pepper);
    if (idem) headers['idempotency-key'] = idem;
    const res = await fetch(`${config.appOrigin}${route}`, {
      method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    return { status: res.status, body: await res.json() };
  }

  // Rondas jugadas ANTES de entrar al club no deben contar.
  const beforeJoinMs = Date.now() - 60_000;
  for (let i = 0; i < 10; i++) {
    recordOutcome(alice, { game: 'poker', net: 20, eligible: true, at: beforeJoinMs });
  }
  // Fútbol tampoco cuenta (Decisión C6).
  recordOutcome(alice, { game: 'football', net: 50, eligible: false, at: Date.now() + 1000 });

  const clubRes = await api('/api/social/v1/clubs', {
    method: 'POST',
    body: { name: 'Círculo Esmeralda', visibility: 'public', emblem: 'crown', color: 'gold' }
  });
  assert.equal(clubRes.status, 201);
  const clubId = clubRes.body.club.id;

  await api(`/api/social/v1/clubs/${clubId}/join`, { actor: bob.id, method: 'POST' });
  await api(`/api/social/v1/clubs/${clubId}/join`, { actor: carol.id, method: 'POST' });

  // Verificar que las 10 rondas previas a fundar/unirse NO se contaron.
  let view = await api('/api/social/v1/clubs');
  let myClub = view.body.clubs.find(c => c.id === clubId);
  assert.equal(myClub.missions.summary.rounds, 0, 'rondas previas a joinedAt no cuentan');

  // Ahora Alice juega 4 rondas (4 juegos distintos) y Bob juega 2 rondas ganadas -> 6 rondas, 2 integrantes activos, 4 juegos!
  const afterJoinMs = Date.now() + 2000;
  for (const game of ['poker', 'blackjack', 'roulette', 'loteria']) {
    recordOutcome(alice, { game, net: 10, eligible: true, at: afterJoinMs });
  }
  recordOutcome(bob, { game: 'dice', net: 15, eligible: true, at: afterJoinMs });
  recordOutcome(bob, { game: 'slots', net: -5, eligible: true, at: afterJoinMs });

  view = await api('/api/social/v1/clubs');
  myClub = view.body.clubs.find(c => c.id === clubId);
  const varietyMission = myClub.missions.items.find(m => m.id === 'coop_variety');
  const teamworkMission = myClub.missions.items.find(m => m.id === 'coop_teamwork');
  assert.equal(varietyMission.completed, true);
  assert.equal(teamworkMission.completed, true);

  // Carol pertenece al club pero jugó 0 rondas: no puede parasitar la recompensa personal.
  const freeRide = await api(`/api/social/v1/clubs/${clubId}/missions/coop_variety/claim`, {
    actor: carol.id, method: 'POST', idem: 'claim-carol-variety-01'
  });
  assert.equal(freeRide.status, 409);
  assert.equal(freeRide.body.code, 'mission_contribution_required');

  // Alice reclama coop_variety: recibe +250 fichas personales Y el club recibe +350 fichas al fondo común.
  const chipsBefore = alice.chips;
  const aliceClaim = await api(`/api/social/v1/clubs/${clubId}/missions/coop_variety/claim`, {
    actor: alice.id, method: 'POST', idem: 'claim-alice-variety-01'
  });
  assert.equal(aliceClaim.status, 200);
  assert.equal(aliceClaim.body.personalReward, 250);
  assert.equal(aliceClaim.body.treasuryCreditedNow, true);
  assert.equal(aliceClaim.body.balance, 350);
  assert.equal(alice.chips, chipsBefore + 250);

  // Idempotencia exacta al reintentar con la misma clave.
  const replayClaim = await api(`/api/social/v1/clubs/${clubId}/missions/coop_variety/claim`, {
    actor: alice.id, method: 'POST', idem: 'claim-alice-variety-01'
  });
  assert.equal(replayClaim.status, 200);
  assert.equal(replayClaim.body.duplicate, true);
  assert.equal(alice.chips, chipsBefore + 250);

  // Bob también aportó rondas: recibe sus +250 personales, pero el bono al fondo NO se duplica.
  const bobBefore = bob.chips;
  const bobClaim = await api(`/api/social/v1/clubs/${clubId}/missions/coop_variety/claim`, {
    actor: bob.id, method: 'POST', idem: 'claim-bob-variety-01'
  });
  assert.equal(bobClaim.status, 200);
  assert.equal(bobClaim.body.treasuryCreditedNow, false);
  assert.equal(bobClaim.body.balance, 350);
  assert.equal(bob.chips, bobBefore + 250);

  // Antifarmeo multiclub: si Alice entra a un segundo club que completa coop_variety, no puede cobrarla otra vez la misma semana.
  const secondClubRes = await api('/api/social/v1/clubs', {
    actor: dave.id, method: 'POST', body: { name: 'Segundo Puerto', visibility: 'public', emblem: 'spade', color: 'ocean' }
  });
  const secondClubId = secondClubRes.body.club.id;
  await api(`/api/social/v1/clubs/${secondClubId}/join`, { actor: alice.id, method: 'POST' });
  const laterMs = Date.now() + 5000;
  for (const game of ['poker', 'blackjack', 'roulette', 'fortune']) {
    recordOutcome(alice, { game, net: 5, eligible: true, at: laterMs });
  }
  const secondClaimAttempt = await api(`/api/social/v1/clubs/${secondClubId}/missions/coop_variety/claim`, {
    actor: alice.id, method: 'POST', idem: 'claim-alice-second-club-01'
  });
  assert.equal(secondClaimAttempt.status, 409);
  assert.equal(secondClaimAttempt.body.code, 'mission_already_claimed');

  // Reparto equitativo: no líder recibe 403; con Carol en mesa activa se reparte entre Alice y Bob y sobrante queda en tesorería.
  const nonOwnerSplit = await api(`/api/social/v1/clubs/${clubId}/distribute-equal`, {
    actor: bob.id, method: 'POST', body: { amount: 100 }, idem: 'split-nonowner-01'
  });
  assert.equal(nonOwnerSplit.status, 403);

  busyInTable.add(carol.id); // Carol está jugando una mano: se omite sin bloquear a los otros 2 integrantes
  const alicePreSplit = alice.chips;
  const bobPreSplit = bob.chips;
  const splitRes = await api(`/api/social/v1/clubs/${clubId}/distribute-equal`, {
    actor: alice.id, method: 'POST', body: { amount: 101, note: 'Premio semanal' }, idem: 'split-owner-01'
  });
  busyInTable.delete(carol.id);
  assert.equal(splitRes.status, 200);
  assert.equal(splitRes.body.recipientCount, 2);
  assert.equal(splitRes.body.skippedCount, 1);
  assert.equal(splitRes.body.perMember, 50);
  assert.equal(splitRes.body.distributedTotal, 100);
  assert.equal(splitRes.body.remainderKept, 1);
  assert.equal(splitRes.body.balance, 250, '350 - 100 distribuidas = 250 restantes en el fondo');
  assert.equal(alice.chips, alicePreSplit + 50);
  assert.equal(bob.chips, bobPreSplit + 50);

  // Privacidad y cierre de temporada: un club privado con 900 fichas NO roba el oro público ni sale en el Salón de la Fama.
  const privRes = await api('/api/social/v1/clubs', {
    actor: carol.id, method: 'POST', body: { name: 'Logia Secreta', visibility: 'private', emblem: 'moon', color: 'violet' }
  });
  const privId = privRes.body.club.id;
  await api(`/api/social/v1/clubs/${privId}/deposits`, {
    actor: carol.id, method: 'POST', body: { amount: 900 }, idem: 'priv-dep-01'
  });
  await api(`/api/social/v1/clubs/${secondClubId}/deposits`, {
    actor: dave.id, method: 'POST', body: { amount: 120 }, idem: 'dave-dep-01'
  });

  const activeSeasonBeforeClose = profiles.seasons.current;
  // Cierre mensual hacia el mes siguiente
  const [yr, mo] = activeSeasonBeforeClose.split('-').map(Number);
  const nextYear = mo === 12 ? yr + 1 : yr;
  const nextMonth = mo === 12 ? 1 : mo + 1;
  const closed = profiles.ensureSeason(new Date(`${nextYear}-${String(nextMonth).padStart(2, '0')}-02T15:00:00Z`));
  assert.equal(closed?.type, 'closed');

  // Todas las tesorerías vuelven a 0 al arrancar el nuevo mes.
  assert.equal(profiles.getClubTreasuryBalance(clubId), 0);
  assert.equal(profiles.getClubTreasuryBalance(secondClubId), 0);
  assert.equal(profiles.getClubTreasuryBalance(privId), 0);

  // Círculo Esmeralda ganó el Oro público (#1) y Segundo Puerto la Plata (#2); el privado no ganó trofeo público.
  assert.equal(profiles.getClubTrophies(clubId).gold, 1);
  assert.equal(profiles.getClubTrophies(secondClubId).silver, 1);
  assert.equal(profiles.getClubTrophies(privId).total, 0);

  // Integrantes de los clubes en podio recibieron su insignia conmemorativa en el perfil privado.
  // Alice integraba tanto Círculo Esmeralda (#1) como Segundo Puerto (#2); Bob solo Círculo Esmeralda (#1).
  const aliceProgress = publicProgress(alice, true);
  assert.deepEqual(aliceProgress.clubSeasonBadges.map(b => b.place), [1, 2]);
  assert.equal(publicProgress(bob, true).clubSeasonBadges.length, 1);
  assert.equal(publicProgress(bob, true).clubSeasonBadges[0].place, 1);
  assert.equal('clubSeasonBadges' in publicProgress(alice, false), false, 'no se expone en perfil público ajeno');

  // El endpoint de ranking incluye Salón de la Fama solo con clubes públicos.
  const rankRes = await api('/api/social/v1/clubs/ranking', { actor: dave.id });
  assert.equal(rankRes.status, 200);
  assert.equal(rankRes.body.hallOfFame.length, 1);
  assert.equal(rankRes.body.hallOfFame[0].seasonKey, activeSeasonBeforeClose);
  assert.deepEqual(
    rankRes.body.hallOfFame[0].podium.map(p => p.name),
    ['Círculo Esmeralda', 'Segundo Puerto'],
    'el club privado nunca aparece en el Salón de la Fama'
  );
});
