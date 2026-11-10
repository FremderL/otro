'use strict';

// MonteCristo News — Boletín oficial y registro obligatorio de impacto en clubes.
//
// REGLA EXPLÍCITA DE ARQUITECTURA (ver AGENTS.md y docs/montecristo-news-regla-clubes.md):
//   Cualquier funcionalidad presente o futura que afecte a los clubes del Estadio
//   (dirección técnica, formaciones, traspasos, títulos, prestigio, premios ligados
//   al club, afición, finanzas/infraestructura de club, lesiones o sanciones de
//   plantel, etc.) DEBE declararse en CLUB_IMPACT_REGISTRY y publicar sus anuncios
//   correspondientes en MonteCristo News mediante este módulo.
//
// tests/code-hygiene.test.js audita automáticamente que ningún módulo nuevo en
// lib/football/ quede fuera de esta gobernanza.

const { CLUB_BY_ID } = require('./teams');
const {
  managerOfClub,
  resolveClubTactics,
  evaluateSeasonManagers,
  planManagerChanges
} = require('./managers');
const { ballonDorResultAnnouncementAt } = require('./ballon-dor-market');

const STYLE_LABELS = Object.freeze({
  possession: 'posesión',
  pressing: 'presión alta',
  direct: 'juego directo',
  counter: 'contraataque',
  balanced: 'equilibrio táctico'
});

const FOCUS_LABELS = Object.freeze({
  ataque: 'poder ofensivo',
  creacion: 'creación en mediocampo',
  solidez: 'solidez defensiva',
  equilibrio: 'equilibrio entre líneas'
});

const CLUB_NEWS_TYPES = Object.freeze([
  'coach_change',
  'season_champion',
  'tactical_shift',
  'coach_pressure',
  'season_leader',
  'ballon_dor_spotlight',
  'prestige_alert',
  'fan_pulse',
  'fan_milestone',
  'match_result',
  'match_roundup',
  'daily_table',
  'daily_agenda',
  'transfer_roundup',
  'service_return'
]);

// Registro canónico de todos los módulos de lib/football/ cuyo dominio afecta a clubes
// y qué categorías de anuncios alimentan en MonteCristo News.
const CLUB_IMPACT_REGISTRY = Object.freeze({
  'club-news.js': {
    domain: 'Canal editorial MonteCristo News',
    newsTypes: CLUB_NEWS_TYPES
  },
  'managers.js': {
    domain: 'Dirección técnica: despidos por mal rendimiento, contrataciones, presión y cambios de formación',
    newsTypes: ['coach_change', 'coach_pressure', 'tactical_shift']
  },
  'transfers.js': {
    domain: 'Mercado de fichajes entre clubes solicitados por cada DT',
    newsTypes: ['transfer_signing']
  },
  'teams.js': {
    domain: 'Identidad de clubes, plantillas de temporada y arrastre de prestigio (carryover)',
    newsTypes: ['season_champion', 'prestige_alert']
  },
  'ratings.js': {
    domain: 'Rendimiento competitivo, liderato y evolución Elo de los clubes',
    newsTypes: ['season_leader', 'prestige_alert']
  },
  'club-profile.js': {
    domain: 'Ficha pública, palmarés verificado y pizarra técnica de cada club',
    newsTypes: ['season_champion', 'coach_change', 'tactical_shift']
  },
  'ballon-dor.js': {
    domain: 'Premio Balón de Oro y protagonismo del club del delantero líder o ganador',
    newsTypes: ['ballon_dor_spotlight']
  },
  'ballon-dor-stats.js': {
    domain: 'Estadísticas goleadoras verificadas de los clubes en la carrera al Balón de Oro',
    newsTypes: ['ballon_dor_spotlight']
  },
  'ballon-dor-readiness.js': {
    domain: 'Elegibilidad del Balón de Oro: cierre con más del 90% de partidos asentados y archivo estadístico suficiente',
    newsTypes: ['ballon_dor_spotlight']
  },
  'fan-club.js': {
    domain: 'Respaldo agregado público, rangos de lealtad e insignias de campeón de Mi afición por club',
    newsTypes: ['fan_pulse', 'fan_milestone']
  },
  'daily-news.js': {
    domain: 'Edición diaria causal: resultados oficiales, tabla y cartelera de los clubes',
    newsTypes: ['match_result', 'match_roundup', 'daily_table', 'daily_agenda', 'transfer_roundup', 'service_return']
  },
  'roster.js': {
    domain: 'Estado de plantilla y participación verificada por club',
    newsTypes: ['season_leader']
  }
});

