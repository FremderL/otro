'use strict';

const { CASINO_TIME_ZONE, calendarParts } = require('./profile-store-shared');

const SEASONAL_MONTHS = Object.freeze([
  Object.freeze({ month: 1, id: 'january', label: 'Enero', defaultPresetId: 'newyear' }),
  Object.freeze({ month: 2, id: 'february', label: 'Febrero', defaultPresetId: 'valentines' }),
  Object.freeze({ month: 3, id: 'march', label: 'Marzo', defaultPresetId: 'spring' }),
  Object.freeze({ month: 4, id: 'april', label: 'Abril', defaultPresetId: 'rainy-night' }),
  Object.freeze({ month: 5, id: 'may', label: 'Mayo', defaultPresetId: 'flower-moon' }),
  Object.freeze({ month: 6, id: 'june', label: 'Junio', defaultPresetId: 'solstice' }),
  Object.freeze({ month: 7, id: 'july', label: 'Julio', defaultPresetId: 'firefly-garden' }),
  Object.freeze({ month: 8, id: 'august', label: 'Agosto', defaultPresetId: 'starfall' }),
  Object.freeze({ month: 9, id: 'september', label: 'Septiembre', defaultPresetId: 'fiesta-patria' }),
  Object.freeze({ month: 10, id: 'october', label: 'Octubre', defaultPresetId: 'halloween' }),
  Object.freeze({ month: 11, id: 'november', label: 'Noviembre', defaultPresetId: 'dia-muertos' }),
  Object.freeze({ month: 12, id: 'december', label: 'Diciembre', defaultPresetId: 'christmas' })
]);

const PRESET_LIST = [
  { id: 'newyear', month: 1, label: 'Brindis dorado', symbol: '✧', particle: '✦', accent: '#e8c978', animation: 'sparkles', decoration: 'destellos de oro, estrellas y confeti de medianoche' },
  { id: 'valentines', month: 2, label: 'Noche de los corazones', symbol: '♥', particle: '♥', accent: '#ef88a7', animation: 'hearts', decoration: 'corazones de terciopelo y luces rosa rubí' },
  { id: 'spring', month: 3, label: 'Jardín de primavera', symbol: '✿', particle: '✿', accent: '#9bd58d', animation: 'petals', decoration: 'pétalos frescos, hojas nuevas y rocío' },
  { id: 'rainy-night', month: 4, label: 'Lluvia de cristal', symbol: '☂', particle: '⋰', accent: '#83c6e5', animation: 'rain', decoration: 'gotas de cristal, reflejos azul noche y neblina ligera' },
  { id: 'flower-moon', month: 5, label: 'Luna de flores', symbol: '✾', particle: '✿', accent: '#e99bba', animation: 'petals', decoration: 'flores nocturnas, pétalos rosados y luz de luna' },
  { id: 'solstice', month: 6, label: 'Solsticio esmeralda', symbol: '☼', particle: '✧', accent: '#edb56b', animation: 'fireflies', decoration: 'resplandor cálido, luciérnagas y hojas de verano' },
  { id: 'firefly-garden', month: 7, label: 'Jardín de luciérnagas', symbol: '☾', particle: '✦', accent: '#83d7b5', animation: 'fireflies', decoration: 'luciérnagas verdes, jazmín y cielo profundo' },
  { id: 'starfall', month: 8, label: 'Lluvia de estrellas', symbol: '☄', particle: '✦', accent: '#a99af0', animation: 'meteor', decoration: 'estrellas fugaces, violeta cósmico y polvo lunar' },
  { id: 'fiesta-patria', month: 9, label: 'Noche tricolor', symbol: '✷', particle: '✦', accent: '#69c896', animation: 'confetti', decoration: 'papel picado, cintas festivas y acentos verde esmeralda' },
  { id: 'halloween', month: 10, label: 'Noche de Halloween', symbol: '☾', particle: '✦', accent: '#f29a57', animation: 'embers', decoration: 'calabazas, hojas y luz ámbar misteriosa' },
  { id: 'dia-muertos', month: 11, label: 'Altar de cempasúchil', symbol: '✿', particle: '❋', accent: '#f1a34c', animation: 'marigold', decoration: 'cempasúchil, velas y caminos de luz dorada' },
  { id: 'christmas', month: 12, label: 'Invierno esmeralda', symbol: '✦', particle: '❄', accent: '#b9dfd1', animation: 'snow', decoration: 'nieve suave, pinos y luces verde esmeralda' }
];
const SEASONAL_PRESETS = Object.freeze(Object.fromEntries(PRESET_LIST.map(preset => [preset.id, Object.freeze(preset)])));

