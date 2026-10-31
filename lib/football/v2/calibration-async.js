'use strict';

// Preparación sin bloquear el bucle de eventos del servidor. Esto NO activa
// mercados: la muestra aún debe superar las comprobaciones de integridad y
// cobertura, y el producto debe decidir cuándo adoptar un compromiso.
const { Worker } = require('node:worker_threads');
const path = require('node:path');

function calibrateInWorker(input, sampleKey, samples, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('calibración cancelada'));
    let worker;
    let done = false;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const fail = error => {
      if (done) return;
      done = true; cleanup();
      if (worker) worker.terminate().catch(() => {});
      reject(error);
    };
    const onAbort = () => fail(new Error('calibración cancelada'));
    try {
      worker = new Worker(path.join(__dirname, 'calibration-worker.js'), {
        workerData: { input, sampleKey, samples }
      });
    } catch (error) { fail(error); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    // La señal podría cambiar entre la primera comprobación y el registro.
    if (signal?.aborted) return onAbort();
    worker.once('message', result => {
      if (done) return;
      if (!result?.ok) return fail(new Error(result?.message || 'calibración fallida'));
      done = true; cleanup();
      resolve(result.calibration);
    });
    worker.once('error', fail);
    worker.once('exit', code => {
      if (!done) fail(new Error(`worker de calibración terminó sin resultado (${code})`));
    });
  });
}

module.exports = { calibrateInWorker };
