'use strict';

// Exclusión por temporada dentro del proceso: una apuesta de temporada y la
// preparación de un partido no pueden adelantarse mutuamente durante un await.
// No sustituye transacciones/bloqueos compartidos entre procesos de servidor.
const queues = new WeakMap();
function withSeasonAdmission(store, seasonMonth, work) {
  if (!store || typeof work !== 'function') return Promise.reject(new Error('admisión inválida'));
  let seasons = queues.get(store);
  if (!seasons) { seasons = new Map(); queues.set(store, seasons); }
  const key = String(seasonMonth || '');
  const prior = seasons.get(key) || Promise.resolve();
  const operation = prior.catch(() => {}).then(work);
  const tail = operation.finally(() => { if (seasons.get(key) === tail) seasons.delete(key); });
  seasons.set(key, tail);
  return tail;
}
module.exports = { withSeasonAdmission };
