'use strict';

const { BALLON_DOR_MARKET } = require('./ballon-dor-market');

// Predicciones del Balón de Oro no deben detener el reinicio mensual del casino:
// el servicio las cierra o las recupera alrededor del reset. Las apuestas de
// partido y combinadas mantienen la protección de escrow que ya tenía el Estadio.
function footballSeasonResetGate(store, fromMonth) {
  if (!store) return null;

  const terminal = new Set(['won', 'lost', 'void', 'cashed']);
  const bets = store.getBets?.({}) || [];
  const parlays = store.getParlays({});
  const futures = store.getFutures?.({ seasonMonth: fromMonth }) || store.getOpenFutures(fromMonth);
  // Los boletos nuevos llevan temporada propia; en los anteriores se recupera
  // del partido o de su id. Si faltan ambos, no se descarta una deuda desconocida.
  const belongs = bet => {
    const season = bet.seasonMonth || store.getMatch?.(bet.matchId)?.seasonMonth
      || /^m_(\d{4}-(?:0[1-9]|1[0-2]))_/.exec(String(bet.matchId || ''))?.[1];
    return !season || season === fromMonth;
  };
  const pendingPayment = bets.some(bet => bet.payoutApplied === false && terminal.has(bet.status) && belongs(bet))
    || parlays.some(parlay => parlay.seasonMonth === fromMonth && parlay.payoutApplied === false && terminal.has(parlay.status))
    || futures.some(future => future.market !== BALLON_DOR_MARKET && future.escrowProtocol === 'durable-1'
      && future.payoutApplied === false && terminal.has(future.status));
  if (pendingPayment) {
    // Forzar el reset mientras el perfil y el boleto difieren podría borrar un
    // pago ya acreditado o hacerlo irrepetible. Primero debe reconciliarse.
    return { type: 'deferred', reason: 'pagos_de_futbol_pendientes', requireSettlement: true };
  }

  const openBets = bets.some(bet => ['pending', 'open'].includes(bet.status) && belongs(bet))
    || store.hasOpenBets({ seasonMonth: fromMonth });
  const openParlays = parlays.some(parlay => (!parlay.seasonMonth || parlay.seasonMonth === fromMonth)
    && ['pending', 'open'].includes(parlay.status));
  const openFutures = futures.some(future => future.market !== BALLON_DOR_MARKET && (!future.status || ['pending', 'open'].includes(future.status)));

  if (openBets || openParlays || openFutures) {
    // El límite ordinario no debe borrar stakes o compromisos aún abiertos.
    return { type: 'deferred', reason: 'apuestas_de_futbol_abiertas', requireSettlement: true };
  }
  return null;
}

module.exports = { footballSeasonResetGate };
