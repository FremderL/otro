// TEMPORAL: registra cada consulta SQL que envía el proceso, para localizar
// dónde se queda colgado el arranque con Postgres en CI.
const fs = require('node:fs');
const Module = require('node:module');
const load = Module._load;
let n = 0;
const tag = (kind, text) => {
  n += 1;
  const flat = String(text).replace(/\s+/g, ' ').slice(0, 160);
  fs.writeSync(2, `SQL#${n} ${kind} ${flat}\n`);
};
Module._load = function (request, parent, isMain) {
  const exp = load.apply(this, arguments);
  if (request !== 'pg' || !exp || exp.__patched) return exp;
  exp.__patched = true;
  const { Client, Pool } = exp;
  for (const Klass of [Client, Pool]) {
    if (!Klass) continue;
    const q = Klass.prototype.query;
    Klass.prototype.query = function (...args) {
      const first = args[0];
      tag(Klass === Pool ? 'pool' : 'client', typeof first === 'string' ? first : (first && first.text) || '<obj>');
      return q.apply(this, args);
    };
    const c = Klass.prototype.connect;
    if (c) Klass.prototype.connect = function (...args) { tag(Klass === Pool ? 'pool.connect' : 'client.connect', ''); return c.apply(this, args); };
  }
  return exp;
};
