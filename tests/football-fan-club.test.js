'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fan = require('../lib/football/fan-club');
const { cleanProfile } = require('../lib/profile-store-shared');

const A = 'united_vanguard', B = 'sporting_almar';
const game = (id, at, home, away, score, extra = {}) => ({ id, status:'settled', settledAt:at, homeId:home, awayId:away, result:score, ...extra });
const leagues = new Map([
  ['2026-09', { calendar:{ matches:[game('old', 99, A, B, {home:1,away:0}), game('yes', 100, A, B, {home:2,away:0}), game('draw', 101, A, B, {home:1,away:1})] } }],
  ['2026-10', { calendar:{ matches:[game('away', 102, B, A, {home:0,away:1}), game('tiebreak', 103, A, B, {home:1,away:0}, {desempate:true}), game('future', 999, A, B, {home:1,away:0}), game('unsettled', 104, A, B, {home:1,away:0}, {status:'finished'})] } }]
]);

test('afición deriva victorias asentadas posteriores a la adhesión a través de temporadas', () => {
  const profile={ id:'private', chips:1000 };
  assert.equal(fan.select(profile, A, null, false, 100).ok, true);
  assert.equal(fan.victories(profile.footballFanClub, leagues, 200), 2);
  assert.deepEqual([0,1,3,5].map(fan.level), [0,1,2,3]);
  const view=fan.snapshot(profile,new Map([[profile.id,profile]]),leagues,200);
  assert.equal(view.level,1); assert.equal(view.wins,2); assert.equal(view.rewards[1].unlocked,true); assert.equal(profile.chips,1000);
  const restored = cleanProfile({ id:'private', name:'Nombre', footballFanClub:profile.footballFanClub });
  assert.equal(restored.footballFanClub.clubId,A);
});

test('cambiar exige confirmación, impide estados obsoletos y revoca progreso al regresar', () => {
  const profile={ id:'p', chips:77, footballFantasy:{ arbitrary:true } };
  fan.select(profile,A,null,false,100);
  profile.footballFanClub.rankingOptIn=true;
  assert.equal(fan.select(profile,B,A,false,200).code,'confirmation_required');
  assert.equal(profile.footballFanClub.clubId,A);
  assert.equal(fan.select(profile,B,null,true,200).code,'club_changed');
  assert.equal(fan.select(profile,B,A,true,200).ok,true);
  assert.equal(profile.footballFanClub.rankingOptIn,false);
  assert.equal(fan.select(profile,A,B,true,201).ok,true);
  assert.equal(fan.victories(profile.footballFanClub,leagues,500),0);
  assert.equal(profile.chips,77); assert.deepEqual(profile.footballFantasy,{arbitrary:true});
  assert.equal(fan.select(profile,'__proto__',A,true,202).code,'invalid_club');
});

test('clasificación opcional expone únicamente agregados por club y se puede revocar', () => {
  const alice={id:'secret-a',name:'Alice'}, bob={id:'secret-b',name:'Bob'};
  fan.select(alice,A,null,false,100); fan.select(bob,B,null,false,100);
  alice.footballFanClub.rankingOptIn=true;
  const people=new Map([[alice.id,alice],[bob.id,bob]]);
  const rows=fan.ranking(people,leagues,200);
  assert.deepEqual(rows,[{clubId:A,wins:2,participants:1,rank:1}]);
  assert.doesNotMatch(JSON.stringify(rows),/secret|Alice|Bob/);
  alice.footballFanClub.rankingOptIn=false;
  assert.deepEqual(fan.ranking(people,leagues,200),[]);
});

test('victorias conservadas tras archivar partidos, sin duplicarlas, y pérdida al cambiar', () => {
  const profile = { id:'p' }; fan.select(profile,A,null,false,100);
  const people = new Map([[profile.id,profile]]); let touched=0;
  fan.syncProfiles(people,leagues,200,()=>touched++);
  assert.equal(profile.footballFanClub.wins,2); assert.equal(touched,1);
  fan.syncProfiles(people,leagues,200,()=>touched++);
  assert.equal(profile.footballFanClub.wins,2); assert.equal(touched,1);
  const restored=cleanProfile({id:'p',footballFanClub:profile.footballFanClub});
  assert.equal(fan.victories(restored.footballFanClub,new Map(),1000),2);
  restored.footballFanClub.equippedPin='fan-1';
  assert.equal(require('../lib/football/fan-club-profile').publicFanPin(restored).clubId,A);
  fan.select(restored,B,A,true,1001);
  assert.equal(restored.footballFanClub.wins,0); assert.equal(restored.footballFanClub.equippedPin,null);
  assert.equal(require('../lib/football/fan-club-profile').publicFanPin(restored),null);
});

test('ficha de club separa historia ficticia, títulos verificados, plantilla y mercado publicado', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { FootballStore } = require('../lib/football-store');
  const { clubProfile } = require('../lib/football/club-profile');
  const { planTransfers } = require('../lib/football/transfers');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'club-dossier-'));
  const store = new FootballStore(path.join(dir, 'f.json'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const previous = store.generateSeason('2026-09');
  const move = planTransfers(previous).moves[0];
  // Campeonato inequívoco: gana todos sus partidos, el resto empata.
  for (const m of previous.calendar.matches) {
    m.status = 'settled'; m.settledAt = Date.UTC(2026, 8, 29);
    m.result = m.homeId === move.toId ? { home: 1, away: 0 } : m.awayId === move.toId ? { home: 0, away: 1 } : { home: 0, away: 0 };
  }
  const current = store.generateSeason('2026-10');
  const match = current.calendar.matches.find(m => m.homeId === move.toId || m.awayId === move.toId);
  match.status = 'settled'; match.settledAt = Date.UTC(2026, 9, 3);
  match.result = match.homeId === move.toId ? { home: 2, away: 0 } : { home: 0, away: 2 };
  const october10 = Date.UTC(2026, 9, 10, 12);
  const view = clubProfile(store, move.toId, october10);
  assert.ok(view.story && view.manager.name);
  assert.deepEqual(view.titles, ['2026-09']);
  assert.equal(view.record.wins, 1); assert.equal(view.record.goalsFor, 2);
  assert.equal(view.roster.players.length, 18);
  assert.ok(view.roster.players.some(p => p.id === move.playerId && p.name === move.playerName));
  assert.equal(view.lineup.filter(p => p.initialStatus === 'active').length, 11);
  assert.ok(view.transfers.some(m => m.playerId === move.playerId && m.status === 'effective'));
  assert.ok(!view.transfers.some(m => m.seasonMonth === '2026-10'), 'acuerdos todavía no anunciados permanecen privados');
  assert.equal(view.roster.missingMatches, 1, 'estadísticas no verificadas se marcan como parciales');
  const plan = planTransfers(current);
  const announced = clubProfile(store, plan.moves[0].fromId, Date.UTC(2026, 9, 16, 12));
  assert.ok(announced.transfers.some(m => m.seasonMonth === '2026-10' && m.status === 'announced'));
  previous.calendar.matches[0].settledAt = Date.UTC(2026, 10, 1);
  assert.deepEqual(clubProfile(store, move.toId, october10).titles, [], 'no se filtran resultados posteriores');
  assert.equal(clubProfile(store, '__proto__', october10), null);
});
