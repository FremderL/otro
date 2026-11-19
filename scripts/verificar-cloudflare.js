#!/usr/bin/env node
'use strict';

// Verifica que el sitio detrás de Cloudflare esté sirviendo los assets desde el
// borde y no desde Render.
//
// Uso:
//   node scripts/verificar-cloudflare.js https://tu-dominio.com
//   npm run cdn:check -- https://tu-dominio.com
//
// Qué comprueba, y por qué importa cada punto:
//   1. `/assets/...` responde `cf-cache-status: HIT` en la segunda petición.
//      Si dice MISS siempre, la regla de caché no está actuando y Render sigue
//      pagando el ancho de banda.
//   2. `/` y `/healthz` NO se cachean. Si `cf-cache-status` fuera HIT en el
//      HTML, la gente vería una versión vieja del juego tras cada despliegue;
//      y si `/healthz` se cachea, los reinicios de Render se deciden con datos
//      rancios.
//   3. El HTML conserva la CSP del servidor (`script-src 'self'`). Si Cloudflare
//      inyecta su JavaScript (Rocket Loader, Email Obfuscation), la CSP lo
//      bloquea: el juego carga pero los botones no responden.

const DEFAULT_ASSET = '/assets/cards/card-3-hearts.jpg';

function argUrl() {
  const raw = process.argv[2];
  if (!raw) {
    console.error('Falta la URL. Ejemplo:\n  node scripts/verificar-cloudflare.js https://tu-dominio.com');
    process.exit(2);
  }
  try {
    return new URL(raw);
  } catch (_) {
    console.error(`URL inválida: ${raw}`);
    process.exit(2);
  }
}

async function fetchHeaders(url, { noCache = false } = {}) {
  const headers = {};
  // Un `cache-control: no-cache` del cliente obliga al borde a revalidar, así
  // que se pide "limpio" la primera vez y normal la segunda.
  if (noCache) headers['cache-control'] = 'no-cache';
  const response = await fetch(url, { headers, redirect: 'follow' });
  return { status: response.status, headers: response.headers, response };
}

function summarize(result) {
  const get = name => result.headers.get(name) || '—';
  return {
    status: result.status,
    cacheStatus: get('cf-cache-status'),
    cacheControl: get('cache-control'),
    ray: get('cf-ray'),
    server: get('server')
  };
}

function icon(ok) {
  return ok ? '✅' : '❌';
}

