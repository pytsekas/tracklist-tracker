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
import { requireUser } from '../src/auth.js';
import { createSqliteStore } from '../src/annotations/sqlite.js';
import { setStore } from '../src/annotations/index.js';
import { createAnnotationTable } from '../src/annotations/temp-table.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CSV = path.join(__dirname, 'fixtures/csv');
const DEV_USER = 'dev@localhost';

let server, base, store, handle;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-filters-'));
  const out = path.join(dir, 'test.sqlite');
  buildDatabase({ csvDir: FIXTURE_CSV, outPath: out });
  handle = openDb(out);
  createAnnotationTable(handle);

  store = createSqliteStore(path.join(dir, 'annotations.sqlite'));
  setStore(store);

  const app = express();
  app.use(express.json());
  app.use('/api', requireUser({ devEmail: DEV_USER }), routes);
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); store?.close(); handle?.close(); });

const get = async p => {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: await res.json().catch(() => null) };
};

const patch = async (p, body) => {
  const res = await fetch(`${base}${p}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/**
 * The fixture series `testshow` has exactly three shows: content_ids
 * 1610000001, 1610000002 and 1610000003. Every total below is relative to
 * those three, and each test sets up the state it asserts on.
 */
const reset = async () => {
  for (const id of [1610000001, 1610000002, 1610000003]) {
    await fetch(`${base}/api/shows/${id}/annotation`, { method: 'DELETE' });
  }
};

test('an unfiltered request is unchanged by the join', async () => {
  await reset();
  const { body } = await get('/api/series/testshow/shows');
  assert.equal(body.total, 3);
  assert.ok(body.rows.every(r => r.annotation === null));
});

test('?listened=false includes shows with no annotation at all', async () => {
  await reset();
  const { body } = await get('/api/series/testshow/shows?listened=false');
  assert.equal(body.total, 3, 'an unannotated show is unlistened, not unknown');
});

test('?listened=false excludes shows marked listened', async () => {
  await reset();
  await patch('/api/shows/1610000001/annotation', { listened: true });
  const { body } = await get('/api/series/testshow/shows?listened=false');
  assert.equal(body.total, 2, 'total reflects the filter, not the whole series');
  assert.ok(!body.rows.some(r => r.content_id === 1610000001));
});

test('?listened=true returns only listened shows', async () => {
  await reset();
  await patch('/api/shows/1610000001/annotation', { listened: true });
  const { body } = await get('/api/series/testshow/shows?listened=true');
  assert.deepEqual(body.rows.map(r => r.content_id), [1610000001]);
  assert.equal(body.total, 1);
});

test('a show annotated but not listened still counts as unlistened', async () => {
  await reset();
  await patch('/api/shows/1610000001/annotation', { rating: 3 });
  const { body } = await get('/api/series/testshow/shows?listened=false');
  assert.equal(body.total, 3, 'rating a show does not mark it listened');
});

test('?want=true returns only the queue', async () => {
  await reset();
  await patch('/api/shows/1610000002/annotation', { want_to_listen: true });
  const { body } = await get('/api/series/testshow/shows?want=true');
  assert.deepEqual(body.rows.map(r => r.content_id), [1610000002]);
});

test('?tag= filters on an exact tag', async () => {
  await reset();
  await patch('/api/shows/1610000003/annotation', { tags: ['suvi', 'intervjuu'] });
  await patch('/api/shows/1610000002/annotation', { tags: ['talv'] });
  const { body } = await get('/api/series/testshow/shows?tag=suvi');
  assert.deepEqual(body.rows.map(r => r.content_id), [1610000003]);
});

test('?tag= keeps diacritics distinct', async () => {
  await reset();
  await patch('/api/shows/1610000003/annotation', { tags: ['Mägi'] });
  assert.equal((await get('/api/series/testshow/shows?tag=Magi')).body.total, 0, 'magi must not match Mägi');
  assert.equal((await get('/api/series/testshow/shows?tag=M%C3%A4gi')).body.total, 1);
});

test('?ratingMin= filters on rating', async () => {
  await reset();
  await patch('/api/shows/1610000001/annotation', { rating: 5 });
  await patch('/api/shows/1610000002/annotation', { rating: 2 });
  const { body } = await get('/api/series/testshow/shows?ratingMin=4');
  assert.deepEqual(body.rows.map(r => r.content_id), [1610000001]);
});

test('?ratingMin= excludes unrated shows', async () => {
  await reset();
  await patch('/api/shows/1610000001/annotation', { rating: 5 });
  const { body } = await get('/api/series/testshow/shows?ratingMin=1');
  assert.equal(body.total, 1, 'NULL rating is not >= 1');
});

test('?ratingMin= outside 1..5 is a 400', async () => {
  assert.equal((await get('/api/series/testshow/shows?ratingMin=9')).status, 400);
  assert.equal((await get('/api/series/testshow/shows?ratingMin=abc')).status, 400);
});

test('filters combine', async () => {
  await reset();
  await patch('/api/shows/1610000001/annotation', { listened: true, rating: 5 });
  await patch('/api/shows/1610000002/annotation', { listened: true, rating: 2 });
  const { body } = await get('/api/series/testshow/shows?listened=true&ratingMin=4');
  assert.equal(body.total, 1);
  assert.deepEqual(body.rows.map(r => r.content_id), [1610000001]);
});

test('paging applies after filtering, not before', async () => {
  await reset();
  await patch('/api/shows/1610000001/annotation', { listened: true });
  const { body } = await get('/api/series/testshow/shows?listened=false&page=1&pageSize=1');
  assert.equal(body.total, 2);
  assert.equal(body.rows.length, 1, 'a filtered page is a full page, not a short one');
});
