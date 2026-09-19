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

test('artists_created counts only newly created artists', () => {
  const db = freshDb();
  const first = load(db, 'testshow_tracks.csv');
  assert.equal(first.artists_created, 2, 'Mägi/MÄGI collapse to one; the blank artist creates none');
  const second = load(db, 'testshow_tracks.csv');
  assert.equal(second.artists_created, 0, 're-import creates no new artists');
  db.close();
});

test('a shows-file re-import does not wipe an existing date', () => {
  const db = freshDb();
  load(db, 'testshow_tracks.csv');
  const before = db.prepare('SELECT show_date FROM shows WHERE content_id = 1610000001').get();

  // A shows-kind row for the same episode whose date is unparseable ("?" -> null).
  const csv = 'show_title,show_date,show_url,track_count\n'
            + 'Uus pealkiri,?,https://r2.err.ee/1610000001/testsaade,9\n';
  const r = importCsv({ db, filename: 'testshow_shows.csv', buffer: Buffer.from(csv, 'utf8') });
  assert.equal(r.ok, true);

  const after = db.prepare(
    'SELECT show_date, title, track_count FROM shows WHERE content_id = 1610000001').get();
  assert.equal(after.show_date, before.show_date, 'a NULL date must not overwrite the stored one');
  assert.equal(after.title, 'Uus pealkiri', 'a non-null title still updates');
  assert.equal(after.track_count, 9, 'track_count still updates');
  db.close();
});

test('a failed import rolls back and reports no work done', () => {
  const db = freshDb();
  load(db, 'testshow_tracks.csv');
  const before = {
    shows: db.prepare('SELECT COUNT(*) AS n FROM shows').get().n,
    tracks: db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,
  };

  // Force a mid-transaction failure on the next track insert.
  db.exec(`CREATE TRIGGER boom BEFORE INSERT ON tracks BEGIN SELECT RAISE(ABORT, 'forced'); END`);
  const r = load(db, 'testshow_tracks.csv');

  assert.equal(r.ok, false);
  assert.match(r.message, /forced/);
  assert.equal(r.shows_upserted, 0, 'must not report work that was rolled back');
  assert.equal(r.tracks_inserted, 0);
  assert.equal(r.artists_created, 0);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shows').get().n, before.shows);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, before.tracks);
  db.close();
});
