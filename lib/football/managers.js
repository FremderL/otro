'use strict';

// Directores técnicos (DT) de los 16 clubes del Estadio MonteCristo.
//
// Cada DT posee identidad propia y dirige cuatro decisiones reales del club:
//   1. Selección del once titular entre los 18 futbolistas según encaje táctico.
//   2. Formación activa y cambio táctico de dibujo ante malas rachas o en vivo.
//   3. Gestión de cambios en el segundo tiempo (ventana, marcador y amarillas).
//   4. Prioridad de compra en el mercado de traspasos según carencias del plantel.
//
// Al cerrar una temporada con mal rendimiento verificado, el club despide al DT
// y contrata de forma determinista a un nuevo entrenador libre para la nueva
// temporada, anunciándolo en MonteCristo News.

const { hash32, mulberry32 } = require('./prng');

const VALID_FORMATIONS = ['4-3-3', '4-4-2', '4-2-3-1', '3-5-2'];
const VALID_STYLES = ['possession', 'pressing', 'direct', 'counter', 'balanced'];
const MAX_SACKINGS_PER_SEASON = 4;
const MIN_MATCHES_FOR_SACKING = 5;
const MIN_MATCHES_FOR_PRESSURE = 3;

const POS_GROUP = {
  GK: 'GK',
  CB: 'DF', LB: 'DF', RB: 'DF', LWB: 'DF', RWB: 'DF',
  CDM: 'MF', CM: 'MF', CAM: 'MF', LM: 'MF', RM: 'MF',
  LW: 'FW', RW: 'FW', ST: 'FW', CF: 'FW'
};

// Cuerpo técnico inaugural de los 16 clubes (mantiene continuidad con la historia editorial).
const INAUGURAL_MANAGERS = Object.freeze({
  vantora_fc:        { id: 'mgr_valera',   name: 'Camilo Valera',  preferredFormation: '4-3-3',   secondaryFormation: '4-2-3-1', style: 'possession', subProfile: 'proactivo',   marketFocus: 'creacion'   },
  united_vanguard:   { id: 'mgr_alcazar',  name: 'Bruno Alcázar',  preferredFormation: '4-4-2',   secondaryFormation: '4-3-3',   style: 'pressing',   subProfile: 'proactivo',   marketFocus: 'ataque'     },
  olympique_estevin: { id: 'mgr_vidal',    name: 'Lucien Vidal',   preferredFormation: '4-2-3-1', secondaryFormation: '3-5-2',   style: 'possession', subProfile: 'equilibrado', marketFocus: 'creacion'   },
  atletico_solaris:  { id: 'mgr_solis',    name: 'Mateo Solís',    preferredFormation: '4-3-3',   secondaryFormation: '4-4-2',   style: 'direct',     subProfile: 'proactivo',   marketFocus: 'ataque'     },
  sporting_almar:    { id: 'mgr_salcedo',  name: 'Marina Salcedo', preferredFormation: '4-4-2',   secondaryFormation: '4-2-3-1', style: 'balanced',   subProfile: 'equilibrado', marketFocus: 'equilibrio' },
  dynamo_kelvar:     { id: 'mgr_mena',     name: 'Héctor Mena',    preferredFormation: '3-5-2',   secondaryFormation: '4-4-2',   style: 'pressing',   subProfile: 'proactivo',   marketFocus: 'solidez'    },
  cs_verdania:       { id: 'mgr_beltran',  name: 'Nora Beltrán',   preferredFormation: '4-2-3-1', secondaryFormation: '4-4-2',   style: 'counter',    subProfile: 'conservador', marketFocus: 'solidez'    },
  halcyon_bay_fc:    { id: 'mgr_faro',     name: 'Iván Faro',      preferredFormation: '4-3-3',   secondaryFormation: '4-2-3-1', style: 'counter',    subProfile: 'proactivo',   marketFocus: 'ataque'     },
  athletic_ferrata:  { id: 'mgr_forja',    name: 'Renato Forja',   preferredFormation: '4-4-2',   secondaryFormation: '3-5-2',   style: 'direct',     subProfile: 'conservador', marketFocus: 'solidez'    },
  royal_corvane:     { id: 'mgr_corona',   name: 'Émile Corona',   preferredFormation: '4-2-3-1', secondaryFormation: '4-3-3',   style: 'possession', subProfile: 'equilibrado', marketFocus: 'creacion'   },
  sv_talbruck:       { id: 'mgr_vogel',    name: 'Greta Vogel',    preferredFormation: '3-5-2',   secondaryFormation: '4-2-3-1', style: 'balanced',   subProfile: 'conservador', marketFocus: 'solidez'    },
  velmar_harbour_fc: { id: 'mgr_marino',   name: 'Luca Marino',    preferredFormation: '4-4-2',   secondaryFormation: '4-2-3-1', style: 'direct',     subProfile: 'equilibrado', marketFocus: 'ataque'     },
  norvela_sporting:  { id: 'mgr_rojas',    name: 'Amelia Rojas',   preferredFormation: '4-3-3',   secondaryFormation: '4-4-2',   style: 'balanced',   subProfile: 'equilibrado', marketFocus: 'equilibrio' },
  ironvale_fc:       { id: 'mgr_neri',     name: 'Darío Neri',     preferredFormation: '4-4-2',   secondaryFormation: '3-5-2',   style: 'pressing',   subProfile: 'proactivo',   marketFocus: 'solidez'    },
  peregrine_rovers:  { id: 'mgr_ocampo',   name: 'Celia Ocampo',   preferredFormation: '4-2-3-1', secondaryFormation: '4-3-3',   style: 'counter',    subProfile: 'conservador', marketFocus: 'equilibrio' },
  puerto_ambar:      { id: 'mgr_paredes',  name: 'Ámbar Paredes',  preferredFormation: '4-3-3',   secondaryFormation: '4-2-3-1', style: 'possession', subProfile: 'proactivo',   marketFocus: 'creacion'   }
});

