import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createDatabase, buildDatabase, DEFAULT_SERIES, DEFAULT_BROADCASTERS }
  from '../src/build-db.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-')), 'test.sqlite');
}

test('createDatabase applies the schema', () => {
  const db = createDatabase(tmpFile());
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
  ).all().map(r => r.name);
  assert.deepEqual(tables, ['artists', 'broadcasters', 'series', 'shows', 'tracks']);
  db.close();
});

test('createDatabase does not create an imports table', () => {
  const db = createDatabase(tmpFile());
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'imports'`
  ).get();
  assert.equal(row, undefined);
  db.close();
});

test('createDatabase enforces foreign keys', () => {
  const db = createDatabase(tmpFile());
  assert.throws(
    () => db.prepare(
      `INSERT INTO shows (content_id, series_id, title, track_count)
       VALUES (1, 999, 'orphan', 0)`
    ).run(),
    /FOREIGN KEY constraint failed/
  );
  db.close();
});

test('createDatabase starts from empty each time', () => {
  const file = tmpFile();
  const first = createDatabase(file);
  first.prepare(`INSERT INTO series (slug, name) VALUES ('x', 'X')`).run();
  first.close();

  const second = createDatabase(file);
  assert.equal(second.prepare(`SELECT COUNT(*) AS n FROM series`).get().n, 0);
  second.close();
});

const FIXTURE_CSV = path.join(
  path.dirname(fileURLToPath(import.meta.url)), 'fixtures/csv'
);

test('buildDatabase imports every csv and reports counts', () => {
  const out = tmpFile();
  const { counts } = buildDatabase({ csvDir: FIXTURE_CSV, outPath: out });

  assert.deepEqual(counts, { series: 1, shows: 3, tracks: 4, artists: 2 });
  assert.ok(fs.existsSync(out), 'writes the database to outPath');
  assert.ok(!fs.existsSync(`${out}.building`), 'cleans up the temporary file');
});

test('buildDatabase produces a readable database', () => {
  const out = tmpFile();
  buildDatabase({ csvDir: FIXTURE_CSV, outPath: out });

  const db = new Database(out, { readonly: true, fileMustExist: true });
  const titles = db.prepare(`SELECT title FROM tracks ORDER BY id`).all().map(r => r.title);
  assert.ok(titles.includes('Õhtu jõuab'));
  db.close();
});

test('buildDatabase is deterministic', () => {
  // Logical equivalence, not byte equality: created_at/updated_at embed the
  // build time via datetime('now'), so two builds are never byte-identical.
  // Do not "strengthen" this into a file hash comparison - it will flake.
  const a = tmpFile();
  const b = tmpFile();
  const first = buildDatabase({ csvDir: FIXTURE_CSV, outPath: a });
  const second = buildDatabase({ csvDir: FIXTURE_CSV, outPath: b });
  assert.deepEqual(first.counts, second.counts);
});

test('buildDatabase refuses a missing csv directory', () => {
  assert.throws(
    () => buildDatabase({ csvDir: '/nonexistent/csv', outPath: tmpFile() }),
    /CSV directory not found/
  );
});

test('buildDatabase refuses an empty csv directory', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-empty-'));
  assert.throws(
    () => buildDatabase({ csvDir: empty, outPath: tmpFile() }),
    /No CSV files/
  );
});

test('buildDatabase refuses a file it cannot recognise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-bad-'));
  fs.copyFileSync(path.join(FIXTURE_CSV, 'testshow_tracks.csv'),
    path.join(dir, 'testshow_tracks.csv'));
  fs.writeFileSync(path.join(dir, 'mystery.csv'), 'foo,bar\n1,2\n');

  const out = tmpFile();
  assert.throws(
    () => buildDatabase({ csvDir: dir, outPath: out }),
    /Unrecognised columns/
  );
  assert.ok(!fs.existsSync(out), 'leaves no database behind on failure');
});

test('normalised ordering is case-insensitive, raw ordering is not', () => {
  // Pins the collation behaviour the /api/artists and /api/series ORDER BY
  // clauses depend on. MariaDB's utf8mb4_unicode_ci was case-insensitive;
  // SQLite's default BINARY collation is not, which silently reordered both
  // lists during the migration.
  const db = createDatabase(tmpFile());
  const ins = db.prepare('INSERT INTO artists (name, name_norm) VALUES (?, ?)');
  for (const n of ['Zorro', 'abba', 'Beatles', 'the Who']) ins.run(n, n.toLowerCase());

  const byName = db.prepare('SELECT name FROM artists ORDER BY name').all().map(r => r.name);
  const byNorm = db.prepare('SELECT name FROM artists ORDER BY name_norm').all().map(r => r.name);

  assert.deepEqual(byName, ['Beatles', 'Zorro', 'abba', 'the Who'],
    'raw BINARY collation puts every uppercase initial first');
  assert.deepEqual(byNorm, ['abba', 'Beatles', 'the Who', 'Zorro'],
    'name_norm restores the case-insensitive order MariaDB gave');
  db.close();
});

test('buildDatabase cleans up when the database cannot be created', () => {
  const out = tmpFile();
  // A directory cannot be opened as a SQLite database, so createDatabase()
  // throws - the one failure path that happens before the import loop.
  fs.mkdirSync(`${out}.building`);

  assert.throws(() => buildDatabase({ csvDir: FIXTURE_CSV, outPath: out }));
  assert.ok(!fs.existsSync(`${out}.building`), 'must not leave the temp path behind');
  assert.ok(!fs.existsSync(out), 'must not ship a database');
});

function jsonFile(name, config) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-json-')), name);
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}
const seriesFile = config => jsonFile('series.json', config);
const broadcastersFile = config => jsonFile('broadcasters.json', config);

test('buildDatabase sets archive_url from the series file', () => {
  const out = tmpFile();
  buildDatabase({
    csvDir: FIXTURE_CSV, outPath: out,
    seriesFile: seriesFile({ testshow: { archive_url: 'https://r2.err.ee/arhiiv/testshow' } }),
  });

  const db = new Database(out, { readonly: true, fileMustExist: true });
  const row = db.prepare(`SELECT archive_url FROM series WHERE slug = 'testshow'`).get();
  assert.equal(row.archive_url, 'https://r2.err.ee/arhiiv/testshow');
  db.close();
});

test('buildDatabase refuses a series file naming an unknown slug', () => {
  const out = tmpFile();
  assert.throws(
    () => buildDatabase({
      csvDir: FIXTURE_CSV, outPath: out,
      seriesFile: seriesFile({ tsetshow: { archive_url: 'https://r2.err.ee/arhiiv/x' } }),
    }),
    /series\.json names unknown series: tsetshow/
  );
  assert.ok(!fs.existsSync(out), 'leaves no database behind on failure');
});

const ERR = { name: 'ERR', url: 'https://www.err.ee/' };

test('buildDatabase inserts broadcasters from the broadcasters file', () => {
  const out = tmpFile();
  buildDatabase({
    csvDir: FIXTURE_CSV, outPath: out,
    broadcastersFile: broadcastersFile({ err: ERR }),
  });

  const db = new Database(out, { readonly: true, fileMustExist: true });
  const rows = db.prepare(`SELECT slug, name, url FROM broadcasters`).all();
  assert.deepEqual(rows, [{ slug: 'err', name: 'ERR', url: 'https://www.err.ee/' }]);
  db.close();
});

test('buildDatabase links a series to its broadcaster', () => {
  const out = tmpFile();
  buildDatabase({
    csvDir: FIXTURE_CSV, outPath: out,
    broadcastersFile: broadcastersFile({ err: ERR }),
    seriesFile: seriesFile({ testshow: { broadcaster: 'err' } }),
  });

  const db = new Database(out, { readonly: true, fileMustExist: true });
  const row = db.prepare(`
    SELECT b.slug FROM series s JOIN broadcasters b ON b.id = s.broadcaster_id
    WHERE s.slug = 'testshow'`).get();
  assert.equal(row?.slug, 'err');
  db.close();
});

test('buildDatabase leaves broadcaster_id NULL for a series without one', () => {
  const out = tmpFile();
  buildDatabase({
    csvDir: FIXTURE_CSV, outPath: out,
    broadcastersFile: broadcastersFile({ err: ERR }),
    seriesFile: seriesFile({ testshow: { archive_url: 'https://r2.err.ee/arhiiv/testshow' } }),
  });

  const db = new Database(out, { readonly: true, fileMustExist: true });
  const row = db.prepare(`SELECT broadcaster_id FROM series WHERE slug = 'testshow'`).get();
  assert.equal(row.broadcaster_id, null);
  db.close();
});

test('buildDatabase refuses a series naming an unknown broadcaster', () => {
  const out = tmpFile();
  assert.throws(
    () => buildDatabase({
      csvDir: FIXTURE_CSV, outPath: out,
      broadcastersFile: broadcastersFile({ err: ERR }),
      seriesFile: seriesFile({ testshow: { broadcaster: 'bbc' } }),
    }),
    /series\.json names unknown broadcaster: bbc/
  );
  assert.ok(!fs.existsSync(out), 'leaves no database behind on failure');
  assert.ok(!fs.existsSync(`${out}.building`), 'leaves no temp file behind on failure');
});

test('buildDatabase treats an explicit null broadcaster as none', () => {
  const out = tmpFile();
  buildDatabase({
    csvDir: FIXTURE_CSV, outPath: out,
    broadcastersFile: broadcastersFile({ err: ERR }),
    seriesFile: seriesFile({ testshow: { broadcaster: null } }),
  });

  const db = new Database(out, { readonly: true, fileMustExist: true });
  const row = db.prepare(`SELECT broadcaster_id FROM series WHERE slug = 'testshow'`).get();
  assert.equal(row.broadcaster_id, null);
  db.close();
});

test('buildDatabase refuses a broadcaster without a name', () => {
  const out = tmpFile();
  assert.throws(
    () => buildDatabase({
      csvDir: FIXTURE_CSV, outPath: out,
      broadcastersFile: broadcastersFile({ err: { url: 'https://www.err.ee/' } }),
    }),
    /broadcasters\.json: err has no name/
  );
  assert.ok(!fs.existsSync(out), 'leaves no database behind on failure');
  assert.ok(!fs.existsSync(`${out}.building`), 'leaves no temp file behind on failure');
});

// build:db cannot run in CI or on a fresh clone (the CSVs are not in git), so
// the committed JSON files are checked against each other here instead.
test('the committed series file only names broadcasters the broadcasters file defines', () => {
  const broadcasters = JSON.parse(fs.readFileSync(DEFAULT_BROADCASTERS, 'utf8'));
  const series = JSON.parse(fs.readFileSync(DEFAULT_SERIES, 'utf8'));
  for (const [slug, { broadcaster }] of Object.entries(series)) {
    if (broadcaster == null) continue;
    assert.ok(Object.hasOwn(broadcasters, broadcaster),
      `${slug} names unknown broadcaster ${broadcaster}`);
  }
});