// Módulos técnicos, de motor de partido, transporte o mercados de usuario que no
// crean eventos institucionales propios de club (auditado en tests/code-hygiene.test.js).
const NON_CLUB_NEWS_MODULES = Object.freeze({
  'auto-reschedule.js': 'Ventana operativa de reprogramación horaria de partidos',
  'ballon-dor-audit.js': 'Auditoría interna de integridad estadística del Balón de Oro',
  'ballon-dor-market.js': 'Cálculo de cuotas y apuestas de usuarios al Balón de Oro',
  'betting.js': 'Liquidación y validación de boletos de apuesta de usuarios',
  'daily-news-service.js': 'Persistencia y entrega de ediciones; no crea ni modifica hechos de club',
  'daily-news-state.js': 'Normalización y límites del almacenamiento editorial, sin estado deportivo',
  'commentary.js': 'Plantillas de narración jugada a jugada durante el partido',
  'engine.js': 'Orquestador en tiempo real del reloj y ciclo de vida de partidos',
  'fan-club-profile.js': 'Serialización de pines personales en el perfil del jugador',
  'fantasy-profile.js': 'Serialización de Mi Once en el perfil del jugador',
  'fantasy.js': 'Juego de alineación personal Mi Once de los usuarios',
  'fixtures.js': 'Generador combinatorio del calendario todos contra todos',
  'future-market.js': 'Cuotas y apuestas futuras de usuarios',
  'highlights.js': 'Extractor de jugadas destacadas de un partido',
  'http.js': 'Rutas HTTP y validación de transporte del Estadio',
  'match-context.js': 'Contexto estadístico previo de un cruce individual',
  'match-engine.js': 'Simulador V1 de línea de tiempo de partido',
  'match-state.js': 'Geometría de cancha, formaciones y estado de partido',
  'odds-audit.js': 'Anillo de auditoría interna de cuotas',
  'odds.js': 'Modelo matemático de probabilidades y márgenes de partido',
  'pg-single-writer.js': 'Cerrojo de escritura única para PostgreSQL',
  'pregame.js': 'Charla de los comentaristas unos minutos antes del saque inicial',
  'player-value.js': 'Fórmula pura de valoración informativa de jugadores',
  'prng.js': 'Generador pseudoaleatorio determinista sin estado de club',
  'promotion-media.js': ' Almacenamiento multimedia de promociones comerciales',
  'promotions.js': 'Moderación de promociones comerciales de usuarios',
  'quiniela-pg.js': 'Persistencia PostgreSQL de boletos de Quiniela',
  'quiniela-service.js': 'Servicio de inscripción y bote de la Quiniela 8 de 8',
  'quiniela.js': 'Reglas puras de aciertos de la Quiniela',
  'reset-gate.js': 'Compuerta administrativa de reinicio',
  'rollout-telemetry.js': 'Telemetría técnica de despliegue V2',
  'scheduler.js': 'Bucle de programación temporal de jornadas',
  'season-admission.js': 'Control de admisión de temporada activa',
  'simulated-flow.js': 'Flujo auxiliar de pruebas simuladas',
  'sockets.js': 'Handlers Socket.IO de transporte cliente-servidor',
  'stands.js': 'Asientos virtuales de espectadores en la grada'
});

function clubDisplayName(clubId, league = null) {
  const inLeague = league?.config?.find(c => c.id === clubId);
  return inLeague?.name || CLUB_BY_ID[clubId]?.name || String(clubId || 'Club');
}

function nextMonthKey(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) return null;
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

