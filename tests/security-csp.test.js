'use strict';

// Seguridad frente a inyección de scripts y archivos maliciosos:
// - Content-Security-Policy estricta para scripts (sin inline ni eval).
// - Páginas públicas y de admin sin <script> inline ni manejadores on*=.
// - Imágenes de promociones: solo PNG/JPEG y sin bytes añadidos (polyglot).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { securityHeaders } = require('../lib/security-hardening');
const media = require('../lib/football/promotion-media');

const PUBLIC = path.join(__dirname, '..', 'public');

function headersAfter(middleware, reqPath = '/') {
  const headers = {};
  const res = { set(name, value) { headers[name] = value; return this; } };
  middleware({ path: reqPath }, res, () => {});
  return headers;
}

test('la respuesta incluye CSP sin scripts inline ni eval', () => {
  const csp = headersAfter(securityHeaders)['Content-Security-Policy'];
  assert.ok(csp, 'la CSP está presente');
  const directives = Object.fromEntries(csp.split(';').map(d => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.deepEqual(directives['script-src'], ["'self'"]);
  assert.ok(!csp.includes("'unsafe-eval'"), 'sin unsafe-eval');
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'sin unsafe-inline en scripts');
  assert.deepEqual(directives['object-src'], ["'none'"]);
  assert.deepEqual(directives['frame-ancestors'], ["'self'"]);
});

test('las páginas HTML no tienen <script> inline ni manejadores on*= (CSP)', () => {
  const pages = fs.readdirSync(PUBLIC).filter(name => name.endsWith('.html'));
  assert.ok(pages.length >= 4);
  for (const page of pages) {
    const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
    const inlineScripts = [...html.matchAll(/<script\b([^>]*)>/gi)].filter(m => !/\bsrc\s*=/.test(m[1]));
    assert.equal(inlineScripts.length, 0, `${page}: <script> sin src`);
    assert.equal((html.match(/\son[a-z]+\s*=/gi) || []).length, 0, `${page}: manejadores on*=`);
    assert.equal((html.match(/javascript:/gi) || []).length, 0, `${page}: URLs javascript:`);
  }
});

test('los scripts del sitio no usan eval ni new Function', () => {
  for (const file of fs.readdirSync(PUBLIC).filter(name => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    assert.ok(!/\beval\s*\(/.test(source), `${file}: eval`);
    assert.ok(!/new\s+Function\s*\(/.test(source), `${file}: new Function`);
  }
});

test('la CSP de administración no permite estilos ni scripts inline', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'admin-auth-http.js'), 'utf8');
  const match = src.match(/'Content-Security-Policy':\s*"([^"]+)"/);
  assert.ok(match, 'CSP de admin declarada');
  assert.ok(!/unsafe-inline/.test(match[1]));
  assert.ok(/script-src 'self'/.test(match[1]));
});

test('una imagen PNG con código añadido tras IEND no conserva esos bytes', () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1600, 0); ihdr.writeUInt32BE(900, 4); ihdr[8] = 8; ihdr[9] = 2;
  const crcOf = buf => { let c = 0xffffffff; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crcOf(body));
    return Buffer.concat([len, body, crc]);
  };
  const payload = Buffer.from('<script>alert(document.cookie)</script>');
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from('Comment\0<script>x</script>')),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(16))),
    chunk('IEND', Buffer.alloc(0)),
    payload
  ]);
  const prepared = media.prepareImage(`data:image/png;base64,${png.toString('base64')}`);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const clean = media.stripMetadata(prepared.buffer, prepared.ext);
  assert.ok(clean, 'la imagen se limpia');
  assert.ok(!clean.includes(Buffer.from('<script')), 'sin código tras IEND ni en tEXt');
  assert.ok(!clean.includes(payload));
});

test('un archivo que no es PNG ni JPEG se rechaza aunque declare imagen', () => {
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  const result = media.prepareImage(`data:image/png;base64,${html.toString('base64')}`);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_image');
});
