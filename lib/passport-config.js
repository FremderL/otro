'use strict';

// Activación controlada del Pasaporte. Se mantiene apagado si el despliegue no
// opta expresamente por PASSPORT_ENABLED=on para que cada primer período empiece
// en el momento de la activación, sin progreso retroactivo.
function flagOn(raw) {
  const value = String(raw == null ? '' : raw).trim().toLowerCase();
  return ['on', 'true', '1', 'yes'].includes(value);
}

function loadPassportConfig(env = process.env) {
  return { enabled: flagOn(env.PASSPORT_ENABLED) };
}

module.exports = { flagOn, loadPassportConfig };
