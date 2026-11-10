'use strict';

// Suite integral para:
// 1. Banners de club (`club-banner`) y Banner temporal de Campeón Vigente
//    (`champion-banner`) con regla de lealtad (`joinedAt <= settledAt`) y
//    expiración automática en cuanto aparece un nuevo campeón de liga.
// 2. Exposición y renderizado de pines + banners equipados en Perfil, Ficha de
//    mesa y Ranking del Mes (`profiles.top` + `#season-ranking`).
// 3. Ventana independiente de Preferencias (`#preferences-modal`), catálogo y
//    persistencia de teclas (`lib/keybindings.js`, `keybindings_update`), y
//    juego 100% por teclado/botones (empezar ronda, botón e ingreso numérico de
//    apuesta, duplicar y confirmar de inmediato, pedir, plantarse, doblar y dividir).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const fanClub = require('../lib/football/fan-club');
const {
  publicFanPin,
  publicFanBanner,
  publicFanBannersInventory,
  isBannerUnlocked,
  setReigningChampionResolver
} = require('../lib/football/fan-club-profile');
const { CLUBS } = require('../lib/football/teams');
const { generateCalendar } = require('../lib/football/fixtures');
const {
  KEYBINDING_DEFAULTS,
  cleanKeybindings,
  applyKeybindingChanges,
  normalizeKeyBinding
} = require('../lib/keybindings');
const { ProfileStore } = require('../lib/profile-store');
const { publicProgress } = require('../lib/progression');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CHAT = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat-format.js'), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function buildSettledLeague(seasonMonth, championClubId, settledAt) {
  const calendar = generateCalendar(seasonMonth, CLUBS);
  const league = {
    seasonMonth,
    config: CLUBS.map(c => ({ ...c })),
    calendar
  };
  let seq = 1;
  for (const match of league.calendar.matches) {
    if (match.desempate) continue;
    match.status = 'settled';
    match.settledAt = settledAt - 1000 + (seq++);
    if (match.homeId === championClubId) {
      match.result = { home: 2, away: 0 };
    } else if (match.awayId === championClubId) {
      match.result = { home: 0, away: 2 };
    } else {
      match.result = { home: 1, away: 1 };
    }
  }
  const lastRegular = league.calendar.matches.filter(m => !m.desempate).pop();
  if (lastRegular) lastRegular.settledAt = settledAt;
  return league;
}