function allRegularMatchesSettled(league, asOf = Infinity) {
  const regular = (league?.calendar?.matches || []).filter(m => m && !m.desempate);
  if (!regular.length) return false;
  return regular.every(m => m.status === 'settled' && m.result
    && (asOf === Infinity || (Number.isFinite(m.settledAt) && m.settledAt <= asOf)));
}

// Campeón verificado de una liga cuyos partidos regulares (y desempate si lo hubo)
// ya quedaron asentados en o antes de `asOf`.
function verifiedSeasonChampion(league, asOf = Infinity) {
  if (!league || !allRegularMatchesSettled(league, asOf)) return null;
  const rows = evaluateSeasonManagers(league, { asOf });
  if (rows.length < 2) return null;
  const tiebreak = (league.calendar?.matches || []).find(m => m && m.desempate);
  if (tiebreak) {
    if (tiebreak.status !== 'settled' || !tiebreak.result || (asOf !== Infinity && !(tiebreak.settledAt <= asOf))) {
      return null;
    }
    const winnerId = tiebreak.result.winner === 'home' ? tiebreak.homeId
      : tiebreak.result.winner === 'away' ? tiebreak.awayId
        : tiebreak.result.home > tiebreak.result.away ? tiebreak.homeId
          : tiebreak.result.away > tiebreak.result.home ? tiebreak.awayId : null;
    const champRow = rows.find(r => r.clubId === winnerId);
    if (!champRow) return null;
    return { ...champRow, viaTiebreak: true };
  }
  const [first, second] = rows;
  if (first.stats.points === second.stats.points && first.stats.goalDiff === second.stats.goalDiff && first.stats.goalsFor === second.stats.goalsFor) {
    return null;
  }
  return { ...first, viaTiebreak: false };
}

// 1. Anuncios de despido por mal rendimiento y contratación de nuevo DT.
function buildCoachChangeAnnouncements(league, previousLeague, asOf) {
  const items = [];
  if (!league || !Array.isArray(league.config)) return items;

  // Caso A: La temporada activa ya incorporó nuevos DT tras despidos al cierre del mes previo.
  for (const club of league.config) {
    const manager = managerOfClub(club, league.seasonMonth);
    const prev = manager.previousManager;
    if (!prev || !prev.name) continue;
    const styleLabel = STYLE_LABELS[manager.style] || manager.style;
    const focusLabel = FOCUS_LABELS[manager.marketFocus] || manager.marketFocus;
    const reasonText = prev.reason || 'mal rendimiento deportivo';
    items.push({
      id: `coach-hired:${league.seasonMonth}:${club.id}:${manager.id}`,
      type: 'coach_change',
      priority: 100,
      seasonMonth: league.seasonMonth,
      clubId: club.id,
      clubName: club.name,
      badge: `NUEVO DT · ${league.seasonMonth}`,
      headline: `${club.name} contrata al DT ${manager.name}`,
      subtitle: `Releva a ${prev.name} · Nueva pizarra ${manager.preferredFormation}`,
      summary: `Tras despedir a ${prev.name} porque ${reasonText}, ${club.name} anuncia a ${manager.name} para la temporada ${league.seasonMonth} con formación ${manager.preferredFormation}, estilo de ${styleLabel} y foco en ${focusLabel}.`,
      spoken: `Noticia de banquillos en ${club.name}: la directiva despidió a ${prev.name} luego de que ${reasonText}, y hace oficial la contratación del director técnico ${manager.name} para la temporada ${league.seasonMonth}. Su nuevo proyecto arranca con dibujo ${manager.preferredFormation} y apuesta por ${styleLabel}.`,
      details: {
        outgoingManager: prev.name,
        incomingManager: manager.name,
        formation: manager.preferredFormation,
        style: manager.style,
        marketFocus: manager.marketFocus
      }
    });
  }

  // Caso B: La temporada actual ya completó su calendario regular y definió despidos/contrataciones para el mes entrante.
  if (allRegularMatchesSettled(league, asOf)) {
    const targetSeason = nextMonthKey(league.seasonMonth);
    const plan = planManagerChanges(league, targetSeason);
    for (const change of plan.changes.slice(0, 3)) {
      const styleLabel = STYLE_LABELS[change.incomingManager.style] || change.incomingManager.style;
      const focusLabel = FOCUS_LABELS[change.incomingManager.marketFocus] || change.incomingManager.marketFocus;
      items.push({
        id: `coach-planned:${league.seasonMonth}:${change.clubId}:${change.incomingManager.id}`,
        type: 'coach_change',
        priority: 102,
        seasonMonth: league.seasonMonth,
        effectiveSeason: targetSeason,
        clubId: change.clubId,
        clubName: change.clubName,
        badge: `DESPIDO Y FICHAJE DE DT · ${targetSeason || ''}`.trim(),
        headline: `${change.clubName} despide a ${change.outgoingManager.name} y ficha a ${change.incomingManager.name}`,
        subtitle: `Asume en ${targetSeason || 'la nueva temporada'} · Formación ${change.incomingManager.preferredFormation}`,
        summary: `Por mal rendimiento (${change.reason}), ${change.clubName} cesa a ${change.outgoingManager.name} y contrata al DT ${change.incomingManager.name} para ${targetSeason || 'la próxima campaña'}, quien implantará un ${change.incomingManager.preferredFormation} con ${focusLabel}.`,
        spoken: `Golpe de timón en ${change.clubName}: tras un mal rendimiento donde el equipo ${change.reason}, el club despide al director técnico ${change.outgoingManager.name} y anuncia la contratación de ${change.incomingManager.name} para la temporada ${targetSeason || 'entrante'}, con formación ${change.incomingManager.preferredFormation} y sello de ${styleLabel}.`,
        details: {
          outgoingManager: change.outgoingManager.name,
          incomingManager: change.incomingManager.name,
          formation: change.incomingManager.preferredFormation,
          style: change.incomingManager.style,
          marketFocus: change.incomingManager.marketFocus
        }
      });
    }
  }

  return items;
}

