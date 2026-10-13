'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { DEFAULT_MONTHS, SEASONAL_MONTHS, SEASONAL_PRESETS, SEASONAL_ANIMATIONS } = require('../lib/seasonal-theme');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.css'), 'utf8');

test('panel anual permite seleccionar y personalizar los doce meses con vista previa', () => {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const tab = document.querySelector('[data-tab="seasons"]');
  const panel = document.getElementById('seasonal-theme-panel');
  assert.equal(tab.hidden, true, 'la navegación nace cerrada hasta que el servidor confirma el rol admin');
  assert.ok(tab.hasAttribute('data-admin-only'));
  assert.ok(panel.classList.contains('hidden'));
  assert.equal(document.getElementById('seasonal-month-grid').getAttribute('role'), 'group');
  assert.equal(document.getElementById('seasonal-theme-month').value, '1');
  assert.ok(document.getElementById('seasonal-theme-enabled'));
  assert.ok(document.getElementById('seasonal-theme-month-enabled'));
  assert.equal(document.getElementById('seasonal-theme-preset').options.length, 0, 'el catálogo se carga desde la lista validada del servidor');
  assert.equal(document.getElementById('seasonal-theme-start').type, 'datetime-local');
  assert.equal(document.getElementById('seasonal-theme-end').type, 'datetime-local');
  assert.ok(document.getElementById('seasonal-theme-preview'));
  assert.equal(SEASONAL_MONTHS.length, 12);
  assert.equal(Object.keys(SEASONAL_PRESETS).length, 12);
  assert.match(script, /response\.months/);
  assert.match(script, /response\.presets/);
  assert.match(script, /data-seasonal-month/);
  assert.match(script, /months: seasonalMonthConfigs/);
  assert.match(script, /rotation: 'monthly'/);
  assert.match(script, /\/api\/admin\/v1\/seasonal-theme/);
  assert.match(script, /X-CSRF-Token/);
  assert.match(css, /\.seasonal-month-grid/);
  assert.match(css, /prefers-reduced-motion/);
  for (const preset of Object.keys(SEASONAL_PRESETS)) {
    assert.ok(css.includes(`data-theme="${preset}"`), `falta el estilo de ${preset}`);
  }
  dom.window.close();
});

test('editor estacional conserva cambios por mes y publica los doce diseños', async () => {
  const dom = new JSDOM(html, { url: 'https://casino.test/admin', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const initialConfiguration = { enabled: true, rotation: 'monthly', months: DEFAULT_MONTHS.map(item => ({ ...item })), startAt: null, endAt: null };
  const requests = [];
  Object.defineProperty(window.crypto, 'randomUUID', { value: () => 'seasonal-ui-idempotency' });
  window.fetch = async (url, options = {}) => {
    const route = String(url);
    requests.push({ route, options });
    let body = { ok: true };
    if (route === '/api/auth/session') {
      body = { ok: true, csrfToken: 'csrf-test', auth: { staff: true, mfaEnrollmentRequired: false, mfaVerified: true } };
    } else if (route === '/api/admin/v1/me') {
      body = { ok: true, staff: { name: 'Administración', username: 'admin', role: 'admin' } };
    } else if (route === '/api/admin/v1/seasonal-theme' && options.method === 'PUT') {
      body = { ok: true, configuration: JSON.parse(options.body), preview: { active: true } };
    } else if (route === '/api/admin/v1/seasonal-theme') {
      body = {
        ok: true,
        configuration: initialConfiguration,
        preview: { active: true, calendarMonth: 3, timeZone: 'America/Mexico_City' },
        calendarMonth: 3,
        months: SEASONAL_MONTHS,
        presets: Object.values(SEASONAL_PRESETS),
        animations: SEASONAL_ANIMATIONS
      };
    } else if (route === '/admin/estadio/matches') {
      body = { ok: true, teams: {}, matches: [] };
    } else if (route === '/admin/estadio/promotions') {
      body = { ok: true, promotions: [], activePromotions: [] };
    } else if (route.startsWith('/api/admin/v1/reports')) {
      body = { ok: true, reports: [] };
    }
    return { status: 200, ok: true, json: async () => body };
  };

  window.eval(script);
  await new Promise(resolve => window.setTimeout(resolve, 60));
  const document = window.document;
  assert.equal(document.querySelectorAll('#seasonal-month-grid [data-seasonal-month]').length, 12);
  assert.equal(document.getElementById('seasonal-calendar-current').textContent.includes('Marzo'), true);
  document.querySelector('#seasonal-month-grid [data-seasonal-month="4"]').click();
  assert.equal(document.getElementById('seasonal-theme-month').value, '4');
  assert.equal(document.getElementById('seasonal-selected-month-name').textContent, 'Abril');
  assert.equal(document.getElementById('seasonal-theme-preset').value, 'rainy-night');
  assert.equal(document.getElementById('seasonal-theme-preview').dataset.theme, 'rainy-night');

  const preset = document.getElementById('seasonal-theme-preset');
  preset.value = 'halloween';
  preset.dispatchEvent(new window.Event('change', { bubbles: true }));
  const animation = document.getElementById('seasonal-theme-animation');
  animation.value = 'embers';
  animation.dispatchEvent(new window.Event('change', { bubbles: true }));
  const intensity = document.getElementById('seasonal-theme-intensity');
  intensity.value = 'festive';
  intensity.dispatchEvent(new window.Event('change', { bubbles: true }));
  const save = document.getElementById('seasonal-theme-form');
  save.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => window.setTimeout(resolve, 30));

  const put = requests.find(item => item.route === '/api/admin/v1/seasonal-theme' && item.options.method === 'PUT');
  assert.ok(put);
  const saved = JSON.parse(put.options.body);
  assert.equal(saved.rotation, 'monthly');
  assert.equal(saved.months.length, 12);
  assert.deepEqual(saved.months[3], { month: 4, presetId: 'halloween', animation: 'embers', intensity: 'festive', enabled: true });
  assert.match(document.getElementById('seasonal-theme-status').textContent, /Calendario guardado/);
  dom.window.close();
});