test('Banners de club y Campeón Vigente: lealtad previa al título, visibilidad en Ranking del mes y expiración al coronarse nuevo campeón', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'banners-reign-'));
  t.after(() => {
    setReigningChampionResolver(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Verificamos que los dos fondos generados existen en public/assets/banners/
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'public', 'assets', 'banners', 'club-banner-bg.jpg')), true);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'public', 'assets', 'banners', 'champion-banner-bg.jpg')), true);

  const store = new ProfileStore(path.join(dir, 'profiles.json'));
  const loyal = store.getOrCreate('loyal-fan', 'Leal', 'fox');
  loyal.chips = 4200;
  const bandwagon = store.getOrCreate('late-fan', 'Tardío', 'owl');
  bandwagon.chips = 3100;

  // Leal se une en t=1000; la liga 2026-09 se liquida en t=5000 con united_vanguard campeón.
  assert.equal(fanClub.select(loyal, 'united_vanguard', null, false, 1000).ok, true);
  const octLeague = buildSettledLeague('2026-09', 'united_vanguard', 5000);
  const leagues = new Map([['2026-09', octLeague]]);
  let now = 6000;
  setReigningChampionResolver(() => fanClub.reigningLeagueChampion(leagues, now));

  fanClub.synchronizeProfile(loyal, leagues, now);
  // Tardío se une en t=5500 (DESPUÉS del título de t=5000).
  assert.equal(fanClub.select(bandwagon, 'united_vanguard', null, false, 5500).ok, true);
  fanClub.synchronizeProfile(bandwagon, leagues, now);

  const loyalSnap = fanClub.snapshot(loyal, store.profiles, leagues, now);
  const lateSnap = fanClub.snapshot(bandwagon, store.profiles, leagues, now);

  assert.equal(loyalSnap.banners.find(b => b.id === 'club-banner')?.unlocked, true);
  assert.equal(loyalSnap.banners.find(b => b.id === 'champion-banner')?.unlocked, true, 'hincha previo al título desbloquea el banner de campeón vigente');
  assert.equal(lateSnap.banners.find(b => b.id === 'club-banner')?.unlocked, true, 'hincha tardío sí tiene el banner normal del club');
  assert.equal(lateSnap.banners.find(b => b.id === 'champion-banner')?.unlocked, false, 'hincha tardío NO puede equipar el banner de campeón vigente');

  // Leal equipa pin y banner de campeón vigente; Tardío equipa banner normal del club.
  loyal.footballFanClub.equippedPin = 'fan-champ';
  loyal.footballFanClub.equippedBanner = 'champion-banner';
  bandwagon.footballFanClub.equippedBanner = 'club-banner';

  const loyalBanner = publicFanBanner(loyal);
  assert.equal(loyalBanner?.banner, 'champion-banner');
  assert.equal(loyalBanner?.isReigningChampion, true);
  assert.equal(loyalBanner?.seasonMonth, '2026-09');
  assert.equal(loyalBanner?.art, '/assets/banners/champion-banner-bg.jpg');

  // El Ranking del Mes expone pin y banner equipados.
  const topDuringReign = store.top(10);
  assert.equal(topDuringReign[0].name, 'Leal');
  assert.equal(topDuringReign[0].fanPin?.pin, 'fan-champ');
  assert.equal(topDuringReign[0].fanBanner?.banner, 'champion-banner');
  assert.equal(topDuringReign[1].name, 'Tardío');
  assert.equal(topDuringReign[1].fanBanner?.banner, 'club-banner');

  // Se liquida la siguiente liga (2026-10) en t=9000 con OTRO club campeón (vantora_fc).
  const novLeague = buildSettledLeague('2026-10', 'vantora_fc', 9000);
  leagues.set('2026-10', novLeague);
  now = 9500;

  // Sin intervención manual, el banner temporal de campeón vigente expira al instante,
  // mientras que el banner normal del club sigue activo.
  assert.equal(publicFanBanner(loyal), null, 'el banner de campeón vigente caduca al aparecer el nuevo campeón');
  assert.equal(publicFanPin(loyal)?.pin, 'fan-champ', 'la estrella conmemorativa de pin sí permanece');
  assert.equal(publicFanBanner(bandwagon)?.banner, 'club-banner', 'el banner normal del club no caduca');
  assert.equal(store.top(10)[0].fanBanner, null, 'el Ranking del mes deja de mostrar el banner de campeón caducado');

  // Al sincronizar el perfil, equippedBanner expirado se limpia también en persistencia.
  assert.equal(fanClub.synchronizeProfile(loyal, leagues, now), true);
  assert.equal(loyal.footballFanClub.equippedBanner, null);
  assert.equal(publicFanBannersInventory(loyal).items.find(b => b.id === 'champion-banner')?.unlocked, false);
});

test('Catálogo de controles de teclado: normaliza teclas, intercambia duplicados, protege 0–9 y restablece valores', () => {
  assert.equal(normalizeKeyBinding('5'), null, 'los números 0–9 están reservados para ingresar montos');
  assert.equal(normalizeKeyBinding('Escape'), null);
  assert.equal(normalizeKeyBinding('Tab'), null);
  assert.equal(normalizeKeyBinding('Space'), ' ');
  assert.equal(normalizeKeyBinding('J'), 'j');

  // Si asignamos 's' (que por defecto es bjStand) a bjHit ('h'), intercambian sus teclas sin dejar huecos.
  const swapped = applyKeybindingChanges(KEYBINDING_DEFAULTS, { bjHit: 's' });
  assert.equal(swapped.bjHit, 's');
  assert.equal(swapped.bjStand, 'h');
  assert.equal(new Set(Object.values(swapped)).size, Object.keys(KEYBINDING_DEFAULTS).length, 'todas las acciones conservan teclas únicas');

  const reset = applyKeybindingChanges(swapped, { reset: true });
  assert.deepEqual(reset, KEYBINDING_DEFAULTS);
  assert.deepEqual(cleanKeybindings({ hack: 'z', bjHit: '9' }), KEYBINDING_DEFAULTS);
});