async function main() {
  const base = argUrl();
  const origin = base.origin;
  let failures = 0;

  console.log(`\nVerificando ${origin}\n${'─'.repeat(60)}`);

  // ── 1. Assets: deben acabar en HIT ────────────────────────────────────────
  const assetUrl = new URL(DEFAULT_ASSET, origin);
  console.log(`\n1) Assets (${DEFAULT_ASSET})`);
  const first = await fetchHeaders(assetUrl, { noCache: true });
  console.log(`   primera petición  → status ${first.status}, cf-cache-status: ${summarize(first).cacheStatus}`);
  const second = await fetchHeaders(assetUrl);
  const s2 = summarize(second);
  console.log(`   segunda petición  → status ${s2.status}, cf-cache-status: ${s2.cacheStatus}`);
  console.log(`   cache-control     → ${s2.cacheControl}`);

  if (s2.ray === '—') {
    console.log('   ⚠️  No hay cabecera cf-ray: el dominio NO está proxeado por Cloudflare.');
    console.log('       En Cloudflare, el registro DNS debe estar en naranja (Proxied).');
    failures += 1;
  } else if (s2.cacheStatus === 'HIT' || s2.cacheStatus === 'REVALIDATED') {
    console.log('   ✅ El asset se sirve desde el borde: Render no cobra este tráfico.');
  } else {
    console.log(`   ❌ cf-cache-status = ${s2.cacheStatus}. Revisa la Cache Rule de /assets/*.`);
    failures += 1;
  }
  if (!/public/.test(s2.cacheControl)) {
    console.log('   ⚠️  Cache-Control sin `public`: despliega la versión actual de server.js.');
  }

  // ── 2. HTML: NO debe cachearse ────────────────────────────────────────────
  console.log('\n2) Shell de la app (/)');
  const html = await fetchHeaders(origin);
  const h = summarize(html);
  console.log(`   status ${h.status}, cf-cache-status: ${h.cacheStatus}, cache-control: ${h.cacheControl}`);
  if (h.cacheStatus === 'HIT' || h.cacheStatus === 'STALE') {
    console.log('   ❌ El HTML se está cacheando: tras un despliegue verías la UI vieja.');
    console.log('       Pon una Cache Rule con Bypass en /* y deja solo /assets/* cacheado.');
    failures += 1;
  } else {
    console.log('   ✅ El HTML no se cachea en el borde (correcto).');
  }

  // ── 3. CSP intacta ────────────────────────────────────────────────────────
  const csp = html.headers.get('content-security-policy') || '';
  console.log('\n3) Content-Security-Policy');
  if (!csp) {
    console.log('   ❌ No llega la CSP. ¿Una Transform Rule la está borrando?');
    failures += 1;
  } else if (/script-src 'self'/.test(csp) && !/unsafe-inline|unsafe-eval/.test(csp.split('script-src')[1]?.split(';')[0] || '')) {
    console.log('   ✅ script-src sigue siendo \'self\': todo bien si no activaste Rocket Loader.');
  } else {
    console.log(`   ⚠️  La CSP cambió: ${csp.slice(0, 120)}…`);
  }
  console.log('   Recuerda: con esta CSP, Rocket Loader y Email Obfuscation deben estar OFF.');

  // ── 4. /healthz: no cacheable ─────────────────────────────────────────────
  console.log('\n4) Health check (/healthz)');
  const health = await fetchHeaders(new URL('/healthz', origin));
  const hh = summarize(health);
  console.log(`   status ${hh.status}, cf-cache-status: ${hh.cacheStatus}, cache-control: ${hh.cacheControl}`);
  if (hh.status !== 200) {
    console.log('   ❌ /healthz no responde 200: Render podría reiniciar el servicio en bucle.');
    failures += 1;
  } else if (hh.cacheStatus === 'HIT') {
    console.log('   ❌ /healthz se está cacheando. Añade una regla de Bypass para /healthz.');
    failures += 1;
  } else {
    console.log('   ✅ Responde 200 y no se cachea.');
  }

  // ── 5. WebSocket ──────────────────────────────────────────────────────────
  console.log('\n5) WebSocket (/socket.io/)');
  try {
    const probe = await fetch(new URL('/socket.io/?EIO=4&transport=polling', origin), {
      headers: { origin }
    });
    const body = await probe.text();
    const okHandshake = probe.status === 200 && body.startsWith('0{');
    console.log(`   ${icon(okHandshake)} handshake de Socket.IO: status ${probe.status}`);
    if (!okHandshake) {
      console.log('       El juego no va a conectar. Revisa que /socket.io/ no esté cacheado ni bloqueado.');
      failures += 1;
    }
  } catch (error) {
    console.log(`   ❌ No se pudo probar el handshake: ${error.message}`);
    failures += 1;
  }

  // ── Resumen ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  if (failures === 0) {
    console.log('Todo en orden: Cloudflare está absorbiendo los assets. 🎉\n');
    console.log('Comprobación final manual: en Cloudflare → Caching → Analytics, el');
    console.log('"Bandwidth saved" debería crecer mientras juegas.\n');
    process.exit(0);
  }
  console.log(`${failures} punto(s) por corregir. Revisa docs/cloudflare-delante-de-render.md\n`);
  process.exit(1);
}

main().catch(error => {
  console.error(`\nError inesperado: ${error.message}`);
  if (/fetch failed|ENOTFOUND|getaddrinfo/i.test(error.message)) {
    console.error('¿El dominio responde desde esta máquina? Prueba `curl -I https://tu-dominio.com`.');
  }
  process.exit(2);
});
