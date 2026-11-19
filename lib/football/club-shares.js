'use strict';

// Cartera de acciones de la Casa Montecristo en el perfil del usuario.
//
// Vive en su propio módulo, sin dependencias, por una razón concreta: lo necesita
// la normalización del perfil (lib/profile-store-shared.js), que se carga en el
// arranque de TODO el servidor. Si esto viviera en club-stock.js, ese archivo
// arrastraría player-value y el motor de plantillas al camino crítico de arranque
// y además crearía un ciclo perfil → fútbol → perfil.

const MAX_SHARES_PER_CLUB = 200;
const MAX_SHARES_TOTAL = 600;

// Cartera normalizada: acciones enteras, sin clubes desconocidos y con los topes
// aplicados. Cualquier dato viejo o manipulado degrada aquí, no en la UI.
function cleanClubShares(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  let total = 0;
  for (const key of Object.keys(source).slice(0, 32)) {
    const entry = source[key];
    const shares = Math.max(0, Math.floor(Number(entry?.shares) || 0));
    if (!shares) continue;
    if (total >= MAX_SHARES_TOTAL) break;
    const allowed = Math.min(shares, MAX_SHARES_PER_CLUB, MAX_SHARES_TOTAL - total);
    out[String(key).slice(0, 40)] = {
      shares: allowed,
      costChips: Math.max(0, Math.floor(Number(entry?.costChips) || 0)),
      updatedAt: Number(entry?.updatedAt) || 0
    };
    total += allowed;
  }
  return out;
}

function sharesTotal(holdings) {
  return Object.values(cleanClubShares(holdings)).reduce((sum, entry) => sum + entry.shares, 0);
}

module.exports = { MAX_SHARES_PER_CLUB, MAX_SHARES_TOTAL, cleanClubShares, sharesTotal };
