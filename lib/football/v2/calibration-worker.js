'use strict';

// Se ejecuta únicamente en un worker: nunca recibe la clave del partido, solo
// una clave independiente de muestreo y una copia de las entradas públicas.
const { parentPort, workerData } = require('node:worker_threads');
const { createCalibration } = require('./calibration');

try {
  const { input, sampleKey, samples } = workerData;
  parentPort.postMessage({ ok: true, calibration: createCalibration(input, sampleKey, samples) });
} catch (error) {
  parentPort.postMessage({ ok: false, message: String(error?.message || error) });
}
