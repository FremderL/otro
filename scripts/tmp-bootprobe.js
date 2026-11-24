// TEMPORAL: arranca server.js con Postgres y reporta dónde se cuelga.

          const { randomUUID } = require('node:crypto');
          const { spawn } = require('node:child_process');
          const { Pool } = require('pg');
          const fs = require('fs'), os = require('os'), path = require('path');
          (async () => {
            const URL = process.env.FOOTBALL_TEST_DATABASE_URL;
            const schema = 'w_' + randomUUID().replace(/-/g, '');
            const admin = new Pool({ connectionString: URL });
            await admin.query('CREATE SCHEMA ' + schema);
            const dbUrl = URL + (URL.includes('?') ? '&' : '?') + new URLSearchParams({ options: '-c search_path=' + schema });
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtr-'));
            const reports = path.join(dir, 'reports'); fs.mkdirSync(reports);
            const env = { ...process.env, DATABASE_URL: dbUrl, FOOTBALL_ENABLED: 'on', NODE_ENV: 'test',
              FOOTBALL_WRITER_WAIT_MS: '3000', LOG_JSON: 'off', LOTERIA_ENABLED: 'off', FORTUNE_ENABLED: 'off',
              AUTO_BOTS: 'off', SHUTDOWN_GRACE_MS: '100', PROMOTION_MEDIA_DIR: dir,
              PROFILE_STORE_PATH: path.join(dir, 'p.json'), FOOTBALL_STORE_PATH: path.join(dir, 'f.json'),
              COMMUNITY_STORE_PATH: path.join(dir, 'c.json'), LOBBY_TOURNAMENT_STORE_PATH: path.join(dir, 't.json') };
            delete env.PORT; env.NODE_OPTIONS = '--require=' + path.join(process.cwd(), 'scripts/bootsql.js');
            const cpuDir = path.join(dir, 'cpu'); fs.mkdirSync(cpuDir);
            const child = spawn(process.execPath, ['--cpu-prof', '--cpu-prof-dir', cpuDir,
              '--report-on-signal', '--report-signal=SIGUSR2',
              '--report-directory', reports, 'server.js'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
            const extra = [];
            let text = '';
            child.stdout.on('data', c => { text += c; });
            child.stderr.on('data', c => { text += c; });
            const wait = ms => new Promise(r => setTimeout(r, ms));
            const t0 = Date.now();
            for (let i = 0; i < 480 && !/MonteCristo lista/.test(text) && child.exitCode === null; i++) await wait(250);
            console.log('::error::BOOTMS ' + (Date.now() - t0));
            const listened = /MonteCristo lista/.test(text);
            const resumen = 'escucho=' + listened + ' ms=' + (Date.now() - t0) + ' salida=' + child.exitCode + ' bytes=' + text.length;
            const bench = Date.now();
            for (let i = 0; i < 100; i++) await admin.query('SELECT 1');
            console.log('::error::BASE100 ' + (Date.now() - bench));
            try {
              const snap = await admin.query("select pid, state, wait_event_type, wait_event, left(coalesce(query,''), 200) as q from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() order by query_start");
            for (const r of snap.rows) extra.push('PG|' + JSON.stringify(r).slice(0, 200));
              extra.push('SESIONES ' + snap.rowCount);
            } catch (e) { console.log('::error::PGSNAP ' + e.message); }
            console.log('::error::BOOT escucho=' + listened + ' salida=' + child.exitCode + ' bytes=' + text.length);
            if (true) {
              child.kill('SIGUSR2');
              await wait(4000);
              const linesAll = text.split('\n').filter(l => l.trim());
            const retries = linesAll.filter(l => /reintentando|Reintent/i.test(l));
            console.log('::error::REINTENTOS ' + retries.length + ' ' + retries.slice(0, 1).join(' ').slice(0, 200));
            const stamps = linesAll.map(l => { const m = /"(\d{4}-\d\d-\d\dT[\d:.]+Z)"/.exec(l); return m ? m[1].slice(11, 23) + ' ' + (/"(event|type)":"([^"]+)"/.exec(l) || [])[2] : null; }).filter(Boolean);
            const snaps = text.split('\n').filter(l => /^SNAPSHOT/.test(l));
            extra.push('SNAPS ' + snaps.length + ' :: ' + snaps.slice(0, 6).join(' ;; ').slice(0, 1600));
            extra.push('LINEA ' + stamps.slice(-24).join(' | ').slice(0, 700));
            const sqls = text.split('\n').filter(l => /^SQL#/.test(l));
            const groups = new Map();
            for (const line of sqls) {
              const m = /^SQL#\d+ (\d+)ms (\S+) (.*)$/.exec(line);
              if (!m) continue;
              const key = m[2] + ' ' + m[3].replace(/\$\d+/g, '?').slice(0, 55);
              const g = groups.get(key) || { n: 0, ms: 0, max: 0 };
              g.n += 1; g.ms += Number(m[1]); g.max = Math.max(g.max, Number(m[1]));
              groups.set(key, g);
            }
            const top = [...groups.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8);
            extra.push('SQLS total=' + sqls.length + ' :: ' + top.map(([k, g]) => `n=${g.n} ms=${g.ms} max=${g.max} ${k}`).join(' ;; ').slice(0, 800));
            const files = fs.readdirSync(reports).filter(f => f.endsWith('.json'));
              if (!files.length) console.log('::error::BOOT sin informe');
              for (const f of files) {
                const rep = JSON.parse(fs.readFileSync(path.join(reports, f), 'utf8'));
                const stack = String((rep.javascriptStack && rep.javascriptStack.stack) || 'sin stack').split('\n');
                console.log('::error::BOOTJS ' + stack.slice(0, 7).join(' // ').slice(0, 900));
                const handles = (rep.libuv || []).map(h => h.type + (h.is_active ? '*' : '')).join(',');
                console.log('::error::BOOTUV ' + handles.slice(0, 500));
                const real = text.split('\n').filter(l => l.trim() && !/TRACE /.test(l));
                console.log('::error::BOOTLOG ' + real.slice(-4).join(' // ').slice(0, 500));
              }
            }
            child.kill('SIGKILL');
            await wait(1500);
            const prof = fs.readdirSync(cpuDir).filter(f => f.endsWith('.cpuprofile'));
            console.log('::error::CPUPERF archivos=' + prof.length);
            for (const f of prof) {
              const data = JSON.parse(fs.readFileSync(path.join(cpuDir, f), 'utf8'));
              const self = new Map();
              let totalHits = 0;
              for (const node of data.nodes) {
                const hits = node.hitCount || 0; totalHits += hits;
                const name = (node.callFrame.functionName || '(anónima)') + ' @ ' + (node.callFrame.url || '').split('/').slice(-2).join('/') + ':' + node.callFrame.lineNumber;
                self.set(name, (self.get(name) || 0) + hits);
              }
              const sorted = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
              extra.push('CPUTOP hits=' + totalHits + ' :: ' + sorted.map(([k, v]) => `${Math.round(100 * v / (totalHits || 1))}% ${k}`).join(' ;; ').slice(0, 1100));
            }
            await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
            await admin.end();
            fs.rmSync(dir, { recursive: true, force: true });
            console.log('::error::RESUMEN ' + [resumen, ...extra].join(' ;; ').slice(0, 6000));
            process.exit(0);
          })().catch(e => { console.log('::error::BOOT FALLO ' + e.message); process.exit(0); });
          