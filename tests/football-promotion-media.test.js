'use strict';

// Creatividades de imagen de La Previa: validación por firma binaria, límites,
// eliminación de metadatos, retención (borrado al rechazo y al kickoff) y
// protección contra rutas arbitrarias en el nombre del archivo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const media = require('../lib/football/promotion-media');
const { cleanPromotion, publicPromotion } = require('../lib/football/promotions');

// --- Generadores de imágenes mínimas válidas ---------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(width, height, extraChunks = []) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8 bits, RGB
  const idat = require('node:zlib').deflateSync(Buffer.alloc(16));
  return Buffer.concat([
    media.PNG_SIGNATURE || Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...extraChunks.map(([type, data]) => pngChunk(type, data)),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}
function makeJpeg(width, height) {
  const exif = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from('GPS-SECRETO-LOCATION')]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([0, exif.length + 2]), exif]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, sos, Buffer.from([0x12, 0x34]), Buffer.from([0xff, 0xd9])]);
}
const toDataUrl = (buffer, mime) => `data:${mime};base64,${buffer.toString('base64')}`;

// --- Validación -------------------------------------------------------------

test('acepta un PNG apaisado válido y reporta sus dimensiones', () => {
  const out = media.prepareImage(toDataUrl(makePng(1600, 900), 'image/png'));
  assert.equal(out.ok, true, out.error);
  assert.equal(out.mime, 'image/png');
  assert.equal(out.width, 1600);
  assert.equal(out.height, 900);
});

test('acepta un JPEG y elimina EXIF y datos de ubicación', () => {
  const out = media.prepareImage(toDataUrl(makeJpeg(1600, 900), 'image/jpeg'));
  assert.equal(out.ok, true, out.error);
  assert.equal(out.mime, 'image/jpeg');
  assert.ok(!out.buffer.includes(Buffer.from('GPS-SECRETO-LOCATION')), 'sin metadatos de ubicación');
  assert.ok(!out.buffer.includes(Buffer.from('Exif')), 'sin cabecera EXIF');
  assert.ok(media.measure(out.buffer), 'sigue siendo un JPEG legible');
});

test('quita fragmentos PNG de texto y metadatos, conservando la imagen', () => {
  const png = makePng(1600, 900, [['tEXt', Buffer.from('Author\0Sensitive')]]);
  const out = media.prepareImage(toDataUrl(png, 'image/png'));
  assert.equal(out.ok, true, out.error);
  assert.ok(!out.buffer.includes(Buffer.from('Sensitive')), 'tEXt eliminado');
  assert.ok(out.buffer.includes(Buffer.from('IDAT')), 'los datos de imagen se conservan');
});

test('rechaza contenido que no tiene firma PNG/JPEG aunque declare image/png', () => {
  const fake = Buffer.from('<script>alert(1)</script>'.repeat(20));
  const out = media.prepareImage(toDataUrl(fake, 'image/png'));
  assert.equal(out.ok, false);
  assert.equal(out.code, 'invalid_image');
});

test('rechaza tipos MIME fuera de PNG/JPEG', () => {
  const out = media.prepareImage(toDataUrl(makePng(1600, 900), 'image/gif'));
  assert.equal(out.ok, false);
  assert.equal(out.code, 'invalid_image');
});

test('rechaza imágenes demasiado pequeñas, demasiado altas o con proporción de cartel', () => {
  assert.equal(media.prepareImage(toDataUrl(makePng(400, 300), 'image/png')).code, 'image_dimensions');
  assert.equal(media.prepareImage(toDataUrl(makePng(3000, 1200), 'image/png')).code, 'image_dimensions');
  // 2400×1000 = 2.4:1, más ancho que el límite de 2.1:1 de la previa.
  assert.equal(media.prepareImage(toDataUrl(makePng(2400, 1000), 'image/png')).code, 'image_dimensions');
  // 1000×1000 es cuadrada: el banner de La Previa es apaisado.
  assert.equal(media.prepareImage(toDataUrl(makePng(1000, 1000), 'image/png')).code, 'image_dimensions');
});

