#!/usr/bin/env node
'use strict';

// Reloj de demostración para la vista previa del Estadio.
//
// La parrilla de cada mes es determinista a partir de la fecha y el motor se
// elige por mes de temporada (`>= 2026-11` ⇒ V2). Para poder enseñar un partido
// V2 sin esperar al calendario real, el servidor arranca con la hora desplazada:
// este shim mantiene el reloj avanzando a velocidad normal, pero anclado a
// `DEMO_NOW` (por defecto, 1 de noviembre de 2026, 17:00 en Ciudad de México).
//
// Uso:
//   NODE_OPTIONS=--require=./scripts/estadio-demo-clock.cjs \
//   DEMO_NOW=2026-11-01T17:00:00-06:00 node server.js
//
// Si `DEMO_NOW` falta, se usa el valor por defecto. Un valor inválido no rompe el
// arranque: se ignora y se usa el reloj real (mejor un demo en la fecha real que
// un servidor que no levanta).

const RealDate = Date;
const DEFAULT_NOW = '2026-11-01T17:00:00-06:00';

function targetMs(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return RealDate.parse(DEFAULT_NOW);
  const parsed = RealDate.parse(value);
  return Number.isFinite(parsed) ? parsed : RealDate.parse(DEFAULT_NOW);
}

const offset = targetMs(process.env.DEMO_NOW) - RealDate.now();

class ShiftedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [RealDate.now() + offset])); }
  static now() { return RealDate.now() + offset; }
}

global.Date = ShiftedDate;
