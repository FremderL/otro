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
            const child = spawn(process.execPath, ['--report-on-signal', '--report-signal=SIGUSR2',
              '--report-directory', reports, 'server.js'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
            let text = '';
            child.stdout.on('data', c => { text += c; });
            child.stderr.on('data', c => { text += c; });
            const wait = ms => new Promise(r => setTimeout(r, ms));
            const t0 = Date.now();
            for (let i = 0; i < 480 && !/MonteCristo lista/.test(text) && child.exitCode === null; i++) await wait(250);
            console.log('::error::BOOTMS ' + (Date.now() - t0));
            const listened = /MonteCristo lista/.test(text);
            try {
              const snap = await admin.query("select pid, state, wait_event_type, wait_event, left(coalesce(query,''), 200) as q from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() order by query_start");
            for (const r of snap.rows) console.log('::error::PG|' + JSON.stringify(r).slice(0, 400));
              console.log('::error::PGSESIONES ' + snap.rowCount);
            } catch (e) { console.log('::error::PGSNAP ' + e.message); }
            console.log('::error::BOOT escucho=' + listened + ' salida=' + child.exitCode + ' bytes=' + text.length);
            if (!listened) {
              child.kill('SIGUSR2');
              await wait(4000);
              const linesAll = text.split('\n').filter(l => l.trim());
            const retries = linesAll.filter(l => /reintentando|Reintent/i.test(l));
            console.log('::error::REINTENTOS ' + retries.length + ' ' + retries.slice(0, 1).join(' ').slice(0, 200));
            const stamps = linesAll.map(l => { const m = /"(\d{4}-\d\d-\d\dT[\d:.]+Z)"/.exec(l); return m ? m[1].slice(11, 23) + ' ' + (/"(event|type)":"([^"]+)"/.exec(l) || [])[2] : null; }).filter(Boolean);
            console.log('::error::LINEA ' + stamps.slice(0, 30).join(' | ').slice(0, 900));
            console.log('::error::LINEB ' + stamps.slice(-30).join(' | ').slice(0, 900));
            const sqls = text.split('\n').filter(l => /^SQL#/.test(l));
            const slow = sqls.filter(l => / (\d+)ms /.test(l));
            const total = slow.reduce((a, l) => a + Number(/(\d+)ms /.exec(l)[1]), 0);
            console.log('::error::SQLS total=' + sqls.length + ' lentas=' + slow.length + ' msAcum=' + total);
            for (const line of slow.sort((a, b) => Number(/(\d+)ms /.exec(b)[1]) - Number(/(\d+)ms /.exec(a)[1])).slice(0, 6)) console.log('::error::SQL|' + line.slice(0, 200));
            for (const line of sqls.filter(l => /connect/.test(l)).slice(0, 4)) console.log('::error::CONN|' + line.slice(0, 200));
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
            await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
            await admin.end();
            fs.rmSync(dir, { recursive: true, force: true });
            process.exit(0);
          })().catch(e => { console.log('::error::BOOT FALLO ' + e.message); process.exit(0); });
          