test('rechaza archivos por encima de 350 KB antes de decodificar', () => {
  const big = Buffer.alloc(media.MAX_IMAGE_BYTES + 1, 0x41);
  const out = media.prepareImage(toDataUrl(big, 'image/png'));
  assert.equal(out.ok, false);
  assert.equal(out.code, 'image_too_large');
  const huge = `data:image/png;base64,${'A'.repeat(media.MAX_IMAGE_BYTES * 2)}`;
  assert.equal(media.prepareImage(huge).code, 'image_too_large');
});

// --- Retención --------------------------------------------------------------

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-promo-media-'));
}

test('el barrido borra rechazadas y las de partidos ya iniciados; conserva las de T−30 abierto', () => {
  const dir = tempDir();
  const now = 1_800_000_000_000;
  const open = media.saveMedia(dir, Buffer.from('x'), 'png');
  const rejected = media.saveMedia(dir, Buffer.from('x'), 'png');
  const started = media.saveMedia(dir, Buffer.from('x'), 'jpg');
  const profile = {
    id: 'p1',
    promotions: [
      { id: 'a', matchId: 'm1', status: 'approved', imageFile: open },
      { id: 'b', matchId: 'm2', status: 'rejected', imageFile: rejected },
      { id: 'c', matchId: 'm3', status: 'approved', imageFile: started }
    ]
  };
  const matches = {
    m1: { status: 'scheduled', scheduledKickoffAt: now + 10 * 60 * 1000 },
    m2: { status: 'scheduled', scheduledKickoffAt: now + 10 * 60 * 1000 },
    m3: { status: 'scheduled', scheduledKickoffAt: now - 1 }
  };
  const expired = media.sweepPromotionMedia({ profileList: [profile], getMatch: id => matches[id], dir, now });
  assert.equal(expired.length, 2);
  assert.equal(profile.promotions[0].imageFile, open, 'la imagen de T−30 se conserva');
  assert.equal(profile.promotions[1].imageFile, null, 'la rechazada se borra');
  assert.equal(profile.promotions[2].imageFile, null, 'la del partido iniciado se borra');
  assert.ok(fs.existsSync(path.join(dir, open)));
  assert.ok(!fs.existsSync(path.join(dir, rejected)));
  assert.ok(!fs.existsSync(path.join(dir, started)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('un partido que dejó de estar programado (p. ej. pospuesto) también libera su imagen', () => {
  const dir = tempDir();
  const file = media.saveMedia(dir, Buffer.from('x'), 'png');
  const profile = { promotions: [{ id: 'a', matchId: 'm1', status: 'pending', imageFile: file }] };
  const now = 1_800_000_000_000;
  media.sweepPromotionMedia({ profileList: [profile], getMatch: () => ({ status: 'postponed', scheduledKickoffAt: now + 1e6 }), dir, now });
  assert.equal(profile.promotions[0].imageFile, null);
  assert.ok(!fs.existsSync(path.join(dir, file)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('el nombre del archivo nunca puede apuntar fuera del directorio de medios', () => {
  assert.equal(media.mediaPath('/srv/media', '../../etc/passwd'), null);
  assert.equal(media.mediaPath('/srv/media', '/etc/passwd'), null);
  assert.equal(media.readMedia('/srv/media', '../secret.png'), null);
  const clean = cleanPromotion({
    id: 'p-1', matchId: 'm1', text: 'Texto válido', targetPath: '/', status: 'approved', createdAt: 1,
    imageFile: '../../escape.png'
  });
  assert.equal(clean.imageFile, null, 'un nombre malicioso se descarta al limpiar el perfil');
});

test('la ruta pública expone solo una URL interna, nunca el nombre del archivo', () => {
  const id = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const withImage = publicPromotion({
    id, matchId: 'm1', text: 'Texto válido', targetPath: '/', status: 'approved', createdAt: 1,
    reviewedAt: 2, imageFile: `${id}.png`
  });
  assert.equal(withImage.image, `/api/estadio/promotion-media/${id}`);
  assert.ok(!JSON.stringify(withImage).includes('.png'), 'sin nombre de archivo en la respuesta');
  const textOnly = publicPromotion({
    id: 'p2', matchId: 'm1', text: 'Solo texto', targetPath: '/', status: 'approved', createdAt: 1, imageFile: null
  });
  assert.equal(textOnly.image, null);
});
