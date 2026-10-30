/*
 * Rueda de la Fortuna: geometría, orden de los 54 sectores y marcado de la
 * rueda. Vive aparte de app.js para poder probarse sola (como chat-format.js)
 * y para que el giro sea idéntico en todos los navegadores.
 *
 * Reglas (autoritativas en lib/quick-games.js): 25 sectores de 1, 15 de 2,
 * 7 de 5, 4 de 10, 2 de 20 y 1 de 40; el pago total (apuesta incluida) es
 * sector + 1. Nada de aquí decide resultados: solo dibuja el que decide el
 * servidor y calcula en qué ángulo queda bajo la flecha.
 */
(function (global) {
  'use strict';

  const TOTAL = 54;
  const STEP = 360 / TOTAL;
  const VALUES = [1, 2, 5, 10, 20, 40];
  const COUNTS = { 1: 25, 2: 15, 5: 7, 10: 4, 20: 2, 40: 1 };
  // Cada sector tiene su color: cuanto mayor el premio, más caliente el tono.
  const TIERS = {
    1: { face: '#155c49', edge: '#1a6a54', ink: '#dff5e8', ring: '#2f9377' },
    2: { face: '#174e6b', edge: '#1b5b7b', ink: '#e2f2fb', ring: '#2f7fa4' },
    5: { face: '#40325f', edge: '#4a3a6d', ink: '#efe6ff', ring: '#6a54a0' },
    10: { face: '#6d4520', edge: '#7c4f25', ink: '#ffeed6', ring: '#b07c3c' },
    20: { face: '#722932', edge: '#81303a', ink: '#ffe4e2', ring: '#c04c55' },
    40: { face: '#b5852b', edge: '#c69533', ink: '#221703', ring: '#f0c46a' }
  };
  // Separación fija para que el sector de 40 no quede justo bajo la flecha en reposo.
  const OFFSET = 8;

  // Reparto uniforme (algoritmo de "smooth"): cada sector de valor alto queda
  // rodeado de premios menores y ninguno se agrupa. Determinista: todos los
  // navegadores dibujan la misma rueda.
  function buildLayout() {
    const placed = new Map(VALUES.map(value => [value, 0]));
    const order = [];
    for (let index = 0; index < TOTAL; index++) {
      let best = null;
      let bestScore = Infinity;
      for (const value of VALUES) {
        const score = placed.get(value) / COUNTS[value];
        if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && value > best)) {
          best = value;
          bestScore = score;
        }
      }
      order.push(best);
      placed.set(best, placed.get(best) + 1);
    }
    return order.slice(OFFSET).concat(order.slice(0, OFFSET));
  }

  const LAYOUT = buildLayout();

  function payout(value) { return Number(value) + 1; }

  function tierFor(value) {
    const value_ = Number(value);
    return TIERS[value_] || TIERS[1];
  }

  // Ángulo (en grados, desde las 12 en punto y en sentido horario) del centro
  // de un sector.
  function sectorAngle(index) { return (index + 0.5) * STEP; }

  // Índice de la casilla donde se detiene el servidor. Si por cualquier motivo
  // llegara un valor fuera del catálogo, gana la primera casilla de ese valor.
  function indexOf(value) {
    const numeric = Number(value);
    const found = LAYOUT.indexOf(numeric);
    return found >= 0 ? found : LAYOUT.indexOf(1);
  }

  // Ángulo al que hay que dejar la rueda para que el sector quede bajo la
  // flecha: se dan varias vueltas completas desde el ángulo actual y se
  // aterriza exactamente en el centro del sector ganador.
  function landingAngle(value, from = 0, turns = 4) {
    const index = indexOf(value);
    const start = Number.isFinite(Number(from)) ? Number(from) : 0;
    const target = -sectorAngle(index);
    const delta = ((target - start) % 360 + 360) % 360;
    return start + delta + 360 * Math.max(1, Math.floor(turns));
  }

  function normalizeAngle(angle) {
    const numeric = Number(angle) || 0;
    return ((numeric % 360) + 360) % 360;
  }

  function polar(radius, angleDeg, center) {
    const radians = (angleDeg - 90) * Math.PI / 180;
    const c = center == null ? 210 : center;
    return [c + radius * Math.cos(radians), c + radius * Math.sin(radians)];
  }

  function sectorPath(index, { center = 210, outer = 196, inner = 116 } = {}) {
    const start = index * STEP;
    const end = start + STEP;
    const [x1, y1] = polar(outer, start, center);
    const [x2, y2] = polar(outer, end, center);
    const [x3, y3] = polar(inner, end, center);
    const [x4, y4] = polar(inner, start, center);
    return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${outer} ${outer} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)} L${x3.toFixed(2)} ${y3.toFixed(2)} A${inner} ${inner} 0 0 0 ${x4.toFixed(2)} ${y4.toFixed(2)} Z`;
  }

  function labelTransform(index, { center = 210, radius = 156 } = {}) {
    const angle = sectorAngle(index);
    const [x, y] = polar(radius, angle, center);
    // Texto radial: se lee del centro hacia fuera. En la mitad izquierda se
    // gira 180° para que nunca quede de cabeza.
    const direction = ((angle - 90) % 360 + 360) % 360;
    const rotation = direction > 90 && direction < 270 ? angle + 90 : angle - 90;
    return { x, y, rotation };
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  // Marcado completo de la rueda: flecha, rotor con los 54 sectores, aro y
  // centro con el resultado. `phase` es la fase del servidor; `value` el
  // sector ya decidido (o null); `landed` indica que el giro terminó.
  function markup({ value = null, phase = 'betting', choice = null, angle = 0, landed = false, label = '', winning = [] } = {}) {
    // Los sectores donde alguien apostó (el propio en dorado) reciben un aro
    // interior: la mesa deja de ser un anillo de números y se vuelve una mesa
    // donde se ve quién arriesgó qué sin abrir el panel.
    const picked = new Set((winning || []).map(Number));
    const hasValue = value != null;
    const hitIndex = hasValue ? indexOf(value) : -1;
    const rolling = phase === 'rolling';
    const spinning = rolling || (phase === 'results' && !landed);
    const sectors = LAYOUT.map((sectorValue, index) => {
      const tier = tierFor(sectorValue);
      const hit = index === hitIndex;
      const mine = picked.has(sectorValue);
      return `<path class="fortune-sector${hit ? ' is-hit' : ''}${mine ? ' is-picked' : ''}" data-fortune-sector="${index}" data-value="${sectorValue}" d="${sectorPath(index)}" fill="${index % 2 ? tier.face : tier.edge}" stroke="${tier.ring}" stroke-width="0.7" />`;
    }).join('');
    const labels = LAYOUT.map((sectorValue, index) => {
      const { x, y, rotation } = labelTransform(index);
      const hit = index === hitIndex;
      return `<text class="fortune-sector-label${hit ? ' is-hit' : ''}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" transform="rotate(${rotation.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)})" text-anchor="middle" dominant-baseline="central">${sectorValue}</text>`;
    }).join('');
    const hubValue = hasValue ? String(value) : (choice != null ? String(choice) : '✺');
    const hubNote = hasValue
      ? `SECTOR · PAGA x${payout(value)}`
      : choice != null ? `TU SECTOR · PAGA x${payout(choice)}` : 'ELIGE TU SECTOR';
    return `<div class="fortune-stage${spinning ? ' is-spinning' : ''}${rolling ? ' is-rolling' : ''}${landed ? ' landed' : ''}" data-fortune-stage="true">
      <div class="fortune-pointer" aria-hidden="true"><i></i></div>
      <svg class="fortune-wheel" viewBox="0 0 420 420" role="img" aria-label="Rueda de 54 sectores: ${LAYOUT.join(', ')}">
        <defs>
          <radialGradient id="fortune-rim-gold" cx="50%" cy="50%" r="50%">
            <stop offset="62%" stop-color="#c9a25c" />
            <stop offset="80%" stop-color="#f0d9a2" />
            <stop offset="93%" stop-color="#a9813f" />
            <stop offset="100%" stop-color="#f4e3b8" />
          </radialGradient>
          <radialGradient id="fortune-face-glow" cx="50%" cy="42%" r="55%">
            <stop offset="0%" stop-color="rgba(255,255,255,.16)" />
            <stop offset="70%" stop-color="rgba(255,255,255,0)" />
            <stop offset="100%" stop-color="rgba(0,0,0,.28)" />
          </radialGradient>
        </defs>
        <g class="fortune-rotor" data-fortune-rotor="true" style="transform:rotate(${Number(angle) || 0}deg)">
          ${sectors}
          ${labels}
        </g>
        <circle class="fortune-ring" cx="210" cy="210" r="196" fill="none" stroke="url(#fortune-rim-gold)" stroke-width="16" />
        <circle class="fortune-ring-inner" cx="210" cy="210" r="205" fill="none" stroke="rgba(10,22,18,.85)" stroke-width="6" />
        <circle class="fortune-ring-studs" cx="210" cy="210" r="187.5" fill="none" stroke="rgba(255,240,205,.5)" stroke-width="1.6" stroke-dasharray="2 10" />
        <circle cx="210" cy="210" r="116" fill="#0b1a17" stroke="rgba(240,214,155,.55)" stroke-width="2" />
        <circle cx="210" cy="210" r="116" fill="url(#fortune-face-glow)" />
      </svg>
      <div class="fortune-hub" aria-live="polite">
        <b data-fortune-hub="true">${escapeHtml(hubValue)}</b>
        <small>${escapeHtml(hubNote)}</small>
        ${label ? `<em>${escapeHtml(label)}</em>` : ''}
      </div>
    </div>`;
  }

  // Leyenda de pagos: cada chip usa el color de su sector para que la rueda y
  // la tabla se lean igual.
  function legend({ choice = null, value = null } = {}) {
    return `<ul class="fortune-legend" aria-label="Pagos de la rueda: fichas virtuales">${VALUES.map(sectorValue => {
      const active = String(choice) === String(sectorValue) || String(value) === String(sectorValue);
      return `<li class="fortune-legend-item${active ? ' active' : ''}" data-fortune-tier="${sectorValue}" style="--tier-face:${tierFor(sectorValue).face};--tier-ring:${tierFor(sectorValue).ring}">
        <span>${sectorValue}</span><b>x${payout(sectorValue)}</b><small>${COUNTS[sectorValue]} ${COUNTS[sectorValue] === 1 ? 'sector' : 'sectores'}</small>
      </li>`;
    }).join('')}</ul>`;
  }

  const api = {
    TOTAL, STEP, VALUES, COUNTS, TIERS, LAYOUT, payout, tierFor, indexOf,
    sectorAngle, landingAngle, normalizeAngle, sectorPath, labelTransform, markup, legend
  };

  global.FortuneWheel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
