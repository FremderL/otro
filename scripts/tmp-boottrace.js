// Traza de arranque: escribe en stderr cada módulo del proyecto que se carga y
// las salidas de proceso, para ver dónde se queda un arranque sin logs.
const Module = require('module');
const fs = require('fs');
const orig = Module._load;
let count = 0;
Module._load = function (request, parent, isMain) {
  const out = orig.apply(this, arguments);
  try {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (!/node_modules/.test(resolved)) {
      count++;
      if (count < 5000) fs.writeSync(2, `TRACE load ${resolved.split('/').slice(-2).join('/')}\n`);
    }
  } catch (_) {}
  return out;
};
fs.writeSync(2, 'TRACE trace instalada\n');
process.on('exit', code => fs.writeSync(2, `TRACE exit ${code}\n`));
process.on('uncaughtException', error => fs.writeSync(2, `TRACE uncaught ${error && error.message}\n`));
