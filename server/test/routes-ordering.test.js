import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { buildDatabase } from '../src/build-db.js';
import { openDb } from '../src/db.js';
import routes from '../src/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CSV = path.join(__dirname, 'fixtures/csv');

// Its own database and its own server. The shared fixture in routes.test.js
// has one series and two artists with different play counts, so it can never
// exercise a tie-break or a case-ordering difference. This file adds rows
// shaped specifically to expose SQLite's BINARY collation, which silently
// replaced MariaDB's case-insensitive utf8mb4_unicode_ci during the migration.
let server;
let base;

before(async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-ord-')), 'ord.sqlite');
  buildDatabase({ csvDir: FIXTURE_CSV, outPath: out });

  const w = new Database(out);
  const showId = w.prepare('SELECT id FROM shows WHERE content_id = 1610000001').get().id;
  const insArtist = w.prepare('INSERT INTO artists (name, name_norm) VALUES (?, ?)');
  const insTrack = w.prepare(
    'INSERT INTO tracks (show_id, artist_id, title, title_norm, position) VALUES (?, ?, ?, ?, ?)');

  // Four artists with exactly one play each, differing by initial case, so
  // the name is the only tie-break.
  let pos = 100;
  for (const name of ['Zorro', 'abba', 'Beatles', 'the Who']) {
    const id = insArtist.run(name, name.toLowerCase()).lastInsertRowid;
    insTrack.run(showId, id, `t ${name}`, `t ${name.toLowerCase()}`, pos++);
  }

  // Two extra series, mixed case, so series ordering is observable too.
  const insSeries = w.prepare('INSERT INTO series (slug, name) VALUES (?, ?)');
  insSeries.run('alpha_kanal', 'alpha kanal');
  insSeries.run('zeta_raadio', 'Zeta raadio');
  w.close();

  openDb(out);
  const app = express();
  app.use('/api', routes);
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

const get = async p => {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('GET /api/artists breaks equal play counts case-insensitively', async () => {
  const { body } = await get('/api/artists');
  assert.deepEqual(
    body.rows.map(r => r.name),
    ['Mägi', 'abba', 'Ansambel 50%', 'Beatles', 'the Who', 'Zorro'],
    'BINARY collation would give Ansambel/Beatles/Zorro/abba/the Who instead'
  );
});

test('GET /api/series orders case-insensitively', async () => {
  const { body } = await get('/api/series');
  assert.deepEqual(
    body.map(r => r.name),
    // The fixture series' name is derived from its CSV slug ("testshow")
    // via importer.js's prettify(), which gives "Testshow" - not the show
    // title "Testsaade" that appears inside the CSV data. Verified directly
    // against a built fixture database before writing this assertion.
    ['alpha kanal', 'Testshow', 'Zeta raadio'],
    'BINARY collation would put Testshow and Zeta raadio before alpha kanal'
  );
});