// 2. Campeón verificado y arrastre de prestigio entre temporadas.
function buildHonorsAndPrestigeAnnouncements(league, previousLeague, asOf) {
  const items = [];
  if (previousLeague) {
    const champ = verifiedSeasonChampion(previousLeague, asOf);
    if (champ) {
      const clubName = clubDisplayName(champ.clubId, league || previousLeague);
      const currentClub = league?.config?.find(c => c.id === champ.clubId) || champ.club;
      const coach = managerOfClub(currentClub, league?.seasonMonth || previousLeague.seasonMonth);
      const tieNote = champ.viaTiebreak ? ' tras imponerse en el desempate por el título' : '';
      items.push({
        id: `champion:${previousLeague.seasonMonth}:${champ.clubId}`,
        type: 'season_champion',
        priority: 92,
        seasonMonth: league?.seasonMonth || previousLeague.seasonMonth,
        clubId: champ.clubId,
        clubName,
        badge: `CAMPEÓN VIGENTE · ${previousLeague.seasonMonth}`,
        headline: `${clubName} defiende la corona de ${previousLeague.seasonMonth}`,
        subtitle: `${champ.stats.points} pts · ${champ.stats.goalsFor} goles · DT ${coach.name}`,
        summary: `${clubName} conquistó el campeonato ${previousLeague.seasonMonth}${tieNote} (${champ.stats.wins}V-${champ.stats.draws}E-${champ.stats.losses}D) y recibe impulso competitivo de prestigio en el arranque.`,
        spoken: `Honor al campeón: ${clubName} defiende el título conquistado en ${previousLeague.seasonMonth}${tieNote} con ${champ.stats.points} puntos bajo el mando técnico de ${coach.name}.`
      });
    }
  }

  // Alerta de revancha para el colista con penalización de prestigio (carryover negativo).
  const rawCarryover = previousLeague?.carryover && Object.keys(previousLeague.carryover).length
    ? previousLeague.carryover
    : league?.carryover;
  const carryover = rawCarryover && typeof rawCarryover === 'object' ? rawCarryover : null;
  if (carryover && league?.config) {
    const penalized = Object.entries(carryover)
      .filter(([, delta]) => Number(delta) <= -20)
      .sort((a, b) => Number(a[1]) - Number(b[1]));
    if (penalized.length) {
      const [clubId, delta] = penalized[0];
      const club = league.config.find(c => c.id === clubId);
      if (club) {
        const coach = managerOfClub(club, league.seasonMonth);
        items.push({
          id: `prestige:${league.seasonMonth}:${clubId}`,
          type: 'prestige_alert',
          priority: 62,
          seasonMonth: league.seasonMonth,
          clubId,
          clubName: club.name,
          badge: 'OPERACIÓN REVANCHA',
          headline: `${club.name} busca salir del fondo`,
          subtitle: `Ajuste Elo ${delta} · Pizarra ${coach.preferredFormation} de ${coach.name}`,
          summary: `${club.name} inicia el ciclo con ajuste competitivo (${delta} Elo) tras cerrar último el curso previo; el DT ${coach.name} reconstruye desde el ${coach.preferredFormation}.`,
          spoken: `En clave de reconstrucción, ${club.name} parte con exigencia máxima tras el cierre anterior y se apoya en la pizarra ${coach.preferredFormation} del técnico ${coach.name} para revertir su situación.`
        });
      }
    }
  }
  return items;
}

