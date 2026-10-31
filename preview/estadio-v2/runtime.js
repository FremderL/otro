'use strict';

// Solo para la vista aislada: adelanta el calendario a noviembre sin cambiar
// el reloj real ni las reglas del Estadio. El servidor real escucha por socket
// Unix; el proxy de la demo es el único puerto expuesto.
const RealDate = Date;
const start = RealDate.now();
const epoch = Number(process.env.ESTADIO_PREVIEW_EPOCH);
if (!Number.isSafeInteger(epoch) || !process.env.ESTADIO_PREVIEW_SOCKET) throw new Error('Configuración de vista previa inválida');
global.Date = class PreviewDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [epoch + RealDate.now() - start])); }
  static now() { return epoch + RealDate.now() - start; }
};

const http = require('node:http');
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  if (String(args[0]) === String(process.env.PORT) && args[1] === '0.0.0.0') {
    const callback = args.find(arg => typeof arg === 'function');
    return listen.call(this, process.env.ESTADIO_PREVIEW_SOCKET, callback);
  }
  return listen.apply(this, args);
};
