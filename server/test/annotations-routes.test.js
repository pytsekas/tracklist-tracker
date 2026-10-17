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
  const { status, body } = await patch(`/api/shows/${SHOW}/annotation`, { good: true });
  assert.equal(status, 200);
  assert.equal(body.good, true);
  assert.match(body.good_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('a second PATCH changes only the keys it names', async () => {
  await patch(`/api/shows/${SHOW}/annotation`, { want_to_listen: true });
  const { body } = await patch(`/api/shows/${SHOW}/annotation`, { notes: 'hea saade' });
  assert.equal(body.notes, 'hea saade');
  assert.equal(body.want_to_listen, true, 'the queue flag survives a notes-only patch');
  assert.equal(body.good, true, 'good survives too');
});

test('the write is visible to the read routes immediately', async () => {
  await patch(`/api/shows/${SHOW}/annotation`, { notes: 'suvi' });
  const res = await fetch(`${base}/api/series/testshow/shows`);
  const list = await res.json();
  const row = list.rows.find(r => r.content_id === SHOW);
  assert.equal(row.annotation.notes, 'suvi', 'temp table updated in step with the store');
});

test('PATCH with an explicit null clears a field', async () => {
  await patch(`/api/shows/${SHOW}/annotation`, { notes: 'hea' });
  const { body } = await patch(`/api/shows/${SHOW}/annotation`, { notes: null });
  assert.equal(body.notes, null);
});

test('PATCH rejects rating as an unknown field with 400', async () => {
  const { status, body } = await patch(`/api/shows/${SHOW}/annotation`, { rating: 4 });
  assert.equal(status, 400);
  assert.match(body.error, /unknown field: rating/);
});

test('PATCH rejects listened as an unknown field with 400', async () => {
  const { status, body } = await patch(`/api/shows/${SHOW}/annotation`, { listened: true });
  assert.equal(status, 400);
  assert.match(body.error, /unknown field: listened/);
});

test('GET /api/tags is gone', async () => {
  const { status, body } = await send('GET', '/api/tags');
  assert.equal(status, 404);
  assert.deepEqual(body, { error: 'not found' });
});

test('?ratingMin= is no longer recognised and does not 400', async () => {
  const res = await fetch(`${base}/api/series/testshow/shows?ratingMin=abc`);
  assert.equal(res.status, 200);
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

test('PATCH on a content_id not in the archive is 404', async () => {
  const { status } = await patch('/api/shows/9999999999/annotation', { good: true });
  assert.equal(status, 404);
});

test('PATCH on a non-numeric content_id is 400', async () => {
  const { status } = await patch('/api/shows/abc/annotation', { good: true });
  assert.equal(status, 400);
});

test('DELETE removes the annotation from store and temp table', async () => {
  await patch(`/api/shows/${SHOW}/annotation`, { good: true });
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
