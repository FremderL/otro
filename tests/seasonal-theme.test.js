'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_SEASONAL_THEME,
  DEFAULT_MONTHS,
  SEASONAL_MONTHS,
  SEASONAL_PRESETS,
  normalizeSeasonalTheme,
  resolveSeasonalTheme,
  cleanStoredSeasonalTheme,
  nextMonthBoundary
} = require('../lib/seasonal-theme');

function monthlyInput(overrides = {}) {
  return {
    enabled: true,
    rotation: 'monthly',
    months: DEFAULT_MONTHS.map(item => ({ ...item })),
    startAt: null,
    endAt: null,
    ...overrides
  };
}

test('catálogo anual contiene doce presets únicos y permanece apagado por defecto', () => {
  assert.equal(DEFAULT_SEASONAL_THEME.enabled, false);
  assert.equal(DEFAULT_SEASONAL_THEME.rotation, 'monthly');
  assert.equal(SEASONAL_MONTHS.length, 12);
  assert.equal(DEFAULT_MONTHS.length, 12);
  assert.deepEqual(DEFAULT_MONTHS.map(item => item.month), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal(new Set(DEFAULT_MONTHS.map(item => item.presetId)).size, 12);
  for (const month of SEASONAL_MONTHS) {
    assert.ok(SEASONAL_PRESETS[month.defaultPresetId], `falta el preset de ${month.label}`);
    assert.equal(SEASONAL_PRESETS[month.defaultPresetId].month, month.month);
  }
  assert.equal(SEASONAL_PRESETS.valentines.label, 'Noche de los corazones');
  assert.equal(resolveSeasonalTheme(DEFAULT_SEASONAL_THEME).active, false);
});

test('normalizador exige doce meses únicos y limita diseños, animaciones, intensidad y fechas', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  const input = monthlyInput({
    startAt: '2026-10-15T00:00:00Z',
    endAt: '2026-11-01T00:00:00Z'
  });
  const valid = normalizeSeasonalTheme(input, { now, actorId: 'admin-1', timeZone: 'UTC' });
  assert.equal(valid.ok, true);
  assert.equal(valid.theme.updatedBy, 'admin-1');
  assert.equal(valid.theme.months.length, 12);
  assert.equal(valid.theme.months[9].month, 10);

  assert.equal(normalizeSeasonalTheme({ ...input, months: input.months.slice(0, 11) }).ok, false);
  const duplicateMonth = input.months.map(item => ({ ...item }));
  duplicateMonth[1].month = duplicateMonth[0].month;
  assert.match(normalizeSeasonalTheme({ ...input, months: duplicateMonth }).error, /única/);
  const invalidPreset = input.months.map(item => ({ ...item }));
  invalidPreset[9].presetId = 'external-css';
  assert.match(normalizeSeasonalTheme({ ...input, months: invalidPreset }).error, /diseño/);
  const invalidAnimation = input.months.map(item => ({ ...item }));
  invalidAnimation[9].animation = 'javascript:alert(1)';
  assert.match(normalizeSeasonalTheme({ ...input, months: invalidAnimation }).error, /animación/);
  const invalidIntensity = input.months.map(item => ({ ...item }));
  invalidIntensity[9].intensity = 'blinding';
  assert.match(normalizeSeasonalTheme({ ...input, months: invalidIntensity }).error, /intensidad/);
  assert.equal(normalizeSeasonalTheme({ ...input, rotation: 'weekly' }).ok, false);
  assert.equal(normalizeSeasonalTheme({ ...input, endAt: input.startAt }).ok, false);
  assert.equal(normalizeSeasonalTheme({ ...input, startAt: '<svg>' }).ok, false);
});

