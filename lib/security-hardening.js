'use strict';
const SENSITIVE=/(password|passphrase|token|secret|cookie|authorization|recovery.?code|mfa.?code|evidence|snapshot)/i;
function sanitizeLogValue(value,depth=0){if(depth>4)return '[TRUNCATED]';if(value===null||['boolean','number'].includes(typeof value))return value;if(typeof value==='string')return value.slice(0,500);if(Array.isArray(value))return value.slice(0,20).map(item=>sanitizeLogValue(item,depth+1));if(typeof value==='object'){const clean={};for(const [key,item] of Object.entries(value).slice(0,50))clean[key]=SENSITIVE.test(key)?'[REDACTED]':sanitizeLogValue(item,depth+1);return clean;}return String(value).slice(0,500);}
// Sin scripts ni manejadores inline: todo el JavaScript viene de /public (script-src 'self').
// Los estilos admiten atributos style= generados por la interfaz (style-src 'unsafe-inline').
// frame-ancestors nace en 'self' (fail-closed): la app no se puede embeber en terceros
// salvo que se declaren orígenes explícitos en EMBED_FRAME_ANCESTORS.
const BASE_CONTENT_SECURITY_POLICY="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'self'";
const DEFAULT_FRAME_ANCESTORS="'self'";
// Acepta solo orígenes http(s) literales (con comodín de subdominio opcional) o las
// palabras clave 'self'/'none'; cualquier otra cosa se descarta en silencio.
const FRAME_ANCESTOR_TOKEN=/^(?:https?:\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d+)?|'self'|'none')$/i;
function parseFrameAncestors(raw){
  const tokens=String(raw==null?'':raw).split(/[,\s]+/).map(item=>item.trim()).filter(Boolean).filter(item=>FRAME_ANCESTOR_TOKEN.test(item));
  if(!tokens.length)return DEFAULT_FRAME_ANCESTORS;
  return tokens.includes("'none'")?"'none'":tokens.join(' ');
}
const FRAME_ANCESTORS=parseFrameAncestors(process.env.EMBED_FRAME_ANCESTORS);
const CONTENT_SECURITY_POLICY=`${BASE_CONTENT_SECURITY_POLICY}; frame-ancestors ${FRAME_ANCESTORS}`;
const EMBEDDABLE=FRAME_ANCESTORS!=="'none'"&&FRAME_ANCESTORS!=="'self'";
function securityHeaders(req,res,next){res.set('X-Content-Type-Options','nosniff');res.set('Referrer-Policy','no-referrer');res.set('Permissions-Policy','camera=(), microphone=(), geolocation=(), payment=()');res.set('Content-Security-Policy',CONTENT_SECURITY_POLICY);
  // X-Frame-Options no admite comodines ni varios orígenes: solo se emite cuando la
  // política es la estricta por defecto o 'none'. Con orígenes declarados manda la CSP.
  if(!EMBEDDABLE)res.set('X-Frame-Options',FRAME_ANCESTORS==="'none'"?'DENY':'SAMEORIGIN');
  if(req.path.startsWith('/api/'))res.set('Cache-Control','no-store');next();}
module.exports={sanitizeLogValue,securityHeaders,CONTENT_SECURITY_POLICY,parseFrameAncestors};