// 3. Cambios tácticos de formación ordenados por los DT en la temporada en curso.
function buildTacticalShiftAnnouncements(league, asOf) {
  const items = [];
  if (!league || !Array.isArray(league.config)) return items;
  for (const club of league.config) {
    const resolved = resolveClubTactics(club, league, asOf);
    if (!resolved.changed) continue;
    const styleLabel = STYLE_LABELS[resolved.style] || resolved.style;
    items.push({
      id: `tactics:${league.seasonMonth}:${club.id}:${resolved.formation}`,
      type: 'tactical_shift',
      priority: 86,
      seasonMonth: league.seasonMonth,
      clubId: club.id,
      clubName: club.name,
      badge: `CAMBIO DE FORMACIÓN · ${resolved.formation}`,
      headline: `DT ${resolved.manager.name} cambia a ${resolved.formation} en ${club.name}`,
      subtitle: `Deja el ${resolved.baseFormation} · Nuevo plan de ${styleLabel}`,
      summary: `El DT ${resolved.manager.name} ${resolved.reason} y ordena pasar del ${resolved.baseFormation} al ${resolved.formation} con estilo de ${styleLabel}.`,
      spoken: `Movimiento de pizarra en ${club.name}: el director técnico ${resolved.manager.name} ${resolved.reason} y cambia la formación del ${resolved.baseFormation} al ${resolved.formation}.`
    });
  }
  return items.slice(0, 3);
}