const SEASONAL_ANIMATIONS = Object.freeze([
  { id: 'auto', label: 'Automática según la temporada' },
  { id: 'none', label: 'Sin animación' },
  { id: 'embers', label: 'Brasas flotantes' },
  { id: 'snow', label: 'Nieve suave' },
  { id: 'hearts', label: 'Corazones' },
  { id: 'petals', label: 'Pétalos' },
  { id: 'sparkles', label: 'Destellos' },
  { id: 'rain', label: 'Lluvia de cristal' },
  { id: 'fireflies', label: 'Luciérnagas' },
  { id: 'meteor', label: 'Estrellas fugaces' },
  { id: 'confetti', label: 'Papel picado y confeti' },
  { id: 'marigold', label: 'Flores de cempasúchil' }
]);

const DEFAULT_MONTHS = Object.freeze(SEASONAL_MONTHS.map(({ month, defaultPresetId }) => Object.freeze({
  month,
  presetId: defaultPresetId,
  animation: 'auto',
  intensity: 'subtle',
  enabled: true
})));

const DEFAULT_SEASONAL_THEME = Object.freeze({
  enabled: false,
  rotation: 'monthly',
  months: DEFAULT_MONTHS,
  startAt: null,
  endAt: null,
  updatedAt: null,
  updatedBy: null
});

const PRESET_IDS = new Set(Object.keys(SEASONAL_PRESETS));
const ANIMATION_IDS = new Set(SEASONAL_ANIMATIONS.map(option => option.id));
const MONTH_LABELS = new Map(SEASONAL_MONTHS.map(item => [item.month, item.label]));

function cloneDefaultMonths() { return DEFAULT_MONTHS.map(item => ({ ...item })); }

function parseDate(value, fieldName) {
  if (value == null || value === '') return { value: null, error: null };
  if (typeof value !== 'string' || value.length > 40) return { value: null, error: `${fieldName} no tiene un formato válido.` };
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return { value: null, error: `${fieldName} no tiene un formato válido.` };
  return { value: new Date(milliseconds).toISOString(), error: null };
}

function validMonthConfig(value, month) {
  const defaultConfig = DEFAULT_MONTHS[month - 1];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...defaultConfig };
  const presetId = String(value.presetId || '');
  const animation = String(value.animation || 'auto');
  const intensity = String(value.intensity || 'subtle');
  return {
    month,
    presetId: PRESET_IDS.has(presetId) ? presetId : defaultConfig.presetId,
    animation: ANIMATION_IDS.has(animation) ? animation : 'auto',
    intensity: ['subtle', 'festive'].includes(intensity) ? intensity : 'subtle',
    enabled: value.enabled !== false
  };
}

function legacyMonths(input, now, timeZone) {
  const months = cloneDefaultMonths();
  const legacyPresetId = String(input?.presetId || '');
  if (!PRESET_IDS.has(legacyPresetId)) return months;
  const month = Number(calendarParts(new Date(now), timeZone).month) || 1;
  months[month - 1] = {
    month,
    presetId: legacyPresetId,
    animation: ANIMATION_IDS.has(String(input.animation || 'auto')) ? String(input.animation || 'auto') : 'auto',
    intensity: ['subtle', 'festive'].includes(input.intensity) ? input.intensity : 'subtle',
    enabled: true
  };
  return months;
}

function normalizeSeasonalTheme(input, { now = Date.now(), actorId = null, timeZone = CASINO_TIME_ZONE } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'La configuración estacional no es válida.' };
  }
  if (typeof input.enabled !== 'boolean') return { ok: false, error: 'Indica si la rotación estacional está activa.' };
  if (input.rotation != null && input.rotation !== 'monthly') {
    return { ok: false, error: 'La rotación disponible es mensual.' };
  }

  let months;
  if (Array.isArray(input.months)) {
    if (input.months.length !== 12) return { ok: false, error: 'Configura los doce meses antes de guardar.' };
    const byMonth = new Map();
    for (const item of input.months) {
      const month = Number(item?.month);
      if (!Number.isInteger(month) || month < 1 || month > 12 || byMonth.has(month)) {
        return { ok: false, error: 'Cada mes debe tener una configuración única del 1 al 12.' };
      }
      if (!PRESET_IDS.has(String(item?.presetId || ''))) return { ok: false, error: `Elige un diseño disponible para ${MONTH_LABELS.get(month)}.` };
      if (!ANIMATION_IDS.has(String(item?.animation || 'auto'))) return { ok: false, error: `La animación de ${MONTH_LABELS.get(month)} no está disponible.` };
      if (!['subtle', 'festive'].includes(String(item?.intensity || 'subtle'))) return { ok: false, error: `La intensidad de ${MONTH_LABELS.get(month)} no es válida.` };
      byMonth.set(month, validMonthConfig(item, month));
    }
    months = SEASONAL_MONTHS.map(({ month }) => byMonth.get(month));
  } else {
    // Migra la configuración de tema único usada por la primera versión: se
    // conserva en el mes de la migración, y los otros meses toman su preset anual.
    months = legacyMonths(input, now, timeZone);
  }

  const start = parseDate(input.startAt, 'La fecha de inicio');
  const end = parseDate(input.endAt, 'La fecha de fin');
  if (start.error || end.error) return { ok: false, error: start.error || end.error };
  if (start.value && end.value && Date.parse(end.value) <= Date.parse(start.value)) {
    return { ok: false, error: 'La fecha de fin debe ser posterior a la de inicio.' };
  }

  return {
    ok: true,
    theme: {
      enabled: input.enabled,
      rotation: 'monthly',
      months,
      startAt: start.value,
      endAt: end.value,
      updatedAt: Number(now) || Date.now(),
      updatedBy: typeof actorId === 'string' ? actorId.slice(0, 80) : null
    }
  };
}