test('UI Casino: ventana independiente de Preferencias, banners en Perfil y Ranking del mes, y juego completo desde teclado en Blackjack', async t => {
  const viewerProfile = {
    ...publicProgress({
      id: 'kb-user',
      username: 'teclado_pro',
      name: 'Valeria',
      avatar: 'crown',
      chips: 2000,
      championBanner: true,
      medals: 2,
      achievements: [],
      featuredAchievements: [],
      gamesPlayed: ['blackjack'],
      stats: { roundsPlayed: 8, wins: 5, losses: 3, biggestWin: 400, totalWagered: 1200, bestStreak: 3 },
      challenges: {},
      transactions: [],
      balanceHistory: [],
      preferences: { autoBots: true, botsStay: false, tableInvites: true },
      keybindings: { ...KEYBINDING_DEFAULTS },
      footballFanClub: {
        clubId: 'united_vanguard',
        joinedAt: 500,
        rankingOptIn: true,
        wins: 6,
        wonMatchIds: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'],
        championSeasons: ['2026-09'],
        equippedPin: 'fan-3',
        equippedTitle: 'title-leyenda',
        equippedBanner: null
      }
    }, true),
    fanBanners: {
      clubId: 'united_vanguard',
      clubName: 'Farselona FC',
      abbr: 'FAR',
      primary: '#a50044',
      secondary: '#004d98',
      equippedBanner: null,
      reigningSeasonMonth: '2026-09',
      reigningClubId: 'united_vanguard',
      reigningClubName: 'Farselona FC',
      items: [
        { id: 'club-banner', kind: 'club', limitedTime: false, art: '/assets/banners/club-banner-bg.jpg', crest: '/assets/escudos/FAR.svg', clubId: 'united_vanguard', clubName: 'Farselona FC', abbr: 'FAR', primary: '#a50044', secondary: '#004d98', title: 'Estandarte del club', subtitle: 'Seda oficial', seasonMonth: null, unlocked: true, equipped: false },
        { id: 'champion-banner', kind: 'reigning_champion', limitedTime: true, art: '/assets/banners/champion-banner-bg.jpg', crest: '/assets/escudos/FAR.svg', clubId: 'united_vanguard', clubName: 'Farselona FC', abbr: 'FAR', primary: '#a50044', secondary: '#004d98', title: 'Estandarte de Campeón Vigente', subtitle: 'Laureles de gala', seasonMonth: '2026-09', unlocked: true, equipped: false }
      ]
    }
  };

  const dom = new JSDOM(HTML, { url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  const { document } = window;
  window.localStorage.setItem('montecristo-tos', '2026-09-28');
  window.localStorage.setItem('montecristo-device', 'kb-device');
  window.localStorage.setItem('montecristo-account-session', JSON.stringify(viewerProfile));
  window.matchMedia = () => ({ matches: true, addListener() {}, addEventListener() {} });
  window.crypto.randomUUID = () => 'kb-uuid';
  window.fetch = async url => {
    const u = String(url);
    if (u.includes('/healthz')) return { ok: true, status: 200, json: async () => ({ accountSessionsEnabled: true, passportEnabled: false, football: { enabled: true } }) };
    if (u.includes('/api/auth/session')) return { ok: true, status: 200, json: async () => ({ ok: true, csrfToken: 'csrf', profile: viewerProfile }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const handlers = {};
  const emitted = [];
  const socket = {
    connected: true,
    io: { on() {} },
    on(ev, fn) { handlers[ev] = fn; },
    emit(ev, payload, ack) {
      emitted.push({ ev, payload });
      if (ev === 'fan_banner_equip' && typeof ack === 'function') {
        viewerProfile.fanBanner = payload.banner === 'champion-banner'
          ? { clubId: 'united_vanguard', clubName: 'Farselona FC', abbr: 'FAR', primary: '#a50044', secondary: '#004d98', banner: 'champion-banner', isReigningChampion: true, seasonMonth: '2026-09', art: '/assets/banners/champion-banner-bg.jpg', crest: '/assets/escudos/FAR.svg' }
          : null;
        viewerProfile.fanBanners.equippedBanner = payload.banner;
        viewerProfile.fanBanners.items = viewerProfile.fanBanners.items.map(it => ({ ...it, equipped: it.id === payload.banner }));
        return ack({ ok: true, profile: viewerProfile, fanBanner: viewerProfile.fanBanner });
      }
      if (ev === 'keybindings_update' && typeof ack === 'function') {
        viewerProfile.keybindings = applyKeybindingChanges(viewerProfile.keybindings, payload.keybindings);
        return ack({ ok: true, keybindings: viewerProfile.keybindings, profile: viewerProfile });
      }
      if (typeof ack === 'function') ack({ ok: true });
    },
    disconnect() {},
    connect() {}
  };
  window.io = () => socket;
  window.eval(CHAT);
  window.eval(CLIENT);
  handlers.connect?.();
  await wait(40);

  // 1. Preferencias está en su propia ventana modal independiente (#preferences-modal), fuera de #profile-modal.
  assert.equal(document.querySelector('#profile-modal #profile-section-preferences'), null, 'Preferencias ya no está incrustada dentro del modal de perfil');
  assert.ok(document.querySelector('#preferences-modal #profile-section-preferences'), 'Preferencias vive en su ventana propia');

  document.getElementById('nav-preferences-open').click();
  await wait(20);
  assert.equal(document.getElementById('preferences-modal').classList.contains('open'), true);

  // Reasignamos 'Pedir carta' (bjHit) a la tecla 'j' desde la ventana de Preferencias.
  document.querySelector('[data-rebind-action="bjHit"]').click();
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }));
  await wait(30);
  assert.equal(emitted.some(item => item.ev === 'keybindings_update' && item.payload?.keybindings?.bjHit === 'j'), true);
  document.querySelector('[data-close-preferences]').click();
  assert.equal(document.getElementById('preferences-modal').classList.contains('open'), false);

  // 2. Equipar el Banner de Campeón Vigente desde el Perfil y verlo en Ranking del mes.
  handlers.lobby_state?.({
    rooms: [],
    playersOnline: 2,
    season: {
      month: '2026-11',
      ranking: [{
        name: 'Valeria',
        avatar: 'crown',
        chips: 2000,
        wins: 5,
        medals: 2,
        championBanner: true,
        fanPin: { clubId: 'united_vanguard', clubName: 'Farselona FC', abbr: 'FAR', pin: 'fan-3', pinTitle: 'Afición de leyenda', pinBadge: '★', titleLabel: 'Leyenda de Farselona FC' },
        fanBanner: { clubId: 'united_vanguard', clubName: 'Farselona FC', abbr: 'FAR', primary: '#a50044', secondary: '#004d98', banner: 'champion-banner', isReigningChampion: true, seasonMonth: '2026-09', art: '/assets/banners/champion-banner-bg.jpg', crest: '/assets/escudos/FAR.svg' }
      }],
      previous: null
    }
  });
  assert.ok(document.querySelector('#ranking-feature .fan-banner-surface.is-champion'), 'el líder del Ranking del mes muestra su banner de campeón vigente');
  assert.ok(document.querySelector('#ranking-list .ranking-fan-banner-pill.is-champion'), 'la fila del Ranking del mes muestra la insignia del banner');
  assert.ok(document.querySelector('#ranking-list .fan-pin-fan-3'), 'la fila del Ranking del mes muestra el pin equipado');

  // Abrir perfil y equipar el banner de campeón vigente.
  document.getElementById('profile-card').click();
  await wait(35);
  const equipChampBtn = document.querySelector('[data-equip-fan-banner="champion-banner"]');
  assert.ok(equipChampBtn);
  equipChampBtn.click();
  await wait(35);
  assert.ok(document.querySelector('#profile-banner-backdrop .fan-banner-surface.is-champion'), 'la cabecera del perfil muestra el banner de campeón vigente');
  document.querySelector('[data-close-profile]').click();

  // 3. Juego 100% por teclado en una mesa de Blackjack:
  //    - ingresar apuesta con números (350) + Enter
  //    - duplicar apuesta y confirmar al instante (x)
  //    - empezar partida (Espacio)
  //    - pedir (j, nuestra tecla personalizada), plantarse (s), doblar (d), dividir (p)
  const sendRoomState = roomPatch => {
    handlers.room_state?.({
      code: 'BJ777',
      name: 'Mesa Teclado',
      game: 'blackjack',
      hostId: 'kb-user',
      viewerId: 'kb-user',
      viewerProfile,
      phase: 'betting',
      dealerHand: [],
      players: [{
        id: 'kb-user',
        name: 'Valeria',
        avatar: 'crown',
        chips: 2000,
        bet: 0,
        hand: [],
        isHost: true,
        connected: true,
        fanPin: viewerProfile.fanPin,
        fanBanner: viewerProfile.fanBanner
      }],
      spectators: [],
      messages: [],
      results: [],
      ...roomPatch
    });
  };

  sendRoomState({});
  assert.ok(document.querySelector('[data-focus-bet-input]'), 'existe botón para ingresar cantidad de apuesta');
  assert.ok(document.querySelector('[data-double-confirm-bet]'), 'existe botón para duplicar y confirmar al instante');

  // Al pulsar un dígito ('3'), se enfoca automáticamente la casilla de apuesta con '3'; completamos '350' y pulsamos Enter.
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: '3', bubbles: true, cancelable: true }));
  const bjInput = document.getElementById('blackjack-bet-amount');
  assert.equal(document.activeElement, bjInput);
  assert.equal(bjInput.value, '3');
  bjInput.value = '350';
  bjInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await wait(25);
  assert.equal(emitted.some(item => item.ev === 'blackjack_bet' && item.payload?.amount === 350), true, 'confirma apuesta personalizada con números + Enter');
  bjInput.blur();

  // En una nueva apuesta, pulsar 'x' (doubleAndConfirm) duplica los 350 -> 700 y confirma de inmediato.
  sendRoomState({});
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
  await wait(25);
  assert.equal(emitted.some(item => item.ev === 'blackjack_bet' && item.payload?.amount === 700), true, 'duplica la apuesta anterior y la confirma de inmediato con teclado');

  // Con apuesta confirmada, Espacio (startGame) reparte las cartas (blackjack_start).
  sendRoomState({
    players: [{ id: 'kb-user', name: 'Valeria', avatar: 'crown', chips: 1300, bet: 700, hand: [], isHost: true, connected: true }]
  });
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  await wait(20);
  assert.equal(emitted.some(item => item.ev === 'blackjack_start'), true, 'Espacio inicia/reparte el juego');

  // En fase playing con par de 8s, probamos Pedir ('j' reasignada), Plantarse ('s'), Doblar ('d') y Dividir ('p').
  sendRoomState({
    phase: 'playing',
    turnId: 'kb-user',
    dealerHand: ['AH', 'XX'],
    players: [{ id: 'kb-user', name: 'Valeria', avatar: 'crown', chips: 1300, bet: 700, hand: ['8S', '8D'], isHost: true, connected: true }]
  });
  for (const key of ['j', 's', 'd', 'p', 'i']) {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }
  await wait(25);
  for (const expectedEvent of ['blackjack_hit', 'blackjack_stand', 'blackjack_double', 'blackjack_split', 'blackjack_insurance']) {
    assert.equal(emitted.some(item => item.ev === expectedEvent), true, `atajo dispara ${expectedEvent}`);
  }
});