// Bolsa curada de entrenadores disponibles para relevar banquillos tras un despido.
const FREE_AGENT_COACHES = Object.freeze([
  { id: 'mgr_mendoza',   name: 'Gael Mendoza',       preferredFormation: '4-3-3',   secondaryFormation: '4-2-3-1', style: 'pressing',   subProfile: 'proactivo',   marketFocus: 'ataque'     },
  { id: 'mgr_krone',     name: 'Valeria Krone',      preferredFormation: '4-2-3-1', secondaryFormation: '3-5-2',   style: 'balanced',   subProfile: 'equilibrado', marketFocus: 'solidez'    },
  { id: 'mgr_rizzo',     name: 'Sebastián Rizzo',    preferredFormation: '3-5-2',   secondaryFormation: '4-4-2',   style: 'counter',    subProfile: 'conservador', marketFocus: 'solidez'    },
  { id: 'mgr_lindqvist', name: 'Clara Lindqvist',    preferredFormation: '4-3-3',   secondaryFormation: '4-4-2',   style: 'possession', subProfile: 'proactivo',   marketFocus: 'creacion'   },
  { id: 'mgr_halcon',    name: 'Tomás Halcón',       preferredFormation: '4-4-2',   secondaryFormation: '4-3-3',   style: 'direct',     subProfile: 'proactivo',   marketFocus: 'ataque'     },
  { id: 'mgr_varga',     name: 'Helena Varga',       preferredFormation: '4-2-3-1', secondaryFormation: '4-4-2',   style: 'pressing',   subProfile: 'equilibrado', marketFocus: 'equilibrio' },
  { id: 'mgr_sforza',    name: 'Rodrigo Sforza',     preferredFormation: '3-5-2',   secondaryFormation: '4-2-3-1', style: 'possession', subProfile: 'conservador', marketFocus: 'creacion'   },
  { id: 'mgr_kovacs',    name: 'Nadia Kovács',       preferredFormation: '4-3-3',   secondaryFormation: '4-2-3-1', style: 'counter',    subProfile: 'proactivo',   marketFocus: 'ataque'     },
  { id: 'mgr_albornoz',  name: 'Martín Albornoz',    preferredFormation: '4-4-2',   secondaryFormation: '3-5-2',   style: 'balanced',   subProfile: 'conservador', marketFocus: 'solidez'    },
  { id: 'mgr_delacroix', name: 'Sofía Delacroix',    preferredFormation: '4-2-3-1', secondaryFormation: '4-3-3',   style: 'possession', subProfile: 'equilibrado', marketFocus: 'creacion'   },
  { id: 'mgr_ferreira',  name: 'Julián Ferreira',    preferredFormation: '4-3-3',   secondaryFormation: '4-4-2',   style: 'pressing',   subProfile: 'proactivo',   marketFocus: 'ataque'     },
  { id: 'mgr_lindholm',  name: 'Astrid Lindholm',    preferredFormation: '4-4-2',   secondaryFormation: '4-2-3-1', style: 'counter',    subProfile: 'equilibrado', marketFocus: 'solidez'    },
  { id: 'mgr_cifuentes', name: 'Esteban Cifuentes',  preferredFormation: '3-5-2',   secondaryFormation: '4-4-2',   style: 'direct',     subProfile: 'proactivo',   marketFocus: 'equilibrio' },
  { id: 'mgr_bellini',   name: 'Renata Bellini',     preferredFormation: '4-2-3-1', secondaryFormation: '3-5-2',   style: 'balanced',   subProfile: 'conservador', marketFocus: 'solidez'    },
  { id: 'mgr_montalvo',  name: 'Óscar Montalvo',     preferredFormation: '4-3-3',   secondaryFormation: '4-2-3-1', style: 'direct',     subProfile: 'proactivo',   marketFocus: 'ataque'     },
  { id: 'mgr_solberg',   name: 'Íngrid Solberg',     preferredFormation: '4-4-2',   secondaryFormation: '4-3-3',   style: 'pressing',   subProfile: 'equilibrado', marketFocus: 'equilibrio' },
  { id: 'mgr_quiroga',   name: 'Damián Quiroga',     preferredFormation: '3-5-2',   secondaryFormation: '4-2-3-1', style: 'counter',    subProfile: 'conservador', marketFocus: 'solidez'    },
  { id: 'mgr_castell',   name: 'Beatriz Castell',    preferredFormation: '4-3-3',   secondaryFormation: '4-4-2',   style: 'possession', subProfile: 'proactivo',   marketFocus: 'creacion'   },
  { id: 'mgr_vermeer',   name: 'Nicolás Vermeer',    preferredFormation: '4-2-3-1', secondaryFormation: '4-3-3',   style: 'pressing',   subProfile: 'proactivo',   marketFocus: 'ataque'     },
  { id: 'mgr_santoro',   name: 'Lucía Santoro',      preferredFormation: '4-4-2',   secondaryFormation: '4-2-3-1', style: 'balanced',   subProfile: 'equilibrado', marketFocus: 'equilibrio' }
]);

