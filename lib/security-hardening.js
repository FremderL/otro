'use strict';
const SENSITIVE=/(password|passphrase|token|secret|cookie|authorization|recovery.?code|mfa.?code|evidence|snapshot)/i;
function sanitizeLogValue(value,depth=0){if(depth>4)return '[TRUNCATED]';if(value===null||['boolean','number'].includes(typeof value))return value;if(typeof value==='string')return value.slice(0,500);if(Array.isArray(value))return value.slice(0,20).map(item=>sanitizeLogValue(item,depth+1));if(typeof value==='object'){const clean={};for(const [key,item] of Object.entries(value).slice(0,50))clean[key]=SENSITIVE.test(key)?'[REDACTED]':sanitizeLogValue(item,depth+1);return clean;}return String(value).slice(0,500);}
// Sin scripts ni manejadores inline: todo el JavaScript viene de /public (script-src 'self').
// Los estilos admiten atributos style= generados por la interfaz (style-src 'unsafe-inline').
const CONTENT_SECURITY_POLICY="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";
function securityHeaders(req,res,next){res.set('X-Content-Type-Options','nosniff');res.set('Referrer-Policy','no-referrer');res.set('Permissions-Policy','camera=(), microphone=(), geolocation=(), payment=()');res.set('X-Frame-Options','SAMEORIGIN');res.set('Content-Security-Policy',CONTENT_SECURITY_POLICY);if(req.path.startsWith('/api/'))res.set('Cache-Control','no-store');next();}
module.exports={sanitizeLogValue,securityHeaders};