test('Persistencia y privacidad: keybindings y fanBanners son privados del dueño; fanBanner viaja en perfil público y ficha de mesa', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-persist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = new ProfileStore(path.join(dir, 'profiles.json'));
  const profile = store.getOrCreate('p-kb', 'Marco', 'wolf');
  fanClub.select(profile, 'vantora_fc', null, false, 2000);
  assert.equal(isBannerUnlocked('club-banner', profile.footballFanClub), true);
  profile.footballFanClub.equippedPin = 'club-pin';
  profile.footballFanClub.equippedBanner = 'club-banner';
  store.update(profile, { keybindings: { bjHit: 'j', doubleAndConfirm: 'z' } });
  store.saveNow();

  const reloaded = new ProfileStore(store.filePath);
  const loaded = reloaded.getProfile('p-kb');
  assert.equal(loaded.keybindings.bjHit, 'j');
  assert.equal(loaded.keybindings.doubleAndConfirm, 'z');
  assert.equal(loaded.footballFanClub.equippedBanner, 'club-banner');

  const priv = publicProgress(loaded, true);
  const pub = publicProgress(loaded, false);
  assert.equal(priv.keybindings.bjHit, 'j');
  assert.ok(Array.isArray(priv.fanBanners?.items));
  assert.equal(pub.keybindings, undefined, 'el perfil público no filtra la configuración de teclas');
  assert.equal(pub.fanBanners, undefined, 'el inventario privado de banners no viaja al público');
  assert.equal(pub.fanBanner?.banner, 'club-banner', 'el banner equipado sí viaja al público');

  const { tableProfileCard } = require('../lib/table-social');
  const card = tableProfileCard({
    target: loaded,
    viewer: null,
    state: null
  });
  assert.equal(card.profile.fanBanner?.banner, 'club-banner');
  assert.equal(card.profile.fanPin?.pin, 'club-pin');
});

