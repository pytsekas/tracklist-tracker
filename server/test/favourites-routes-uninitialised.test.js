// Its own file for the same reason annotations-routes-uninitialised.test.js
// is: node --test isolates files in their own process, and this is the only
// way to see getFavouritesStore() in its never-set state.
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
import { createAnnotationTable } from '../src/annotations/temp-table.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CSV = path.join(__dirname, 'fixtures/csv');

let server, base, handle;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-favroutes-uninit-'));
  const out = path.join(dir, 'test.sqlite');
  buildDatabase({ csvDir: FIXTURE_CSV, outPath: out });
  handle = openDb(out);
  createAnnotationTable(handle);
  // setFavouritesStore() is deliberately never called.

  const app = express();
  app.use(express.json());
  app.use('/api', requireUser({ devEmail: 'dev@localhost' }), routes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.code === 'ANNOTATION_STORE_UNAVAILABLE' ? 502 : 500;
    res.status(status).json({ error: err.message });
  });
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); handle?.close(); });

const send = async (method, p, body) => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('GET with the store never initialised answers an empty list', async () => {
  const { status, body } = await send('GET', '/api/favourites');
  assert.equal(status, 200);
  assert.deepEqual(body, []);
});

test('POST with the store never initialised is 502, not 500', async () => {
  const { status, body } = await send('POST', '/api/favourites', { kind: 'show', content_id: 1610000001 });
  assert.equal(status, 502);
  assert.match(body.error, /favourites store not initialised/);
});

test('archive reads still work and carry a null favourite_id', async () => {
  const { status, body } = await send('GET', '/api/series/testshow/shows');
  assert.equal(status, 200);
  assert.equal(body.rows[0].favourite_id, null);
});
