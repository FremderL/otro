'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function main() {
  if (process.env.DATABASE_URL) {
    const { ProfileStore } = require('../lib/profile-store');
    const store = new ProfileStore();
    await store.ready;
    const profile = store.getOrCreate(`smoke-${process.pid}`, 'Smoke', 'robot');
    assert.equal(profile.avatar, 'robot');
    assert.equal(store.top(1)[0].id, profile.id);
    await store.close();
    console.log('Smoke de ProfileStore PostgreSQL: OK');
    return;
  }

  const file = path.join(os.tmpdir(), `montecristo-profile-${process.pid}.json`);
  fs.writeFileSync(file, '[]');
  const { ProfileStore } = require('../lib/profile-store');
  const store = new ProfileStore(file);
  const profile = store.getOrCreate('local-smoke', 'Local', 'panda');
  assert.equal(profile.chips, 1000);
  assert.equal(store.top(1)[0].id, 'local-smoke');
  store.saveNow();
  fs.rmSync(file, { force: true });
  console.log('Smoke de ProfileStore JSON (sin DATABASE_URL): OK');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
