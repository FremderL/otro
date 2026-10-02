'use strict';

// La administración nace apagada. Este módulo concentra la frontera de
// configuración para que ningún entorno pueda habilitarla parcialmente con
// secretos vacíos o valores de desarrollo.
const MIN_SECRET_BYTES = 32;

function enabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function secretBytes(value) {
  if (!value) return 0;
  // Los secretos se aceptan como Base64; así se pueden generar y rotar sin
  // depender de la codificación de caracteres del proveedor de despliegue.
  try {
    const decoded = Buffer.from(String(value), 'base64');
    return decoded.toString('base64').replace(/=+$/, '') === String(value).replace(/=+$/, '')
      ? decoded.length
      : 0;
  } catch (_) {
    return 0;
  }
}

function loadAdminConfig(env = process.env) {
  const featureEnabled = enabled(env.ADMIN_FEATURE_ENABLED);
  const accountSessionsEnabled = enabled(env.ACCOUNT_SESSIONS_ENABLED) || featureEnabled;
  const config = {
    enabled: featureEnabled,
    accountSessionsEnabled,
    appOrigin: String(env.APP_ORIGIN || '').replace(/\/$/, ''),
    trustProxyHops: Number.parseInt(env.TRUST_PROXY_HOPS || '0', 10),
    sessionPepper: env.SESSION_PEPPER || '',
    mfaEncryptionKey: env.MFA_ENCRYPTION_KEY || '',
    auditIpPepper: env.AUDIT_IP_PEPPER || '',
    reportGuestEnabled: enabled(env.REPORT_GUEST_ENABLED)
  };

  if (!accountSessionsEnabled) return config;

  const errors = [];
  if (!env.DATABASE_URL) errors.push('DATABASE_URL es obligatorio');
  try {
    const origin = new URL(config.appOrigin);
    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) {
      errors.push('APP_ORIGIN debe ser un origen HTTPS sin ruta, query ni fragmento');
    }
  } catch (_) {
    errors.push('APP_ORIGIN debe ser un origen HTTPS válido');
  }
  if (!Number.isInteger(config.trustProxyHops) || config.trustProxyHops < 0 || config.trustProxyHops > 5) {
    errors.push('TRUST_PROXY_HOPS debe ser un entero entre 0 y 5');
  }
  if (secretBytes(config.sessionPepper) < MIN_SECRET_BYTES) errors.push('SESSION_PEPPER debe contener al menos 32 bytes en Base64');
  if (featureEnabled && secretBytes(config.mfaEncryptionKey) !== 32) errors.push('MFA_ENCRYPTION_KEY debe contener exactamente 32 bytes en Base64');
  if (featureEnabled && secretBytes(config.auditIpPepper) < MIN_SECRET_BYTES) errors.push('AUDIT_IP_PEPPER debe contener al menos 32 bytes en Base64');

  if (errors.length) {
    throw new Error(`Configuración administrativa insegura:\n- ${errors.join('\n- ')}`);
  }
  return config;
}

module.exports = { loadAdminConfig, enabled, secretBytes, MIN_SECRET_BYTES };
