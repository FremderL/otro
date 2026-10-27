'use strict';

const { BALLON_DOR_MARKET } = require('./ballon-dor-market');

// Predicciones del Balón de Oro no deben detener el reinicio mensual del casino:
// el servicio las cierra o las recupera alrededor del reset. Las apuestas de
// partido y combinadas mantienen la protección de escrow que ya tenía el Estadio.
function footballSeasonResetGate(store, fromMonth) {
  if (!store) return null;

  const openBets = store.hasOpenBets({ seasonMonth: fromMonth });
  const openParlays = store.getParlays({ status: 'open' })
    .some(parlay => parlay.seasonMonth === fromMonth);
  const openFutures = store.getOpenFutures(fromMonth)
    .some(future => future.market !== BALLON_DOR_MARKET);

  if (openBets || openParlays || openFutures) {
    return { type: 'deferred', reason: 'apuestas_de_futbol_abiertas' };
  }
  return null;
}

module.exports = { footballSeasonResetGate };
