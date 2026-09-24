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
const SHOW = 1610000001; // a content_id present in the fixtures

let server, base, store, handle;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-annroutes-'));
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

const send = async (method, p, body) => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const patch = (p, b) => send('PATCH', p, b);

test('GET /api/me reports the signed-in user', async () => {
  const { body } = await send('GET', '/api/me');
  assert.deepEqual(body, { email: DEV_USER });
});

test('PATCH creates an annotation and returns it', async () => {
  const { status, body } = await patch(`/api/shows/${SHOW}/annotation`, { listened: true });
  assert.equal(status, 200);
  assert.equal(body.listened, true);
  assert.match(body.listened_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('a second PATCH changes only the keys it names', async () => {
  await patch(`/api/shows/${SHOW}/annotation`, { rating: 5 });
  const { body } = await patch(`/api/shows/${SHOW}/annotation`, { notes: 'hea saade' });
  assert.equal(body.notes, 'hea saade');
  assert.equal(body.rating, 5, 'the rating survives a notes-only patch');
  assert.equal(body.listened, true, 'listened survives too');
});

test('the write is visible to the read routes immediately', async () => {
  await patch(`/api/shows/${SHOW}/annotation`, { tags: ['suvi'] });
  const res = await fetch(`${base}/api/series/testshow/shows`);
  const list = await res.json();
  const row = list.rows.find(r => r.content_id === SHOW);
  assert.deepEqual(row.annotation.tags, ['suvi'], 'temp table updated in step with the store');
});

test('PATCH with an explicit null clears a field', async () => {
  await patch(`/api/shows/${SHOW}/annotation`, { rating: 4 });
  const { body } = await patch(`/api/shows/${SHOW}/annotation`, { rating: null });
  assert.equal(body.rating, null);
});

test('PATCH rejects a bad rating with 400', async () => {
  const { status, body } = await patch(`/api/shows/${SHOW}/annotation`, { rating: 9 });
  assert.equal(status, 400);
  assert.match(body.error, /rating/);
});

test('PATCH rejects an unknown field with 400', async () => {
  const { status } = await patch(`/api/shows/${SHOW}/annotation`, { colour: 'red' });
  assert.equal(status, 400);
});

test('PATCH rejects an empty body with 400', async () => {
  const { status } = await patch(`/api/shows/${SHOW}/annotation`, {});
  assert.equal(status, 400);
});

test('PATCH rejects over-long notes with 400', async () => {
  const { status } = await patch(`/api/shows/${SHOW}/annotation`, { notes: 'x'.repeat(4001) });
  assert.equal(status, 400);
});

test('PATCH rejects too many tags with 400', async () => {
  const tags = Array.from({ length: 21 }, (_, i) => `t${i}`);
  const { status } = await patch(`/api/shows/${SHOW}/annotation`, { tags });
  assert.equal(status, 400);
});

test('PATCH on a content_id not in the archive is 404', async () => {
  const { status } = await patch('/api/shows/9999999999/annotation', { listened: true });
  assert.equal(status, 404);
});

test('PATCH on a non-numeric content_id is 400', async () => {
  const { status } = await patch('/api/shows/abc/annotation', { listened: true });
  assert.equal(status, 400);
});

test('GET /api/tags counts distinct tags', async () => {
  await patch(`/api/shows/${SHOW}/annotation`, { tags: ['suvi', 'intervjuu'] });
  await patch('/api/shows/1610000002/annotation', { tags: ['suvi'] });
  const { body } = await send('GET', '/api/tags');
  const suvi = body.find(t => t.tag === 'suvi');
  assert.equal(suvi.count, 2);
  assert.ok(body.some(t => t.tag === 'intervjuu'));
});

test('DELETE removes the annotation from store and temp table', async () => {
  await patch(`/api/shows/${SHOW}/annotation`, { listened: true });
  const { status } = await send('DELETE', `/api/shows/${SHOW}/annotation`);
  assert.equal(status, 204);

  assert.equal(await store.get(DEV_USER, SHOW), null);

  const res = await fetch(`${base}/api/series/testshow/shows`);
  const list = await res.json();
  assert.equal(list.rows.find(r => r.content_id === SHOW).annotation, null);
});

test('DELETE of an absent annotation is still 204', async () => {
  const { status } = await send('DELETE', '/api/shows/1610000003/annotation');
  assert.equal(status, 204);
});
