'use strict';

// Creatividades de imagen para La Previa. El anunciante vinculado sube un PNG o
// JPEG; el servidor valida la firma binaria (no la extensión), limita tamaño y
// proporción, elimina metadatos y guarda el archivo con un nombre aleatorio.
// Retención: la imagen se borra al rechazarse, al arrancar el partido (o si el
// partido deja de estar programado). Nunca se sirve fuera de la ventana T−30.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_IMAGE_BYTES = 350 * 1024;
const MAX_DATA_URL_CHARS = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 64;
const MIN_WIDTH = 960;
const MAX_WIDTH = 2400;
const MIN_HEIGHT = 320;
const MAX_HEIGHT = 1600;
const MIN_RATIO = 1.5;  // ancho / alto
const MAX_RATIO = 2.1;
const MEDIA_NAME = /^[a-f0-9-]{36}\.(png|jpg)$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Fragmentos PNG que conservan la imagen; el resto (tEXt, eXIf, tIME, iTXt…) se quita.
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS']);

function errorOf(code, message) {
  return { ok: false, code, error: message };
}

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_DATA_URL_CHARS) {
    return errorOf('image_too_large', 'La imagen supera 350 KB.');
  }
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return errorOf('invalid_image', 'Sube una imagen PNG o JPEG.');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) return errorOf('invalid_image', 'La imagen está vacía.');
  if (buffer.length > MAX_IMAGE_BYTES) return errorOf('image_too_large', 'La imagen supera 350 KB.');
  return { ok: true, buffer, declaredMime: match[1] };
}

// Lee las dimensiones de PNG o JPEG a partir de su estructura binaria.
function measure(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(PNG_SIGNATURE) && buffer.toString('ascii', 12, 16) === 'IHDR') {
    return { mime: 'image/png', ext: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buffer.length) {
      if (buffer[i] !== 0xff) return null;
      const marker = buffer[i + 1];
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const length = buffer.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return { mime: 'image/jpeg', ext: 'jpg', height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
      }
      if (marker === 0xda) return null; // datos de escaneo antes de SOF: archivo inválido
      i += 2 + length;
    }
  }
  return null;
}

// Quita metadatos conservando solo los fragmentos necesarios para pintar la imagen.
// Para JPEG se eliminan APP1–APP15 (EXIF, XMP, miniaturas) y COM; APP0 (JFIF) se conserva.
function stripMetadata(buffer, ext) {
  if (ext === 'png') {
    const out = [PNG_SIGNATURE];
    let i = 8;
    while (i + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(i);
      const type = buffer.toString('ascii', i + 4, i + 8);
      const end = i + 12 + length;
      if (end > buffer.length) return null;
      if (PNG_KEEP.has(type)) out.push(buffer.subarray(i, end));
      i = end;
      if (type === 'IEND') break;
    }
    return Buffer.concat(out);
  }
  const out = [buffer.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buffer.length) {
    if (buffer[i] !== 0xff) return null;
    const marker = buffer[i + 1];
    if (marker === 0xda) { out.push(buffer.subarray(i)); break; } // desde el escaneo, sin tocar
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { out.push(buffer.subarray(i, i + 2)); i += 2; continue; }
    const length = buffer.readUInt16BE(i + 2);
    const isMetadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!isMetadata) out.push(buffer.subarray(i, i + 2 + length));
    i += 2 + length;
  }
  return Buffer.concat(out);
}

// Valida y prepara una creatividad: firma real, dimensiones, proporción y metadatos.
function prepareImage(dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed.ok) return parsed;
  const info = measure(parsed.buffer);
  if (!info) return errorOf('invalid_image', 'El archivo no es un PNG o JPEG válido.');
  if (info.width < MIN_WIDTH || info.width > MAX_WIDTH || info.height < MIN_HEIGHT || info.height > MAX_HEIGHT) {
    return errorOf('image_dimensions', `La imagen debe medir entre ${MIN_WIDTH} y ${MAX_WIDTH} px de ancho y entre ${MIN_HEIGHT} y ${MAX_HEIGHT} px de alto.`);
  }
  const ratio = info.width / info.height;
  if (ratio < MIN_RATIO || ratio > MAX_RATIO) {
    return errorOf('image_dimensions', 'La imagen debe ser apaisada (proporción entre 1.5:1 y 2.1:1).');
  }
  const clean = stripMetadata(parsed.buffer, info.ext);
  if (!clean || !measure(clean)) return errorOf('invalid_image', 'No se pudo procesar la imagen.');
  return { ok: true, buffer: clean, mime: info.mime, ext: info.ext, width: info.width, height: info.height };
}

function newMediaName(ext) {
  return `${crypto.randomUUID()}.${ext}`;
}

function mediaPath(dir, name) {
  if (typeof name !== 'string' || !MEDIA_NAME.test(name)) return null;
  return path.join(dir, name);
}

function saveMedia(dir, buffer, ext) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = newMediaName(ext);
  fs.writeFileSync(path.join(dir, name), buffer, { mode: 0o600, flag: 'wx' });
  return name;
}

function readMedia(dir, name) {
  const file = mediaPath(dir, name);
  if (!file) return null;
  try { return fs.readFileSync(file); } catch (_) { return null; }
}

function removeMedia(dir, name) {
  const file = mediaPath(dir, name);
  if (!file) return false;
  try { fs.unlinkSync(file); return true; } catch (_) { return false; }
}

function mimeOfName(name) {
  return String(name).endsWith('.png') ? 'image/png' : 'image/jpeg';
}

// Retención: decide qué imágenes deben borrarse ahora y las elimina.
// `profiles` es un iterable de perfiles; `getMatch(id)` devuelve el partido.
function sweepPromotionMedia({ profileList, getMatch, dir, now = Date.now() }) {
  const expired = [];
  for (const profile of profileList) {
    const promotions = Array.isArray(profile.promotions) ? profile.promotions : [];
    for (const promotion of promotions) {
      if (!promotion || !promotion.imageFile) continue;
      const match = getMatch(promotion.matchId);
      const started = !match || match.status !== 'scheduled' || Number(match.scheduledKickoffAt) <= now;
      if (promotion.status === 'rejected' || started) {
        removeMedia(dir, promotion.imageFile);
        promotion.imageFile = null;
        promotion.imageMime = null;
        expired.push({ profile, promotionId: promotion.id });
      }
    }
  }
  return expired;
}

module.exports = {
  MAX_IMAGE_BYTES,
  MEDIA_NAME,
  prepareImage,
  measure,
  stripMetadata,
  saveMedia,
  readMedia,
  removeMedia,
  mediaPath,
  mimeOfName,
  sweepPromotionMedia
};
