'use strict';

// Vista aislada del Estadio REAL y su motor oficial V2. No usa DATABASE_URL ni
// archivos de producción: prepara una temporada ficticia en un directorio temporal.
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { FootballStore } = require('../../lib/football-store');
const { current } = require('../../lib/football/v2/versions');
const { TOS_VERSION } = require('../../lib/terms');

const root = path.resolve(__dirname, '../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'estadio-v2-preview-'));
const socketPath = path.join(dir, 'server.sock');
const epoch = Date.UTC(2026, 10, 1, 19, 0, 30); // Día 1, 13:00:30 en México.
const store = new FootballStore(path.join(dir, 'football.json'));
const october = store.generateSeason('2026-10', { createdAt: Date.UTC(2026, 9, 1) });
for (let i = 0; i < 12; i++) {
  const result = store.settleMatch(october.calendar.matches[i].id, { home: i % 4, away: (i + 1) % 3 },
    { seasonMonth: '2026-10', now: Date.UTC(2026, 9, 30, 12, 0, i) });
  if (!result.ok) throw new Error(`No se pudieron preparar datos de prueba: ${result.reason}`);
}
store.closeSeason('2026-10');
const league = store.generateSeason('2026-11', { createdAt: epoch - 60000 });
const today = league.calendar.matches.filter(match => match.day === 1).sort((a, b) => a.scheduledKickoffAt - b.scheduledKickoffAt);
// `ESTADIO_PREVIEW_SPEED` acelera el reloj (segundos reales por minuto simulado)
// para revisar jugadas concretas —goles, cambios, faltas— sin esperar el ritmo
// oficial de 15 s/min. Con reloj acelerado los partidos se encadenan: cada uno
// arranca cuando el anterior termina, en vez de dejar huecos de 12 minutos.
const previewSpeed = Number(process.env.ESTADIO_PREVIEW_SPEED);
const accelerated = Number.isFinite(previewSpeed) && previewSpeed > 0 && previewSpeed < 15;
const spacingMs = accelerated ? Math.round(90 * previewSpeed * 1000) + 20000 : 12 * 60 * 1000;
// Un encuentro ya está en juego y los siguientes arrancan progresivamente para
// que la vista siga teniendo fútbol mientras el usuario explora el Estadio.
today.forEach((match, index) => { match.scheduledKickoffAt = epoch - 15000 + index * spacingMs; });
store.close();

const childEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development',
  PORT: '39271', NODE_OPTIONS: `--require=${path.join(__dirname, 'runtime.js')}`,
  ESTADIO_PREVIEW_EPOCH: String(epoch), ESTADIO_PREVIEW_SOCKET: socketPath,
  CASINO_TIME_ZONE: 'America/Mexico_City', FOOTBALL_ENABLED: 'on',
  ...(accelerated ? { FOOTBALL_SIM_SECONDS_PER_MINUTE: String(previewSpeed) } : {}),
  PROFILE_STORE_PATH: path.join(dir, 'profiles.json'), FOOTBALL_STORE_PATH: path.join(dir, 'football.json'),
  COMMUNITY_STORE_PATH: path.join(dir, 'community.json'), LOBBY_TOURNAMENT_STORE_PATH: path.join(dir, 'tournaments.json'),
  PROMOTION_MEDIA_DIR: path.join(dir, 'promotions'), LOTERIA_ENABLED: 'off', FORTUNE_ENABLED: 'off', LOG_JSON: 'off'
};
const backend = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let started = false;
let shuttingDown = false;
const script = `window.__stadiumPreviewTos=${JSON.stringify(TOS_VERSION)};window.__stadiumPreviewVersion=${JSON.stringify(current.VERSION)};\n`
  + fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');

function safeHeaders(headers) {
  const copy = { ...headers };
  delete copy['x-frame-options']; // El proxy aislado sí permite el iframe de la vista previa.
  if (copy['content-security-policy']) copy['content-security-policy'] = copy['content-security-policy'].replace(/frame-ancestors[^;]*/i, 'frame-ancestors *');
  return copy;
}
const proxy = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://preview.invalid').pathname;
  if (pathname === '/' || pathname === '/estadio-simulador' || pathname === '/estadio-simulador/' || pathname === '/estadio-simulador.html') {
    res.writeHead(302, { Location: '/estadio', 'Cache-Control': 'no-store' }); res.end(); return;
  }
  if (pathname === '/__stadium_preview.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(script); return;
  }
  const inject = req.method === 'GET' && pathname === '/estadio';
  const headers = { ...req.headers };
  if (inject) headers['accept-encoding'] = 'identity';
  const request = http.request({ socketPath, method: req.method, path: req.url, headers }, response => {
    const resultHeaders = safeHeaders(response.headers);
    if (!inject || response.statusCode !== 200) {
      res.writeHead(response.statusCode, resultHeaders); response.pipe(res); return;
    }
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => {
      const html = Buffer.concat(chunks).toString('utf8').replace('<script src="/estadio.js"></script>',
        '<script src="/__stadium_preview.js"></script>\n  <script src="/estadio.js"></script>');
      delete resultHeaders['content-length']; delete resultHeaders.etag; delete resultHeaders['last-modified'];
      resultHeaders['cache-control'] = 'no-store';
      res.writeHead(response.statusCode, resultHeaders); res.end(html);
    });
  });
  request.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('El Estadio de prueba no está disponible.'); });
  req.pipe(request);
});
proxy.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(socketPath, () => {
    let message = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) message += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    upstream.write(message + '\r\n');
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});
function stop(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true; proxy.close(); backend.kill('SIGTERM');
  const timer = setTimeout(() => { backend.kill('SIGKILL'); }, 5000); timer.unref();
  backend.once('exit', () => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(code); });
}
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
backend.on('exit', code => {
  if (!shuttingDown) {
    console.error(`El servidor de la demo terminó inesperadamente (${code}).`);
    fs.rmSync(dir, { recursive: true, force: true }); process.exit(code || 1);
  }
});
let output = '';
backend.stdout.on('data', chunk => {
  output += chunk.toString();
  if (!started && output.includes('MonteCristo lista en')) {
    started = true;
    const value = process.env.PORT == null ? 3001 : Number(process.env.PORT);
    if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error('Puerto de vista previa inválido');
    proxy.listen(value, '0.0.0.0', () => console.log(`Vista Estadio V2 lista en el puerto ${proxy.address().port}`));
  }
});
backend.stderr.pipe(process.stderr);
