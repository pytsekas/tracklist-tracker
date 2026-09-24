import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { buildDatabase } from '../src/build-db.js';
import { openDb } from '../src/db.js';
import routes from '../src/routes.js';
import { createSqliteStore } from '../src/annotations/sqlite.js';
import { createAnnotationTable, loadAnnotations } from '../src/annotations/temp-table.js';
import { requireUser } from '../src/auth.js';
import { setStore } from '../src/annotations/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CSV = path.join(__dirname, 'fixtures/csv');

const DEV_USER = 'dev@localhost';
let store;
let handle;

let server;
let base;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-routes-'));
  const out = path.join(dir, 'test.sqlite');
  buildDatabase({ csvDir: FIXTURE_CSV, outPath: out });
  handle = openDb(out);

  store = createSqliteStore(path.join(dir, 'annotations.sqlite'));
  setStore(store);
  createAnnotationTable(handle);
  loadAnnotations(handle, await store.list(DEV_USER));

  const app = express();
  app.use(express.json());
  app.use('/api', requireUser({ devEmail: DEV_USER }), routes);
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); store?.close(); handle?.close(); });

// Tolerant of non-JSON bodies on purpose: an unmatched route yields Express's
// default text/html 404, and a bare res.json() would throw SyntaxError inside
// the helper instead of letting the test assert on the status it cares about.
const get = async p => {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('GET /api/stats returns row counts', async () => {
  const { body } = await get('/api/stats');
  assert.deepEqual(body, { series: 1, shows: 3, tracks: 4, artists: 2 });
});

test('GET /api/series aggregates shows and dates', async () => {
  const { body } = await get('/api/series');
  assert.equal(body.length, 1);
  assert.equal(body[0].slug, 'testshow');
  assert.equal(body[0].show_count, 3);
  assert.equal(body[0].track_count, 4);
  assert.equal(body[0].first_show, '2024-02-01');
  assert.equal(body[0].last_show, '2024-04-20');
});

test('GET /api/series/:slug/shows paginates newest first', async () => {
  const { body } = await get('/api/series/testshow/shows?page=1&pageSize=2');
  assert.equal(body.total, 3);
  assert.equal(body.rows.length, 2);
  assert.equal(body.rows[0].content_id, 1610000003, 'newest show first');
});

test('GET /api/shows/:id returns tracks in play order', async () => {
  const { body: list } = await get('/api/series/testshow/shows');
  const first = list.rows.find(r => r.content_id === 1610000001);

  const { body } = await get(`/api/shows/${first.id}`);
  assert.equal(body.show.series_slug, 'testshow');
  assert.deepEqual(body.tracks.map(t => t.position), [1, 2, 3]);
  assert.equal(body.tracks[0].artist, 'Mägi');
  assert.equal(body.tracks[2].artist, null, 'blank artist stays null');
});

test('GET /api/shows/:id 404s for an unknown id', async () => {
  const { status } = await get('/api/shows/999999');
  assert.equal(status, 404);
});

test('GET /api/tracks folds case across Estonian letters', async () => {
  const { body } = await get('/api/tracks?q=õhtu');
  assert.equal(body.total, 1);
  assert.equal(body.rows[0].title, 'Õhtu jõuab');

  const upper = await get('/api/tracks?q=ÕHTU');
  assert.equal(upper.body.total, 1, 'uppercase needle matches too');
});

test('GET /api/tracks keeps diacritics distinct', async () => {
  const { body } = await get('/api/tracks?q=magi');
  assert.equal(body.total, 0, '"magi" must not match "Mägi"');
});

test('GET /api/tracks matches on artist name too', async () => {
  const { body } = await get('/api/tracks?q=ansambel');
  assert.equal(body.total, 1);
  assert.equal(body.rows[0].title, 'Sada protsenti');
});

test('GET /api/tracks treats % as a literal, not a wildcard', async () => {
  const { body } = await get('/api/tracks?q=%25');   // %25 is an encoded "%"
  assert.equal(body.total, 1, 'matches only the artist literally containing "%"');
  assert.equal(body.rows[0].title, 'Sada protsenti');
});

test('GET /api/tracks filters by date range', async () => {
  const { body } = await get('/api/tracks?from=2024-03-01');
  assert.equal(body.total, 1);
  assert.equal(body.rows[0].title, 'Sada protsenti');
});

test('GET /api/tracks paginates', async () => {
  const { body } = await get('/api/tracks?page=1&pageSize=2');
  assert.equal(body.total, 4);
  assert.equal(body.rows.length, 2);

  const p2 = await get('/api/tracks?page=2&pageSize=2');
  assert.equal(p2.body.rows.length, 2);
  assert.notDeepEqual(p2.body.rows[0].id, body.rows[0].id);
});

test('GET /api/artists ranks by play count', async () => {
  const { body } = await get('/api/artists');
  assert.equal(body.rows[0].name, 'Mägi');
  assert.equal(body.rows[0].plays, 2);
  assert.equal(body.rows[1].plays, 1);
});

test('GET /api/artists filters on the normalised name', async () => {
  const { body } = await get('/api/artists?q=MÄGI');
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].name, 'Mägi');
});

test('GET /api/artists/:id lists every play', async () => {
  const { body: list } = await get('/api/artists');
  const { body } = await get(`/api/artists/${list.rows[0].id}`);
  assert.equal(body.artist.name, 'Mägi');
  assert.equal(body.tracks.length, 2);
});

test('the import endpoints are gone', async () => {
  assert.equal((await get('/api/imports')).status, 404);

  const res = await fetch(`${base}/api/import`, { method: 'POST' });
  assert.equal(res.status, 404);
});

test('GET /api/series/:slug/shows returns a null annotation when untouched', async () => {
  const { body } = await get('/api/series/testshow/shows');
  assert.ok(body.rows.every(r => r.annotation === null));
});

test('GET /api/shows/:id returns a null annotation when untouched', async () => {
  const { body: list } = await get('/api/series/testshow/shows');
  const { body } = await get(`/api/shows/${list.rows[0].id}`);
  assert.equal(body.annotation, null);
});

test('an annotation in the temp table surfaces on both read routes', async () => {
  await store.merge(DEV_USER, 1610000001, { listened: true, rating: 4, tags: ['suvi'] });
  loadAnnotations(handle, await store.list(DEV_USER));

  const { body: list } = await get('/api/series/testshow/shows');
  const row = list.rows.find(r => r.content_id === 1610000001);
  assert.equal(row.annotation.listened, true);
  assert.equal(row.annotation.rating, 4);
  assert.deepEqual(row.annotation.tags, ['suvi']);

  const { body: one } = await get(`/api/shows/${row.id}`);
  assert.equal(one.annotation.listened, true);
  assert.deepEqual(one.annotation.tags, ['suvi']);
});

test('annotations do not disturb the existing show fields', async () => {
  const { body } = await get('/api/series/testshow/shows?page=1&pageSize=2');
  assert.equal(body.total, 3);
  assert.equal(body.rows.length, 2);
  assert.equal(body.rows[0].content_id, 1610000003, 'still newest first');
});