const ALL_COACHES = Object.freeze([...Object.values(INAUGURAL_MANAGERS), ...FREE_AGENT_COACHES]);
const COACH_BY_ID = Object.freeze(Object.fromEntries(ALL_COACHES.map(c => [c.id, c])));

function normalizeFormation(formation, fallback = '4-4-2') {
  return VALID_FORMATIONS.includes(formation) ? formation : fallback;
}

function normalizeStyle(style, fallback = 'balanced') {
  return VALID_STYLES.includes(style) ? style : fallback;
}

function buildInitialManager(clubId, tactics = null, appointedSeason = null) {
  const base = INAUGURAL_MANAGERS[clubId] || {
    id: `mgr_${String(clubId || 'club')}`,
    name: 'Dirección Técnica',
    preferredFormation: normalizeFormation(tactics?.formation),
    secondaryFormation: normalizeFormation(tactics?.formation) === '4-4-2' ? '4-2-3-1' : '4-4-2',
    style: normalizeStyle(tactics?.style),
    subProfile: 'equilibrado',
    marketFocus: 'equilibrio'
  };
  return {
    id: base.id,
    name: base.name,
    preferredFormation: normalizeFormation(tactics?.formation || base.preferredFormation),
    secondaryFormation: normalizeFormation(base.secondaryFormation, '4-2-3-1'),
    style: normalizeStyle(tactics?.style || base.style),
    subProfile: base.subProfile,
    marketFocus: base.marketFocus,
    appointedSeason: typeof appointedSeason === 'string' && appointedSeason ? appointedSeason : null,
    tenureSeasons: 1,
    previousManager: null
  };
}

