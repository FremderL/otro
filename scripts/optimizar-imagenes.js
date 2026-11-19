#!/usr/bin/env node
'use strict';

// Regenera las versiones WebP de las imágenes de assets. Solo se ejecuta al
// preparar assets nuevos (o si alguien agrega una imagen a mano); el servidor
// no lo usa.
//
// Requisitos: ImageMagick (`convert`). En Debian/Ubuntu: apt install imagemagick.
//
// Uso:
//   node scripts/optimizar-imagenes.js            # genera lo que falte
//   node scripts/optimizar-imagenes.js --force    # regenera todo
//   node scripts/optimizar-imagenes.js --dry-run  # solo lista
//
// Reglas de tamaño, elegidas por cómo se pintan en la interfaz:
//   cartas     → 464 px de ancho (se muestran a 118 px; sobra para pantallas 4x)
//   lobby      → 900 px de ancho (ocupan media tarjeta a 1280 px)
//   banners    → 1200 px de ancho (fondo de cabecera a ancho completo)

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'public', 'assets');

const RULES = [
  { dir: path.join(ASSETS, 'cards'), width: 464, quality: 80 },
  { dir: path.join(ASSETS, 'banners'), width: 1200, quality: 78 },
  { dir: ASSETS, width: 900, quality: 78, match: /-lounge\.jpg$|^casino-hero\.jpg$|^estadio-tunnel\.jpg$/ }
];

const FORCE = process.argv.includes('--force');
const DRY = process.argv.includes('--dry-run');

function hasConvert() {
  const probe = spawnSync('convert', ['-version'], { stdio: 'ignore' });
  return probe.status === 0;
}

function listJpgs(rule) {
  if (!fs.existsSync(rule.dir)) return [];
  return fs.readdirSync(rule.dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.jpg'))
    .map(entry => entry.name)
    .filter(name => !rule.match || rule.match.test(name))
    .sort();
}

function main() {
  if (!hasConvert()) {
    console.error('Falta ImageMagick (`convert`). Instálalo o usa otro conversor.');
    process.exit(1);
  }

  let before = 0;
  let after = 0;
  let made = 0;

  for (const rule of RULES) {
    const files = listJpgs(rule);
    if (!files.length) continue;
    console.log(`\n${path.relative(ROOT, rule.dir)} · ${files.length} JPG → WebP ${rule.width}px q${rule.quality}`);
    for (const name of files) {
      const src = path.join(rule.dir, name);
      const dest = src.replace(/\.jpg$/i, '.webp');
      const srcSize = fs.statSync(src).size;
      before += srcSize;
      if (fs.existsSync(dest) && !FORCE) {
        after += srcSize;
        console.log(`  = ${name.replace(/\.jpg$/i, '.webp')} (ya existe)`);
        continue;
      }
      if (DRY) {
        console.log(`  · ${name} (${Math.round(srcSize / 1024)} KB)`);
        after += srcSize;
        continue;
      }
      const result = spawnSync('convert', [
        src, '-resize', `${rule.width}x`, '-quality', String(rule.quality), '-strip', dest
      ], { stdio: 'inherit' });
      if (result.status !== 0) {
        console.error(`  ✗ falló ${name}`);
        continue;
      }
      const destSize = fs.statSync(dest).size;
      after += destSize;
      made += 1;
      const pct = Math.round((1 - destSize / srcSize) * 100);
      console.log(`  ✓ ${name.replace(/\.jpg$/i, '.webp')}  ${Math.round(srcSize / 1024)} KB → ${Math.round(destSize / 1024)} KB (−${pct} %)`);
    }
  }

  console.log(`\nTotal de los JPG de origen: ${(before / 1048576).toFixed(1)} MB · WebP equivalentes: ${(after / 1048576).toFixed(1)} MB${DRY ? ' (simulación)' : ` · ${made} generados`}`);
  console.log('Los JPG se conservan como respaldo de <picture> y para navegadores sin WebP.');
}

main();
