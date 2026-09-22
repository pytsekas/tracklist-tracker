// A separate file on purpose: `node --test` isolates each test file in its
// own process (verified: a module-level var set in one file is not visible
// in another run alongside it), so this file is the only way to see
// getStore() in its genuinely-never-set state. Any file that calls
// setStore() — including annotations-routes.test.js — would permanently
// flip that module-level state for the rest of its own process, but cannot
// leak it here.
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
const DEV_USER = 'dev@localhost';
const SHOW = 1610000001; // a content_id present in the fixtures

let server, base, handle;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-annroutes-uninit-'));
  const out = path.join(dir, 'test.sqlite');
  buildDatabase({ csvDir: FIXTURE_CSV, outPath: out });
  handle = openDb(out);
  createAnnotationTable(handle);
  // setStore() is deliberately never called — this reproduces a boot where
  // createStore() failed (Task 4: non-fatal, the archive still serves).

  const app = express();
  app.use(express.json());
  app.use('/api', requireUser({ devEmail: DEV_USER }), routes);
  // Mirrors the error handler in src/index.js exactly: a thrown
  // ANNOTATION_STORE_UNAVAILABLE becomes 502, everything else 500. Inlined
  // rather than imported because index.js has top-level boot side effects
  // (opening the real DB, process.exit on failure, app.listen).
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

test('PATCH with the store never initialised is 502, not 500', async () => {
  const { status, body } = await send('PATCH', `/api/shows/${SHOW}/annotation`, { listened: true });
  assert.equal(status, 502);
  assert.match(body.error, /annotation store unavailable/);
});

test('DELETE with the store never initialised is 502, not 500', async () => {
  const { status, body } = await send('DELETE', `/api/shows/${SHOW}/annotation`);
  assert.equal(status, 502);
  assert.match(body.error, /annotation store unavailable/);
});

test('reads still work with the store never initialised', async () => {
  // /api/shows/:id keys on the internal shows.id, not content_id — use the
  // series listing, the same read route the write test file uses to confirm
  // annotation state, so this test needs no knowledge of that internal id.
  const { status, body } = await send('GET', '/api/series/testshow/shows');
  assert.equal(status, 200);
  const row = body.rows.find(r => r.content_id === SHOW);
  assert.equal(row.annotation, null);
});
