import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../src/build-db.js';
import { importCsv } from '../src/importer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures/csv');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-'));
  return createDatabase(path.join(dir, 'test.sqlite'));
}

function load(db, name) {
  return importCsv({ db, filename: name, buffer: fs.readFileSync(path.join(FIXTURES, name)) });
}

test('importing a tracks file fills series, shows, artists and tracks', () => {
  const db = freshDb();
  const r = load(db, 'testshow_tracks.csv');

  assert.equal(r.ok, true);
  assert.equal(r.kind, 'tracks');
  assert.equal(r.series_slug, 'testshow');
  assert.equal(r.rows_read, 4);
  assert.equal(r.shows_upserted, 2);
  assert.equal(r.tracks_inserted, 4);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM series').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shows').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, 4);
  db.close();
});

test('artists are deduplicated on the normalised name', () => {
  const db = freshDb();
  load(db, 'testshow_tracks.csv');

  // "Mägi" and "MÄGI" fold together; the blank artist creates no row.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM artists').get().n, 2);

  const magi = db.prepare('SELECT name FROM artists WHERE name_norm = ?').get('mägi');
  assert.equal(magi.name, 'Mägi', 'keeps the first spelling seen');
  db.close();
});

test('a blank artist becomes a NULL artist_id, not a dropped row', () => {
  const db = freshDb();
  load(db, 'testshow_tracks.csv');
  const row = db.prepare('SELECT artist_id FROM tracks WHERE title = ?').get('Nimeta lugu');
  assert.equal(row.artist_id, null);
  db.close();
});

test('tracks get a normalised title and 1-based positions', () => {
  const db = freshDb();
  load(db, 'testshow_tracks.csv');
  const rows = db.prepare(`
    SELECT t.position, t.title, t.title_norm
    FROM tracks t JOIN shows s ON s.id = t.show_id
    WHERE s.content_id = 1610000001 ORDER BY t.position`).all();

  assert.deepEqual(rows.map(r => r.position), [1, 2, 3]);
  assert.equal(rows[0].title, 'Õhtu jõuab');
  assert.equal(rows[0].title_norm, 'õhtu jõuab');
  db.close();
});

test('dates are stored as YYYY-MM-DD text', () => {
  const db = freshDb();
  load(db, 'testshow_tracks.csv');
  const show = db.prepare('SELECT show_date FROM shows WHERE content_id = 1610000001').get();
  assert.equal(show.show_date, '2024-02-01');
  db.close();
});

test('a shows file adds episodes that have no tracklist', () => {
  const db = freshDb();
  load(db, 'testshow_tracks.csv');
  load(db, 'testshow_shows.csv');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shows').get().n, 3);
  const gap = db.prepare('SELECT track_count FROM shows WHERE content_id = 1610000003').get();
  assert.equal(gap.track_count, 0);
  db.close();
});

test('re-importing the same file is idempotent', () => {
  const db = freshDb();
  load(db, 'testshow_tracks.csv');
  load(db, 'testshow_tracks.csv');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shows').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM artists').get().n, 2);
  db.close();
});

test('an unrecognised file is reported, not thrown', () => {
  const db = freshDb();
  const r = importCsv({
    db,
    filename: 'mystery.csv',
    buffer: Buffer.from('foo,bar\n1,2\n', 'utf8'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'unknown');
  assert.match(r.message, /Unrecognised columns/);
  db.close();
});