// 4. Banquillos bajo presión y liderato de la liga activa.
function buildCompetitiveFormAnnouncements(league, asOf) {
  const items = [];
  if (!league || !Array.isArray(league.config)) return items;
  const rows = evaluateSeasonManagers(league, { asOf });
  const anyPlayed = rows.some(r => r.stats.played > 0);
  if (!anyPlayed) return items;

  const leader = rows[0];
  if (leader && leader.stats.played >= 1) {
    const tactics = resolveClubTactics(leader.club, league, asOf);
    items.push({
      id: `leader:${league.seasonMonth}:${leader.clubId}:${leader.stats.played}`,
      type: 'season_leader',
      priority: 80,
      seasonMonth: league.seasonMonth,
      clubId: leader.clubId,
      clubName: leader.clubName,
      badge: `LÍDER DE LIGA · ${league.seasonMonth}`,
      headline: `${leader.clubName} manda en la tabla con ${leader.stats.points} puntos`,
      subtitle: `${leader.stats.wins}V-${leader.stats.draws}E-${leader.stats.losses}D · DT ${leader.manager.name} (${tactics.formation})`,
      summary: `${leader.clubName} marca el paso de la temporada ${league.seasonMonth} con ${leader.stats.points} puntos y ${leader.stats.goalsFor} goles a favor bajo la dirección de ${leader.manager.name}.`,
      spoken: `En la lucha por la cima, ${leader.clubName} lidera la temporada ${league.seasonMonth} con ${leader.stats.points} puntos gracias al funcionamiento del ${tactics.formation} dirigido por ${leader.manager.name}.`
    });
  }

  if (!allRegularMatchesSettled(league, asOf)) {
    const pressured = rows
      .filter(r => r.underPressure)
      .sort((a, b) => a.performanceScore - b.performanceScore || a.clubId.localeCompare(b.clubId))
      .slice(0, 2);
    for (const row of pressured) {
      items.push({
        id: `pressure:${league.seasonMonth}:${row.clubId}:${row.stats.played}`,
        type: 'coach_pressure',
        priority: 84,
        seasonMonth: league.seasonMonth,
        clubId: row.clubId,
        clubName: row.clubName,
        badge: 'BANQUILLO EN RIESGO',
        headline: `Cuestionado el DT ${row.manager.name} en ${row.clubName}`,
        subtitle: `${row.rank}.º puesto · ${row.stats.points} pts en ${row.stats.played} PJ`,
        summary: `Alarma deportiva en ${row.clubName}: el equipo ${row.reason}. Si no reacciona antes del cierre de temporada, ${row.manager.name} podría ser despedido.`,
        spoken: `Atención al banquillo de ${row.clubName}: el equipo ${row.reason} y crece la presión sobre el director técnico ${row.manager.name}, cuyo cargo peligra de cara a la próxima temporada.`
      });
    }
  }
  return items;
}

