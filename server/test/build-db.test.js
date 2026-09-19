import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createDatabase, buildDatabase } from '../src/build-db.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-')), 'test.sqlite');
}

test('createDatabase applies the schema', () => {
  const db = createDatabase(tmpFile());
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
  ).all().map(r => r.name);
  assert.deepEqual(tables, ['artists', 'series', 'shows', 'tracks']);
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
