// TEMPORAL: mide cada consulta SQL (y cada conexión) del proceso hijo para
// localizar la lentitud del arranque con Postgres en CI.
const fs = require('node:fs');
const Module = require('node:module');
const load = Module._load;
let n = 0;
const tag = (kind, text, t0) => {
  n += 1;
  const ms = Date.now() - t0;
  if (ms >= 40 || kind.includes('connect')) {
    const flat = String(text).replace(/\s+/g, ' ').slice(0, 90);
    fs.writeSync(2, `SQL#${n} ${ms}ms ${kind} ${flat}\n`);
  }
};
Module._load = function (request, parent, isMain) {
  const exp = load.apply(this, arguments);
  if (request !== 'pg' || !exp || exp.__patched) return exp;
  exp.__patched = true;
  const { Client, Pool } = exp;
  for (const Klass of [Client, Pool]) {
    if (!Klass) continue;
    const kind = Klass === Pool ? 'pool' : 'client';
    for (const name of ['query', 'connect']) {
      const orig = Klass.prototype[name];
      if (!orig) continue;
      Klass.prototype[name] = function (...args) {
        const t0 = Date.now();
        const first = args[0];
        const label = typeof first === 'string' ? first : (first && first.text) || '<obj>';
        let p;
        try { p = orig.apply(this, args); } catch (e) { tag(`${kind}.${name} ERR`, label, t0); throw e; }
        if (p && typeof p.then === 'function') p.then(() => tag(`${kind}.${name}`, label, t0), e => tag(`${kind}.${name} ERR ${e.code || ''}`, label, t0));
        return p;
      };
    }
  }
  return exp;
};

// TEMPORAL: contar los volcados completos (cada uno reescribe toda la liga).
const pgStorePath = require.resolve('../lib/football-store-pg');
let snapshots = 0;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const exp = origLoad.apply(this, arguments);
  try {
    const Klass = exp && (exp.PgFootballStore || (typeof exp === 'function' && exp));
    if (Klass && Klass.prototype && typeof Klass.prototype._writeSnapshot === 'function' && !Klass.__snapPatched) {
      Klass.__snapPatched = true;
      const orig = Klass.prototype._writeSnapshot;
      Klass.prototype._writeSnapshot = function (...args) {
        snapshots += 1;
        const frame = String(new Error().stack).split('\n').map(l => /(lib\/[^:)]+):(\d+)/.exec(l)).filter(Boolean)
          .map(m => m[1].replace('lib/football/', 'f/').replace('lib/', '') + ':' + m[2]).slice(0, 4).join('<-');
        fs.writeSync(2, `SNAPSHOTKEY ${frame}\n`);
        return orig.apply(this, args);
      };
    }
  } catch (_) { /* instrumentación best-effort */ }
  return exp;
};
