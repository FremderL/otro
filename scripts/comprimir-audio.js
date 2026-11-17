#!/usr/bin/env node
'use strict';

// Convierte los WAV de assets a MP3. Un WAV mono de 45 s pesa 1.9 MB y el mismo
// audio en MP3 a 48 kbps pesa ~270 KB: siete veces menos y sin diferencia
// audible para un tema de fondo o un efecto de 2 s.
//
// Este script solo se usa al preparar los assets, nunca en producción: el
// servidor sirve los MP3 ya generados. Usa ffmpeg si está instalado y, si no,
// lameenc (pip install lameenc), que es LAME compilado sin binarios extra.
//
// Uso:
//   node scripts/comprimir-audio.js              # convierte todo lo que falte
//   node scripts/comprimir-audio.js --dry-run    # solo lista
//
// No borra los WAV: los deja como fuente, pero server y cliente ya no los piden.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'public', 'assets');
const DRY = process.argv.includes('--dry-run');

function findWavs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findWavs(full, out);
    else if (entry.name.toLowerCase().endsWith('.wav')) out.push(full);
  }
  return out;
}

// ffmpeg si está (mejor calidad y velocidad); si no, el codificador propio.
function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function encodeWithFfmpeg(src, dest) {
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', src,
    '-ac', '1', '-ar', '44100', '-b:a', '48k',
    '-map_metadata', '-1', dest
  ], { stdio: 'inherit' });
}

// Sin ffmpeg, se usa lameenc (pip install lameenc): es un binding directo a
// LAME y evita meter un binario de 70 MB en la imagen de producción.
function encodeWithLameenc(src, dest) {
  const python = [
    'import sys, wave, lameenc, audioop',
    'src, dest = sys.argv[1], sys.argv[2]',
    'w = wave.open(src); ch, sr = w.getnchannels(), w.getframerate()',
    'data = w.readframes(w.getnframes()); w.close()',
    'if ch > 1: data = audioop.tomono(data, 2, 0.5, 0.5)',
    'enc = lameenc.Encoder()',
    'enc.set_bit_rate(48); enc.set_in_sample_rate(44100); enc.set_channels(1); enc.set_quality(5)',
    'open(dest, "wb").write(bytes(enc.encode(data)) + bytes(enc.flush()))'
  ].join('\n');
  execFileSync('python3', ['-c', python, src, dest], { stdio: 'inherit' });
}

function hasLameenc() {
  try {
    execFileSync('python3', ['-c', 'import lameenc'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function main() {
  const files = findWavs(ASSETS);
  const useFfmpeg = hasFfmpeg();
  const useLameenc = !useFfmpeg && hasLameenc();
  if (!useFfmpeg && !useLameenc) {
    console.error('Hace falta ffmpeg o lameenc (pip install lameenc). Abortando.');
    process.exit(1);
  }
  let before = 0;
  let after = 0;
  let converted = 0;

  console.log(`\n${files.length} archivos WAV · codificador: ${useFfmpeg ? 'ffmpeg' : 'lameenc (MP3 48 kbps mono)'}\n`);

  for (const src of files) {
    const dest = src.replace(/\.wav$/i, '.mp3');
    const srcSize = fs.statSync(src).size;
    before += srcSize;
    if (fs.existsSync(dest)) {
      after += fs.statSync(dest).size;
      console.log(`  = ${path.relative(ROOT, dest)} (ya existe)`);
      continue;
    }
    if (DRY) {
      console.log(`  · ${path.relative(ROOT, src)} (${Math.round(srcSize / 1024)} KB)`);
      after += srcSize;
      continue;
    }
    if (useFfmpeg) encodeWithFfmpeg(src, dest);
    else encodeWithLameenc(src, dest);
    const destSize = fs.statSync(dest).size;
    after += destSize;
    converted += 1;
    const pct = Math.round((1 - destSize / srcSize) * 100);
    console.log(`  ✓ ${path.relative(ROOT, dest)}  ${Math.round(srcSize / 1024)} KB → ${Math.round(destSize / 1024)} KB (−${pct} %)`);
  }

  console.log(`\nTotal: ${(before / 1048576).toFixed(1)} MB → ${(after / 1048576).toFixed(1)} MB${DRY ? ' (simulación)' : ` · ${converted} convertidos`}`);
}

main();