test('la resolución usa el diseño del mes y programa cambios por el calendario indicado', () => {
  const months = DEFAULT_MONTHS.map(item => ({ ...item }));
  months[11] = { month: 12, presetId: 'christmas', animation: 'none', intensity: 'festive', enabled: true };
  const normalized = normalizeSeasonalTheme(monthlyInput({
    months,
    startAt: '2026-12-01T00:00:00Z',
    endAt: '2027-01-01T00:00:00Z'
  }), { now: Date.parse('2026-10-01T00:00:00Z'), timeZone: 'UTC' });
  assert.equal(normalized.ok, true);

  const before = resolveSeasonalTheme(normalized.theme, Date.parse('2026-11-30T23:59:59Z'), 'UTC');
  assert.equal(before.active, false);
  assert.equal(before.calendarMonth, 11);
  assert.equal(before.refreshAt, Date.parse('2026-12-01T00:00:00Z'));

  const active = resolveSeasonalTheme(normalized.theme, Date.parse('2026-12-24T12:00:00Z'), 'UTC');
  assert.equal(active.active, true);
  assert.equal(active.calendarMonth, 12);
  assert.equal(active.monthLabel, 'Diciembre');
  assert.equal(active.theme.id, 'christmas');
  assert.equal(active.theme.animation, 'none');
  assert.equal(active.theme.intensity, 'festive');
  assert.equal(active.refreshAt, Date.parse('2027-01-01T00:00:00Z'));
  assert.equal(resolveSeasonalTheme(normalized.theme, Date.parse('2027-01-01T00:00:00Z'), 'UTC').active, false);
});

test('el cambio de mes respeta medianoche de Ciudad de México, no el UTC del servidor', () => {
  const config = normalizeSeasonalTheme(monthlyInput(), { now: Date.parse('2026-11-01T00:00:00Z'), timeZone: 'America/Mexico_City' }).theme;
  const oneSecondBefore = resolveSeasonalTheme(config, Date.parse('2026-12-01T05:59:59Z'), 'America/Mexico_City');
  assert.equal(oneSecondBefore.calendarMonth, 11);
  assert.equal(oneSecondBefore.monthLabel, 'Noviembre');
  assert.equal(oneSecondBefore.refreshAt, Date.parse('2026-12-01T06:00:00Z'));
  const atBoundary = resolveSeasonalTheme(config, Date.parse('2026-12-01T06:00:00Z'), 'America/Mexico_City');
  assert.equal(atBoundary.calendarMonth, 12);
  assert.equal(atBoundary.theme.id, 'christmas');
  assert.equal(atBoundary.refreshAt, Date.parse('2027-01-01T06:00:00Z'));
  assert.equal(nextMonthBoundary(new Date('2026-12-01T05:59:59Z'), 'America/Mexico_City'), Date.parse('2026-12-01T06:00:00Z'));
});

test('migra el tema único heredado al mes de la actualización y limpia datos almacenados inválidos', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const legacy = normalizeSeasonalTheme({ enabled: true, presetId: 'halloween', animation: 'embers', intensity: 'festive' }, { now, timeZone: 'UTC' });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.theme.months[9].presetId, 'halloween');
  assert.equal(legacy.theme.months[9].animation, 'embers');
  assert.equal(legacy.theme.months[9].intensity, 'festive');
  assert.equal(legacy.theme.months[0].presetId, 'newyear');

  const migrated = cleanStoredSeasonalTheme({ enabled: true, presetId: 'halloween', animation: 'embers', intensity: 'festive', updatedAt: now }, { timeZone: 'UTC' });
  assert.equal(migrated.months[9].presetId, 'halloween');
  assert.equal(migrated.enabled, true);
  const unsafe = cleanStoredSeasonalTheme({ enabled: true, presetId: 'evil', updatedAt: now }, { timeZone: 'UTC' });
  assert.equal(unsafe.enabled, false);
  assert.equal(unsafe.months.length, 12);
});

test('zona horaria de despliegue inválida usa UTC como fallback seguro', () => {
  const config = normalizeSeasonalTheme(monthlyInput(), { now: Date.parse('2026-01-01T00:00:00Z'), timeZone: 'UTC' }).theme;
  const resolved = resolveSeasonalTheme(config, Date.parse('2026-01-31T23:59:59Z'), 'not/a-real-zone');
  assert.equal(resolved.calendarMonth, 1);
  assert.equal(resolved.refreshAt, Date.parse('2026-02-01T00:00:00Z'));
});