function cleanStoredSeasonalTheme(value, options = {}) {
  const isLegacyConfiguration = !Array.isArray(value?.months);
  if (isLegacyConfiguration && value?.enabled === true && !PRESET_IDS.has(String(value?.presetId || ''))) {
    return { ...DEFAULT_SEASONAL_THEME, months: cloneDefaultMonths() };
  }
  const result = normalizeSeasonalTheme({
    enabled: value?.enabled === true,
    rotation: 'monthly',
    months: value?.months,
    presetId: value?.presetId,
    animation: value?.animation,
    intensity: value?.intensity,
    startAt: value?.startAt,
    endAt: value?.endAt
  }, {
    now: Number(value?.updatedAt) || Date.now(),
    actorId: value?.updatedBy || null,
    ...options
  });
  return result.ok ? result.theme : {
    ...DEFAULT_SEASONAL_THEME,
    months: cloneDefaultMonths()
  };
}

function timeZoneOffsetMs(utcMs, timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    const parts = Object.fromEntries(formatter.formatToParts(new Date(utcMs))
      .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
    return asIfUtc - utcMs;
  } catch (_) {
    // calendarParts uses the same UTC fallback for an invalid deployment zone.
    return 0;
  }
}

function zonedTimeToMs({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone = CASINO_TIME_ZONE) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const candidate = utcGuess - timeZoneOffsetMs(utcGuess, timeZone);
  return utcGuess - timeZoneOffsetMs(candidate, timeZone);
}

function nextMonthBoundary(date, timeZone = CASINO_TIME_ZONE) {
  const { year, month } = calendarParts(date, timeZone);
  let nextYear = Number(year);
  let nextMonth = Number(month) + 1;
  if (nextMonth > 12) { nextMonth = 1; nextYear += 1; }
  return zonedTimeToMs({ year: nextYear, month: nextMonth, day: 1 }, timeZone);
}

function resolveSeasonalTheme(value, now = Date.now(), timeZone = CASINO_TIME_ZONE) {
  const config = cleanStoredSeasonalTheme(value, { now, timeZone });
  const { year, month: monthText } = calendarParts(new Date(now), timeZone);
  const month = Number(monthText) || 1;
  const monthKeyValue = `${year}-${String(month).padStart(2, '0')}`;
  const monthLabel = MONTH_LABELS.get(month) || 'Temporada';
  const nextBoundary = nextMonthBoundary(new Date(now), timeZone);
  const startAt = config.startAt ? Date.parse(config.startAt) : null;
  const endAt = config.endAt ? Date.parse(config.endAt) : null;
  const inactive = (refreshAt = null) => ({
    active: false,
    theme: null,
    refreshAt,
    calendarMonth: month,
    monthLabel,
    monthKey: monthKeyValue,
    timeZone
  });

  if (!config.enabled) return inactive();
  if (startAt != null && now < startAt) return inactive(Math.min(startAt, nextBoundary));
  if (endAt != null && now >= endAt) return inactive(null);

  const monthConfig = config.months[month - 1] || DEFAULT_MONTHS[month - 1];
  const preset = SEASONAL_PRESETS[monthConfig.presetId];
  const nextRefresh = endAt != null ? Math.min(nextBoundary, endAt) : nextBoundary;
  if (!monthConfig.enabled || !preset) return inactive(nextRefresh);

  return {
    active: true,
    calendarMonth: month,
    monthLabel,
    monthKey: monthKeyValue,
    timeZone,
    theme: {
      id: preset.id,
      label: preset.label,
      symbol: preset.symbol,
      particle: preset.particle,
      accent: preset.accent,
      decoration: preset.decoration,
      animation: monthConfig.animation === 'auto' ? preset.animation : monthConfig.animation,
      intensity: monthConfig.intensity,
      seasonMonth: month,
      monthLabel,
      monthKey: monthKeyValue,
      startAt: config.startAt,
      endAt: config.endAt
    },
    refreshAt: nextRefresh
  };
}

module.exports = {
  SEASONAL_MONTHS,
  SEASONAL_PRESETS,
  SEASONAL_ANIMATIONS,
  DEFAULT_MONTHS,
  DEFAULT_SEASONAL_THEME,
  normalizeSeasonalTheme,
  cleanStoredSeasonalTheme,
  resolveSeasonalTheme,
  nextMonthBoundary,
  zonedTimeToMs
};