// 5. Club destacado en la carrera al Balón de Oro.
function buildBallonDorClubAnnouncement(league, previousLeague, asOf = Infinity) {
  const items = [];
  const bd = league?.ballonDor;
  // La nota de cobertura parcial solo se publica después de la ceremonia.
  // Antes de esa hora no debe filtrar al ganador ni el cierre anticipado.
  const coverage = bd?.status === 'settled' ? bd.result?.coverage : null;
  if (coverage && Number.isSafeInteger(coverage.played) && coverage.played < coverage.total) {
    const announcementAt = ballonDorResultAnnouncementAt(
      { getMatches: () => league?.calendar?.matches || [] }, bd
    );
    const winner = bd.candidates?.find(c => c.id === bd.result?.winnerCandidateId);
    if (winner && announcementAt != null && asOf >= announcementAt) {
      const clubName = clubDisplayName(winner.clubId, league);
      items.push({
        id: `bdo-coverage:${league.seasonMonth}:${winner.clubId}:${coverage.played}`,
        type: 'ballon_dor_spotlight',
        priority: 73,
        seasonMonth: league.seasonMonth,
        clubId: winner.clubId,
        clubName,
        badge: 'BALÓN DE ORO VERIFICADO',
        headline: `${clubName} celebra un Balón de Oro con muestra verificada`,
        subtitle: `${coverage.played} de ${coverage.total} partidos asentados · mínimo ${coverage.minimum}`,
        summary: `La edición ${league.seasonMonth} del Balón de Oro se cerró con ${coverage.played} de ${coverage.total} partidos regulares asentados (más del 90%) y archivo estadístico completo para los 16 candidatos. ${winner.playerName} es el ganador oficial.`,
        spoken: `El Balón de Oro ${league.seasonMonth} se entregó con ${coverage.played} de ${coverage.total} partidos verificados, superando el noventa por ciento exigido. ${clubName} celebra el premio de ${winner.playerName}.`
      });
    }
  }
  if (bd && Array.isArray(bd.candidates) && bd.candidates.length) {
    const ranked = bd.candidates
      .filter(c => c && (Number(c.stats?.goals) || 0) > 0)
      .slice()
      .sort((a, b) => (Number(b.stats?.goals) || 0) - (Number(a.stats?.goals) || 0)
        || (Number(b.stats?.assists) || 0) - (Number(a.stats?.assists) || 0)
        || String(a.playerId || '').localeCompare(String(b.playerId || '')));
    if (ranked.length) {
      const top = ranked[0];
      const clubName = clubDisplayName(top.clubId, league);
      const goals = Number(top.stats?.goals) || 0;
      const assists = Number(top.stats?.assists) || 0;
      items.push({
        id: `bdo:${league.seasonMonth}:${top.clubId}:${top.playerId}:${goals}`,
        type: 'ballon_dor_spotlight',
        priority: 72,
        seasonMonth: league.seasonMonth,
        clubId: top.clubId,
        clubName,
        badge: 'IMPACTO BALÓN DE ORO',
        headline: `${clubName} impulsa a ${top.playerName} al Balón de Oro`,
        subtitle: `${goals} goles y ${assists} asistencias verificadas`,
        summary: `El ataque de ${clubName} coloca a ${top.playerName} al frente de la carrera goleadora hacia el Balón de Oro con ${goals} tantos.`,
        spoken: `En la carrera por el Balón de Oro, ${clubName} presume a ${top.playerName} como referente ofensivo con ${goals} goles y ${assists} asistencias en la temporada.`
      });
      return items;
    }
  }

  const prevBd = previousLeague?.ballonDor;
  if (prevBd && prevBd.winnerPlayerId && Array.isArray(prevBd.candidates)) {
    const winner = prevBd.candidates.find(c => c.playerId === prevBd.winnerPlayerId);
    if (winner) {
      const currentClub = league?.config?.find(c => c.squad?.some(p => p.id === winner.playerId));
      const clubId = currentClub?.id || winner.clubId;
      const clubName = currentClub?.name || clubDisplayName(clubId, league || previousLeague);
      items.push({
        id: `bdo-holder:${previousLeague.seasonMonth}:${clubId}:${winner.playerId}`,
        type: 'ballon_dor_spotlight',
        priority: 70,
        seasonMonth: league?.seasonMonth || previousLeague.seasonMonth,
        clubId,
        clubName,
        badge: 'BALÓN DE ORO VIGENTE',
        headline: `${clubName} cuenta con el Balón de Oro ${winner.playerName}`,
        subtitle: `Coronado en la gala ${previousLeague.seasonMonth}`,
        summary: `${winner.playerName}, vigente ganador del Balón de Oro (${previousLeague.seasonMonth}), defiende los colores de ${clubName} esta campaña.`,
        spoken: `${clubName} salta a la cancha esta temporada con el vigente Balón de Oro, ${winner.playerName}, como estandarte ofensivo.`
      });
    }
  }
  return items;
}