function cleanManager(raw, clubId, tactics = null, seasonMonth = null) {
  const fallback = buildInitialManager(clubId, tactics, seasonMonth);
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !raw.name.trim()) return fallback;
  const known = typeof raw.id === 'string' && COACH_BY_ID[raw.id] ? COACH_BY_ID[raw.id] : null;
  const preferredFormation = normalizeFormation(raw.preferredFormation || raw.formation || known?.preferredFormation || fallback.preferredFormation);
  const defaultSecondary = preferredFormation === '4-2-3-1' ? '4-4-2' : '4-2-3-1';
  const secondaryRaw = normalizeFormation(raw.secondaryFormation || known?.secondaryFormation || fallback.secondaryFormation, defaultSecondary);
  const secondaryFormation = secondaryRaw === preferredFormation ? defaultSecondary : secondaryRaw;
  const prev = raw.previousManager && typeof raw.previousManager === 'object' && typeof raw.previousManager.name === 'string'
    ? {
      id: String(raw.previousManager.id || ''),
      name: String(raw.previousManager.name).slice(0, 80),
      sackedAfterSeason: raw.previousManager.sackedAfterSeason ? String(raw.previousManager.sackedAfterSeason) : null,
      reason: raw.previousManager.reason ? String(raw.previousManager.reason).slice(0, 220) : '',
      record: raw.previousManager.record && typeof raw.previousManager.record === 'object'
        ? {
          rank: Number(raw.previousManager.record.rank) || null,
          played: Number(raw.previousManager.record.played) || 0,
          wins: Number(raw.previousManager.record.wins) || 0,
          draws: Number(raw.previousManager.record.draws) || 0,
          losses: Number(raw.previousManager.record.losses) || 0,
          points: Number(raw.previousManager.record.points) || 0,
          goalsFor: Number(raw.previousManager.record.goalsFor) || 0,
          goalsAgainst: Number(raw.previousManager.record.goalsAgainst) || 0
        }
        : null
    }
    : null;
  return {
    id: String(raw.id || known?.id || fallback.id).slice(0, 60),
    name: String(raw.name).trim().slice(0, 80),
    preferredFormation,
    secondaryFormation,
    style: normalizeStyle(raw.style || known?.style || fallback.style),
    subProfile: ['proactivo', 'equilibrado', 'conservador'].includes(raw.subProfile) ? raw.subProfile : (known?.subProfile || fallback.subProfile),
    marketFocus: ['ataque', 'creacion', 'solidez', 'equilibrio'].includes(raw.marketFocus) ? raw.marketFocus : (known?.marketFocus || fallback.marketFocus),
    appointedSeason: typeof raw.appointedSeason === 'string' && raw.appointedSeason ? raw.appointedSeason : (seasonMonth || fallback.appointedSeason),
    tenureSeasons: Number.isInteger(raw.tenureSeasons) && raw.tenureSeasons >= 1 ? raw.tenureSeasons : 1,
    previousManager: prev
  };
}

function ensureClubManagers(clubs, seasonMonth = null) {
  if (!Array.isArray(clubs)) return clubs;
  for (const club of clubs) {
    if (!club || typeof club !== 'object') continue;
    club.manager = cleanManager(club.manager, club.id, club.tactics, seasonMonth);
    if (club.tactics && typeof club.tactics === 'object') {
      club.tactics.formation = normalizeFormation(club.tactics.formation || club.manager.preferredFormation);
      club.tactics.style = normalizeStyle(club.tactics.style || club.manager.style);
    }
  }
  return clubs;
}

function managerOfClub(club, seasonMonth = null) {
  if (!club || typeof club !== 'object') return buildInitialManager('club', null, seasonMonth);
  return cleanManager(club.manager, club.id, club.tactics, seasonMonth);
}

// --- 1. Elección del once titular por el DT ---

