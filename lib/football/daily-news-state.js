'use strict';

// Normalización común JSON/PG del archivo editorial. Separada del generador
// para no introducir un ciclo store-shared → noticias → store-shared.
const LIMIT = 45;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
function emptyDailyNewsState() { return { version: 1, editions: {}, operational: {} }; }
function validDay(value) {
  return typeof value === 'string' && DAY.test(value)
    && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
    && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}
function cleanEdition(raw) {
  if (!raw || raw.version !== 1 || !validDay(raw.day) || raw.id !== `daily:${raw.day}`) return null;
  if (!Number.isSafeInteger(raw.generatedAt) || !Number.isSafeInteger(raw.cutoffAt) || raw.cutoffAt !== raw.generatedAt) return null;
  if (!['daily', 'return'].includes(raw.mode) || typeof raw.timeZone !== 'string') return null;
  try { Intl.DateTimeFormat('es-MX', { timeZone: raw.timeZone }); } catch (_) { return null; }
  if (!Array.isArray(raw.items) || !raw.items.length || raw.items.length > 7
    || !Array.isArray(raw.clubNews) || raw.clubNews.length > 8
    || !Array.isArray(raw.script) || raw.script.length > 9 || !raw.script.length) return null;
  if (raw.script.some(line => !line || !['narrador', 'analista'].includes(line.role)
    || typeof line.text !== 'string' || !line.text || line.text.length > 1200)) return null;
  const ids = new Set(raw.items.map(item => item?.id));
  if (ids.size !== raw.items.length || raw.script.some(line => line.itemId != null && !ids.has(line.itemId))) return null;
  if (raw.items.some(item => !item || typeof item.id !== 'string' || typeof item.type !== 'string'
    || typeof item.headline !== 'string' || typeof item.summary !== 'string' || typeof item.spoken !== 'string')) return null;
  if (!raw.coverage || !raw.market || !raw.table || !Array.isArray(raw.table.rows)) return null;
  const text = JSON.stringify(raw);
  if (text.length > 160000) return null;
  // Solo lo genera el servidor. No se aceptan objetos de perfil ni claves de
  // simulación en esta proyección editorial pública.
  if (/"(?:profileId|deviceToken|privateSeed|rootSeed|passwordHash|simulation)"/.test(text)) return null;
  return JSON.parse(text);
}
function cleanDailyNewsState(raw) {
  const out = emptyDailyNewsState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const source = raw.editions && typeof raw.editions === 'object' ? raw.editions : {};
  for (const day of Object.keys(source).sort().slice(-LIMIT)) {
    if (!validDay(day)) continue;
    const edition = cleanEdition(source[day]);
    if (edition) out.editions[day] = edition;
  }
  const op = raw.operational || {};
  out.operational = {
    lastReadyDay: validDay(op.lastReadyDay) ? op.lastReadyDay : null,
    lastReadyAt: Number.isSafeInteger(op.lastReadyAt) && op.lastReadyAt > 0 ? op.lastReadyAt : null
  };
  return out;
}
module.exports = { cleanDailyNewsState, emptyDailyNewsState, validDay, EDITION_LIMIT: LIMIT };