// 6. Pulso público agregado e hitos colectivos de Mi afición (sin datos personales).
function buildFanPulseAnnouncement(league, fanRanking = []) {
  if (!league || !Array.isArray(fanRanking) || !fanRanking.length) return [];
  const items = [];
  const top = fanRanking[0];
  if (top && top.clubId && Number(top.wins) > 0 && Number(top.participants) > 0) {
    const clubName = clubDisplayName(top.clubId, league);
    items.push({
      id: `fan:${league.seasonMonth}:${top.clubId}:${top.wins}`,
      type: 'fan_pulse',
      priority: 58,
      seasonMonth: league.seasonMonth,
      clubId: top.clubId,
      clubName,
      badge: 'PULSO DE LA AFICIÓN',
      headline: `La hinchada de ${clubName} lidera las gradas`,
      subtitle: `${top.wins} victorias celebradas · ${top.participants} aficionad${top.participants === 1 ? 'o' : 'os'} en ranking público`,
      summary: `En la clasificación agregada de Mi afición, la grada de ${clubName} encabeza el aliento con ${top.wins} victorias acumuladas.`,
      spoken: `En las gradas del Estadio, la afición de ${clubName} marca el ritmo de apoyo colectivo con ${top.wins} victorias celebradas.`
    });
  }

  const milestoneRow = fanRanking.find(row => row && row.clubId && (Number(row.championFans) > 0 || Number(row.legendFans) > 0));
  if (milestoneRow) {
    const clubName = clubDisplayName(milestoneRow.clubId, league);
    const champCount = Math.max(0, Math.floor(Number(milestoneRow.championFans) || 0));
    const legendCount = Math.max(0, Math.floor(Number(milestoneRow.legendFans) || 0));
    if (champCount > 0) {
      items.push({
        id: `fan-milestone:${league.seasonMonth}:${milestoneRow.clubId}:champ:${champCount}`,
        type: 'fan_milestone',
        priority: 89,
        seasonMonth: league.seasonMonth,
        clubId: milestoneRow.clubId,
        clubName,
        badge: 'ESTRELLA EN LA GRADA',
        headline: `La afición de ${clubName} luce su estrella de campeón`,
        subtitle: `${champCount} aficionad${champCount === 1 ? 'o' : 'os'} con insignia de título oficial`,
        summary: `Quienes acompañaron a ${clubName} hasta conquistar la liga exhiben ya su distinción conmemorativa de campeón en el Estadio y el Casino.`,
        spoken: `Reconocimiento especial en las tribunas: la hinchada de ${clubName} presume su estrella oficial de campeón de liga.`
      });
    } else if (legendCount > 0) {
      items.push({
        id: `fan-milestone:${league.seasonMonth}:${milestoneRow.clubId}:legend:${legendCount}`,
        type: 'fan_milestone',
        priority: 78,
        seasonMonth: league.seasonMonth,
        clubId: milestoneRow.clubId,
        clubName,
        badge: 'TRIBUNA DE LEYENDA',
        headline: `Crece la tribuna de leyenda en ${clubName}`,
        subtitle: `${legendCount} aficionad${legendCount === 1 ? 'o' : 'os'} con rango de leyenda o superior`,
        summary: `La constancia en las gradas de ${clubName} suma ya ${legendCount} seguidor${legendCount === 1 ? '' : 'es'} en los escalones altos de lealtad.`,
        spoken: `Fidelidad probada en las gradas: ${clubName} celebra una tribuna de leyenda cada vez más numerosa.`
      });
    }
  }
  return items;
}

function buildClubNews({ league, previousLeague = null, at = Date.now(), fanRanking = [] } = {}) {
  if (!league || !Array.isArray(league.config) || !league.config.length) return [];
  const asOf = Number.isFinite(at) ? at : Infinity;
  const collected = [
    ...buildCoachChangeAnnouncements(league, previousLeague, asOf),
    ...buildHonorsAndPrestigeAnnouncements(league, previousLeague, asOf),
    ...buildTacticalShiftAnnouncements(league, asOf),
    ...buildCompetitiveFormAnnouncements(league, asOf),
    ...buildBallonDorClubAnnouncement(league, previousLeague, asOf),
    ...buildFanPulseAnnouncement(league, fanRanking)
  ];

  const seenIds = new Set();
  return collected
    .filter(item => {
      if (!item || !item.id || seenIds.has(item.id)) return false;
      seenIds.add(item.id);
      return true;
    })
    .sort((a, b) => (b.priority - a.priority) || a.id.localeCompare(b.id))
    .slice(0, 8);
}

// Clave de edición para abrir automáticamente MonteCristo News cuando debutan
// nuevos DT al inicio de una temporada nueva (sin tocar traspasosNewsSeen del día 15).
function openingEditionKey(league, clubNews = []) {
  if (!league?.seasonMonth || !Array.isArray(clubNews)) return null;
  const hasNewSeasonCoachHiring = clubNews.some(item => item && item.type === 'coach_change' && item.id.startsWith(`coach-hired:${league.seasonMonth}:`));
  const hasChampion = clubNews.some(item => item && item.type === 'season_champion');
  if (!hasNewSeasonCoachHiring && !hasChampion) return null;
  return `${league.seasonMonth}:apertura`;
}

module.exports = {
  STYLE_LABELS,
  FOCUS_LABELS,
  CLUB_NEWS_TYPES,
  CLUB_IMPACT_REGISTRY,
  NON_CLUB_NEWS_MODULES,
  verifiedSeasonChampion,
  buildClubNews,
  openingEditionKey
};