function attr(player, key, fallback = 55) {
  const value = Number(player?.attrs?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

// Puntúa qué tan idóneo es un jugador del plantel para un rol titular según la
// pizarra, el estilo y el foco competitivo del DT.
function scoreStarterForCoach(player, slotRole, manager = null, styleOverride = null) {
  if (!player || !player.attrs) return 0;
  const style = normalizeStyle(styleOverride || manager?.style);
  const focus = manager?.marketFocus || 'equilibrio';
  const pac = attr(player, 'pac'), sho = attr(player, 'sho'), pas = attr(player, 'pas');
  const def = attr(player, 'def'), gk = attr(player, 'gk'), agr = attr(player, 'agr', 60);

  let base = 0;
  if (slotRole === 'GK') base = gk * 0.78 + def * 0.12 + pas * 0.10;
  else if (slotRole === 'DF') base = def * 0.56 + pac * 0.20 + pas * 0.15 + (100 - agr) * 0.09;
  else if (slotRole === 'MF') {
    const camBonus = player.pos === 'CAM' ? sho * 0.06 : player.pos === 'CDM' ? def * 0.06 : 0;
    base = pas * 0.46 + pac * 0.18 + def * 0.18 + sho * 0.18 + camBonus;
  } else {
    base = sho * 0.54 + pac * 0.28 + pas * 0.18;
  }

  let tacticalBias = 0;
  if (slotRole !== 'GK') {
    if (style === 'possession') tacticalBias += pas * 0.08;
    else if (style === 'pressing') tacticalBias += (pac + def) * 0.045;
    else if (style === 'direct') tacticalBias += (sho + pac) * 0.045;
    else if (style === 'counter') tacticalBias += pac * 0.07 + def * 0.025;
    else tacticalBias += (pas + def + sho) * 0.025;

    if (focus === 'ataque') tacticalBias += sho * 0.06 + pac * 0.03;
    else if (focus === 'creacion') tacticalBias += pas * 0.07;
    else if (focus === 'solidez') tacticalBias += def * 0.07 + (100 - agr) * 0.02;
    else tacticalBias += (pas + def + sho) * 0.025;
  }

  const goals = Math.min(10, Math.max(0, Number(player.season?.goals) || 0));
  const assists = Math.min(10, Math.max(0, Number(player.season?.assists) || 0));
  const formBonus = slotRole === 'GK' ? 0 : goals * 0.35 + assists * 0.2;
  return base + tacticalBias + formBonus;
}

// --- 2. Evaluación causal de racha y ajuste táctico de formación ---

function settledRegularMatchesForClub(league, clubId, asOf = Infinity) {
  const matches = league?.calendar?.matches;
  if (!Array.isArray(matches) || !clubId) return [];
  return matches
    .filter(m => m && m.status === 'settled' && !m.desempate && m.result
      && Number.isFinite(m.result.home) && Number.isFinite(m.result.away)
      && (m.homeId === clubId || m.awayId === clubId)
      && (asOf === Infinity || (Number.isFinite(m.settledAt) && m.settledAt <= asOf)))
    .slice()
    .sort((a, b) => (Number(a.settledAt) || 0) - (Number(b.settledAt) || 0)
      || (Number(a.jornada) || 0) - (Number(b.jornada) || 0)
      || String(a.id || '').localeCompare(String(b.id || '')));
}

function summarizeMatchesForClub(matches, clubId) {
  let wins = 0, draws = 0, losses = 0, goalsFor = 0, goalsAgainst = 0, consecutiveLosses = 0;
  for (const m of matches) {
    const gf = m.homeId === clubId ? m.result.home : m.result.away;
    const ga = m.homeId === clubId ? m.result.away : m.result.home;
    goalsFor += gf;
    goalsAgainst += ga;
    if (gf > ga) { wins++; consecutiveLosses = 0; }
    else if (gf === ga) { draws++; consecutiveLosses = 0; }
    else { losses++; consecutiveLosses++; }
  }
  const played = matches.length;
  const points = wins * 3 + draws;
  return {
    played, wins, draws, losses, points, goalsFor, goalsAgainst,
    goalDiff: goalsFor - goalsAgainst,
    pointsPerGame: played ? Number((points / played).toFixed(2)) : 0,
    consecutiveLosses
  };
}

// Determina de forma puramente causal (solo partidos asentados <= asOf) si el DT
// mantiene su dibujo base o cambia de formación y estilo para corregir el rumbo.
function resolveClubTactics(club, league = null, asOf = Infinity) {
  const manager = managerOfClub(club, league?.seasonMonth || null);
  const baseFormation = normalizeFormation(club?.tactics?.formation || manager.preferredFormation);
  const baseStyle = normalizeStyle(club?.tactics?.style || manager.style);
  const playedMatches = league ? settledRegularMatchesForClub(league, club?.id, asOf) : [];
  const recent = playedMatches.slice(-3);
  const recentSummary = summarizeMatchesForClub(recent, club?.id);

  if (recent.length >= 3) {
    const defensiveLeak = recentSummary.goalsAgainst >= 6;
    const goalDrought = recentSummary.goalsFor <= 1 && recentSummary.wins === 0;
    const badRun = recentSummary.points <= 2 || recentSummary.consecutiveLosses >= 2;
    if (defensiveLeak || goalDrought || badRun) {
      let toFormation = manager.secondaryFormation;
      if (defensiveLeak && !['4-2-3-1', '3-5-2'].includes(toFormation)) {
        toFormation = baseFormation === '4-2-3-1' ? '3-5-2' : '4-2-3-1';
      } else if (goalDrought && !['4-3-3', '4-4-2'].includes(toFormation)) {
        toFormation = baseFormation === '4-3-3' ? '4-4-2' : '4-3-3';
      }
      if (toFormation === baseFormation) {
        toFormation = baseFormation === '4-3-3' ? '4-2-3-1' : '4-3-3';
      }
      const toStyle = defensiveLeak
        ? (baseStyle === 'counter' ? 'balanced' : 'counter')
        : goalDrought
          ? (baseStyle === 'pressing' ? 'direct' : 'pressing')
          : (baseStyle === 'balanced' ? 'pressing' : 'balanced');
      const reason = defensiveLeak
        ? `ajustó el bloque tras recibir ${recentSummary.goalsAgainst} goles en 3 jornadas`
        : goalDrought
          ? `buscó más peso en el área tras marcar solo ${recentSummary.goalsFor} gol${recentSummary.goalsFor === 1 ? '' : 'es'} en 3 fechas`
          : `movió la pizarra tras sumar ${recentSummary.points} de 9 puntos recientes`;
      return {
        formation: toFormation,
        baseFormation,
        style: toStyle,
        baseStyle,
        changed: true,
        reason,
        recentRecord: recentSummary,
        manager
      };
    }
  }

  return {
    formation: baseFormation,
    baseFormation,
    style: baseStyle,
    baseStyle,
    changed: false,
    reason: null,
    recentRecord: recentSummary,
    manager
  };
}

function snapshotManagerForMatch(club, resolvedTactics = null, seasonMonth = null) {
  const resolved = resolvedTactics || resolveClubTactics(club, null, Infinity);
  const manager = resolved.manager || managerOfClub(club, seasonMonth);
  return {
    id: manager.id,
    name: manager.name,
    preferredFormation: resolved.formation,
    secondaryFormation: resolved.formation === manager.secondaryFormation ? manager.preferredFormation : manager.secondaryFormation,
    style: resolved.style,
    subProfile: manager.subProfile,
    marketFocus: manager.marketFocus
  };
}

// --- 3. Evaluación de rendimiento, presión en el banquillo, despidos y contrataciones ---

function evaluateSeasonManagers(league, { asOf = Infinity } = {}) {
  if (!league || !Array.isArray(league.config) || !league.config.length) return [];
  const rows = league.config.map(club => {
    const matches = settledRegularMatchesForClub(league, club.id, asOf);
    const stats = summarizeMatchesForClub(matches, club.id);
    const manager = managerOfClub(club, league.seasonMonth);
    return { club, clubId: club.id, clubName: club.name, manager, stats };
  });

  rows.sort((a, b) =>
    (b.stats.points - a.stats.points)
    || (b.stats.goalDiff - a.stats.goalDiff)
    || (b.stats.goalsFor - a.stats.goalsFor)
    || a.clubId.localeCompare(b.clubId));

  rows.forEach((row, index) => {
    const rank = index + 1;
    const s = row.stats;
    row.rank = rank;
    const bottomZone = rank >= 14;
    const veryLowPoints = s.pointsPerGame < 0.95;
    const winlessRun = s.wins === 0 && s.played >= MIN_MATCHES_FOR_SACKING;
    const heavyGoalDeficit = s.played > 0 && (s.goalDiff / s.played) <= -1.0;

    row.poorPerformance = s.played >= MIN_MATCHES_FOR_SACKING
      && (bottomZone || veryLowPoints || winlessRun || heavyGoalDeficit);

    row.underPressure = s.played >= MIN_MATCHES_FOR_PRESSURE
      && (rank >= 14 || s.pointsPerGame <= 0.9 || s.consecutiveLosses >= 3);

    row.performanceScore = s.pointsPerGame * 100 + (s.played ? (s.goalDiff / s.played) * 18 : 0) - rank * 1.5;

    if (row.poorPerformance) {
      if (winlessRun) row.reason = `cerró sin victorias (${s.draws}E-${s.losses}D) en ${s.played} jornadas`;
      else if (bottomZone && veryLowPoints) row.reason = `terminó ${rank}.º con ${s.points} pts en ${s.played} partidos (${s.wins}V-${s.draws}E-${s.losses}D)`;
      else if (heavyGoalDeficit) row.reason = `sufrió una diferencia de goles de ${s.goalDiff} (${s.goalsFor} GF / ${s.goalsAgainst} GC) y acabó ${rank}.º`;
      else if (bottomZone) row.reason = `acabó en el fondo de la tabla (${rank}.º puesto, ${s.points} pts)`;
      else row.reason = `promedió apenas ${String(s.pointsPerGame.toFixed(2)).replace('.', ',')} puntos por partido (${s.wins}V-${s.draws}E-${s.losses}D)`;
    } else if (row.underPressure) {
      row.reason = s.consecutiveLosses >= 3
        ? `acumula ${s.consecutiveLosses} derrotas seguidas (${rank}.º puesto)`
        : `marcha ${rank}.º con ${s.points} puntos en ${s.played} partidos`;
    } else {
      row.reason = null;
    }
  });

  const sackingCandidates = rows
    .filter(r => r.poorPerformance)
    .slice()
    .sort((a, b) => a.performanceScore - b.performanceScore || b.rank - a.rank || a.clubId.localeCompare(b.clubId))
    .slice(0, MAX_SACKINGS_PER_SEASON);
  const sackedClubIds = new Set(sackingCandidates.map(r => r.clubId));
  for (const row of rows) row.sacked = sackedClubIds.has(row.clubId);
  return rows;
}

function desiredFocusAfterPoorSeason(row) {
  const s = row.stats;
  if (!s.played) return 'equilibrio';
  if (s.goalsAgainst / s.played >= 1.55) return 'solidez';
  if (s.goalsFor / s.played <= 0.9) return 'ataque';
  return row.manager.marketFocus === 'creacion' ? 'ataque' : 'creacion';
}

function planManagerChanges(previousLeague, targetSeason = null) {
  if (!previousLeague || !Array.isArray(previousLeague.config) || previousLeague.config.length !== 16) {
    return { fromSeason: previousLeague?.seasonMonth || null, effectiveSeason: targetSeason, changes: [] };
  }
  const evaluations = evaluateSeasonManagers(previousLeague);
  const sackedRows = evaluations
    .filter(r => r.sacked)
    .sort((a, b) => a.performanceScore - b.performanceScore || a.clubId.localeCompare(b.clubId));
  if (!sackedRows.length) {
    return { fromSeason: previousLeague.seasonMonth, effectiveSeason: targetSeason, changes: [] };
  }

  // Ningún entrenador con contrato vigente (ni recién despedido en este corte)
  // puede duplicarse en otro banquillo de la misma temporada.
  const occupiedIds = new Set(evaluations.map(r => r.manager.id));
  const seed = hash32(`${previousLeague.seasonMonth}|dt-contrataciones|${targetSeason || ''}`);
  const random = mulberry32(seed);
  const changes = [];

  for (const row of sackedRows) {
    const neededFocus = desiredFocusAfterPoorSeason(row);
    const available = ALL_COACHES.filter(coach => !occupiedIds.has(coach.id));
    if (!available.length) break;
    const ranked = available
      .map(coach => {
        let fit = 0;
        if (coach.marketFocus === neededFocus) fit += 30;
        if (coach.preferredFormation !== row.manager.preferredFormation) fit += 15;
        if (coach.style !== row.manager.style) fit += 8;
        fit += random() * 6;
        return { coach, fit };
      })
      .sort((a, b) => b.fit - a.fit || a.coach.id.localeCompare(b.coach.id));
    const hired = ranked[0].coach;
    occupiedIds.add(hired.id);
    changes.push({
      clubId: row.clubId,
      clubName: row.clubName,
      fromSeason: previousLeague.seasonMonth,
      effectiveSeason: targetSeason,
      outgoingManager: {
        id: row.manager.id,
        name: row.manager.name,
        formation: row.manager.preferredFormation,
        style: row.manager.style
      },
      incomingManager: {
        id: hired.id,
        name: hired.name,
        preferredFormation: hired.preferredFormation,
        secondaryFormation: hired.secondaryFormation,
        style: hired.style,
        subProfile: hired.subProfile,
        marketFocus: hired.marketFocus
      },
      neededFocus,
      reason: row.reason,
      record: {
        rank: row.rank,
        played: row.stats.played,
        wins: row.stats.wins,
        draws: row.stats.draws,
        losses: row.stats.losses,
        points: row.stats.points,
        goalsFor: row.stats.goalsFor,
        goalsAgainst: row.stats.goalsAgainst
      }
    });
  }

  return {
    fromSeason: previousLeague.seasonMonth,
    effectiveSeason: targetSeason,
    changes
  };
}

function retainPreviousManagers(previousLeague, clubs, seasonMonth = null) {
  if (!previousLeague || !Array.isArray(previousLeague.config) || !Array.isArray(clubs)) return false;
  const prevById = new Map(previousLeague.config.map(c => [c.id, c]));
  for (const club of clubs) {
    const prevClub = prevById.get(club.id);
    const prevManager = prevClub ? managerOfClub(prevClub, previousLeague.seasonMonth) : buildInitialManager(club.id, club.tactics, seasonMonth);
    club.manager = {
      ...prevManager,
      previousManager: null
    };
    club.tactics = {
      formation: prevManager.preferredFormation,
      style: prevManager.style
    };
  }
  return true;
}

function applyManagerChanges(previousLeague, clubs, targetSeason) {
  if (!retainPreviousManagers(previousLeague, clubs, targetSeason)) return { changes: [] };
  const plan = planManagerChanges(previousLeague, targetSeason);
  const changeByClub = new Map(plan.changes.map(c => [c.clubId, c]));

  for (const club of clubs) {
    const change = changeByClub.get(club.id);
    if (change) {
      const incoming = change.incomingManager;
      club.manager = {
        id: incoming.id,
        name: incoming.name,
        preferredFormation: incoming.preferredFormation,
        secondaryFormation: incoming.secondaryFormation,
        style: incoming.style,
        subProfile: incoming.subProfile,
        marketFocus: incoming.marketFocus,
        appointedSeason: targetSeason,
        tenureSeasons: 1,
        previousManager: {
          id: change.outgoingManager.id,
          name: change.outgoingManager.name,
          sackedAfterSeason: previousLeague.seasonMonth,
          reason: change.reason,
          record: { ...change.record }
        }
      };
      club.tactics = {
        formation: incoming.preferredFormation,
        style: incoming.style
      };
    } else {
      club.manager.tenureSeasons = (Number(club.manager.tenureSeasons) || 1) + 1;
      club.manager.previousManager = null;
      club.tactics = {
        formation: club.manager.preferredFormation,
        style: club.manager.style
      };
    }
  }
  return plan;
}

// --- 4. Scouting y decisiones de compra del DT en el mercado ---

// Detecta qué zona necesita reforzar con más urgencia el DT comprador según la
// calidad actual de su plantel y su dibujo preferido.
function diagnoseSquadNeed(club, manager = null) {
  const coach = manager || managerOfClub(club);
  const squad = Array.isArray(club?.squad) ? club.squad : [];
  const formation = coach.preferredFormation || '4-4-2';
  const focus = coach.marketFocus || 'equilibrio';

  const groupAvg = group => {
    const role = group;
    const pool = squad
      .filter(p => (POS_GROUP[p.pos] || 'MF') === group)
      .map(p => scoreStarterForCoach(p, role, coach))
      .sort((a, b) => b - a);
    const take = group === 'DF' ? (formation === '3-5-2' ? 3 : 4)
      : group === 'MF' ? (formation === '4-3-3' ? 3 : formation === '4-4-2' ? 4 : 5)
        : (formation === '4-2-3-1' ? 1 : formation === '4-3-3' ? 3 : 2);
    const top = pool.slice(0, Math.max(1, take));
    return top.length ? top.reduce((s, v) => s + v, 0) / top.length : 60;
  };

  const dfScore = groupAvg('DF') - (focus === 'solidez' ? 4.5 : 0);
  const mfScore = groupAvg('MF') - (focus === 'creacion' ? 4.5 : 0);
  const fwScore = groupAvg('FW') - (focus === 'ataque' ? 4.5 : 0);

  const ranked = [
    { group: 'FW', score: fwScore, preferredPositions: ['ST', 'LW', 'RW', 'CAM'], label: 'potencia ofensiva' },
    { group: 'MF', score: mfScore, preferredPositions: ['CAM', 'CM', 'CDM'], label: 'creación en mediocampo' },
    { group: 'DF', score: dfScore, preferredPositions: ['CB', 'RB', 'LB', 'CDM'], label: 'solidez defensiva' }
  ].sort((a, b) => a.score - b.score);

  return {
    primaryGroup: ranked[0].group,
    preferredPositions: ranked[0].preferredPositions,
    label: ranked[0].label,
    focus,
    formation
  };
}

function scoreTransferTarget(player, buyingClub, buyingManager = null, need = null) {
  if (!player || !player.attrs || player.pos === 'GK') return -Infinity;
  const coach = buyingManager || managerOfClub(buyingClub);
  const diagnosis = need || diagnoseSquadNeed(buyingClub, coach);
  const group = POS_GROUP[player.pos] || 'MF';
  let score = scoreStarterForCoach(player, group, coach);
  if (group === diagnosis.primaryGroup) score += 9;
  const posRank = diagnosis.preferredPositions.indexOf(player.pos);
  if (posRank >= 0) score += (4 - posRank) * 2.5;
  return score;
}

function describeManagerSigning(move, buyingClub, seasonMonth = null) {
  const coach = managerOfClub(buyingClub, seasonMonth);
  const need = diagnoseSquadNeed(buyingClub, coach);
  return {
    managerId: coach.id,
    managerName: coach.name,
    coachFocus: coach.marketFocus,
    targetFormation: coach.preferredFormation,
    tacticalNeed: need.label,
    signingReason: `Pedido del DT ${coach.name} para reforzar ${need.label} en su ${coach.preferredFormation}`
  };
}

// --- 5. Gestión de cambios en V1 ---

function subWindowForCoach(manager = null) {
  const profile = manager?.subProfile || 'equilibrado';
  if (profile === 'proactivo') return { min: 50, max: 83, minSubs: 4, maxSubs: 5 };
  if (profile === 'conservador') return { min: 60, max: 88, minSubs: 3, maxSubs: 4 };
  return { min: 55, max: 86, minSubs: 3, maxSubs: 5 };
}

module.exports = {
  VALID_FORMATIONS,
  VALID_STYLES,
  MAX_SACKINGS_PER_SEASON,
  MIN_MATCHES_FOR_SACKING,
  MIN_MATCHES_FOR_PRESSURE,
  INAUGURAL_MANAGERS,
  FREE_AGENT_COACHES,
  ALL_COACHES,
  COACH_BY_ID,
  buildInitialManager,
  cleanManager,
  ensureClubManagers,
  managerOfClub,
  scoreStarterForCoach,
  settledRegularMatchesForClub,
  summarizeMatchesForClub,
  resolveClubTactics,
  snapshotManagerForMatch,
  evaluateSeasonManagers,
  planManagerChanges,
  retainPreviousManagers,
  applyManagerChanges,
  diagnoseSquadNeed,
  scoreTransferTarget,
  describeManagerSigning,
  subWindowForCoach
};
