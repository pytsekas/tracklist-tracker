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
import { createSqliteFavourites } from '../src/favourites/sqlite.js';
import { setFavouritesStore, loadFavourites } from '../src/favourites/index.js';
import { entryId } from '../src/favourites/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CSV = path.join(__dirname, 'fixtures/csv');
const DEV_USER = 'dev@localhost';

let server, base, store, favourites, handle;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-favroutes-'));
  const out = path.join(dir, 'test.sqlite');
  buildDatabase({ csvDir: FIXTURE_CSV, outPath: out });
  handle = openDb(out);
  createAnnotationTable(handle);

  store = createSqliteStore(path.join(dir, 'annotations.sqlite'));
  setStore(store);
  favourites = createSqliteFavourites(path.join(dir, 'annotations.sqlite'));
  setFavouritesStore(favourites);
  loadFavourites(new Map());

  const app = express();
  app.use(express.json());
  app.use('/api', requireUser({ devEmail: DEV_USER }), routes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.code === 'ANNOTATION_STORE_UNAVAILABLE' ? 502 : 500;
    res.status(status).json({ error: err.message });
  });
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); store?.close(); favourites?.close(); handle?.close(); });

const send = async (method, p, body) => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const post = b => send('POST', '/api/favourites', b);
const trackId = title => handle.prepare('SELECT id FROM tracks WHERE title = ?').get(title).id;
const artistId = name => handle.prepare('SELECT id FROM artists WHERE name = ?').get(name).id;
const showId = cid => handle.prepare('SELECT id FROM shows WHERE content_id = ?').get(cid).id;

/* ---------------------------------- POST ---------------------------------- */

test('POST creates a show entry with live archive ids, then answers 200 for a repeat', async () => {
  const first = await post({ kind: 'show', content_id: 1610000001 });
  assert.equal(first.status, 201);
  assert.equal(first.body.id, entryId('show', ['1610000001']));
  assert.equal(first.body.title, 'Testsaade. Esimene');
  assert.equal(first.body.show_id, showId(1610000001));
  assert.equal(first.body.show_url, 'https://r2.err.ee/1610000001/testsaade');
  assert.equal(first.body.artist_id, null);

  const again = await post({ kind: 'show', content_id: 1610000001 });
  assert.equal(again.status, 200);
  assert.equal(again.body.id, first.body.id);
});

test('POST creates a song entry from a track id', async () => {
  const r = await post({ kind: 'song', track_id: trackId('Õhtu jõuab') });
  assert.equal(r.status, 201);
  assert.equal(r.body.artist, 'Mägi');
  assert.equal(r.body.artist_id, artistId('Mägi'));
  assert.equal(r.body.show.content_id, 1610000001);
  assert.equal(r.body.show_id, showId(1610000001));
});

test('POST creates an artist entry and an album entry', async () => {
  const a = await post({ kind: 'artist', artist_id: artistId('Ansambel 50%') });
  assert.equal(a.status, 201);
  assert.equal(a.body.artist_id, artistId('Ansambel 50%'));
  assert.equal(a.body.show_id, null);

  const b = await post({ kind: 'album', artist: 'Mägi', title: 'Esimene plaat' });
  assert.equal(b.status, 201);
  assert.equal(b.body.kind, 'album');
  assert.equal(b.body.artist_id, artistId('Mägi'), 'a typed artist resolves when the archive knows it');
});

test('POST folds album case and whitespace into one entry', async () => {
  const first = await post({ kind: 'album', artist: 'The Beatles', title: 'Abbey Road' });
  assert.equal(first.status, 201);
  const second = await post({ kind: 'album', artist: '  the  beatles ', title: 'ABBEY ROAD' });
  assert.equal(second.status, 200);
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.body.artist, 'The Beatles', 'the first spelling is kept');
});

test('POST answers 404 for an archive id that does not exist', async () => {
  assert.equal((await post({ kind: 'show', content_id: 1 })).status, 404);
  assert.equal((await post({ kind: 'song', track_id: 999 })).status, 404);
  assert.equal((await post({ kind: 'artist', artist_id: 999 })).status, 404);
});

test('POST answers 400 for a bad body', async () => {
  for (const body of [
    { kind: 'series', content_id: 1 },
    { kind: 'show', content_id: '1610000001' },
    { kind: 'album', artist: '', title: 'x' },
    { kind: 'show', content_id: 1610000001, notes: 'x' },
    [],
  ]) {
    const { status, body: b } = await post(body);
    assert.equal(status, 400, JSON.stringify(body));
    assert.ok(b.error);
  }
});

/* ----------------------------------- GET ---------------------------------- */

test('GET lists newest first, with done and kind filters', async () => {
  const all = await send('GET', '/api/favourites');
  assert.equal(all.status, 200);
  assert.ok(Array.isArray(all.body));
  assert.ok(all.body.length >= 5);
  const dates = all.body.map(e => e.added_at);
  assert.deepEqual(dates, [...dates].sort().reverse());

  const songs = await send('GET', '/api/favourites?kind=song');
  assert.ok(songs.body.every(e => e.kind === 'song'));
  assert.equal(songs.body.length, 1);

  const open = await send('GET', '/api/favourites?done=false');
  assert.equal(open.body.length, all.body.length, 'nothing is done yet');
  const done = await send('GET', '/api/favourites?done=true');
  assert.deepEqual(done.body, []);
});

test('GET ignores an empty kind and rejects an unknown one', async () => {
  const empty = await send('GET', '/api/favourites?kind=');
  assert.equal(empty.status, 200);
  const bad = await send('GET', '/api/favourites?kind=series');
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /kind must be one of/);
});

/* ---------------------------------- PATCH --------------------------------- */

test('PATCH saves notes and done, and done_at follows done', async () => {
  const id = entryId('show', ['1610000001']);
  const notes = await send('PATCH', `/api/favourites/${id}`, { notes: 'leia üles' });
  assert.equal(notes.status, 200);
  assert.equal(notes.body.notes, 'leia üles');
  assert.equal(notes.body.show_id, showId(1610000001), 'live ids come back on a patch too');

  const done = await send('PATCH', `/api/favourites/${id}`, { done: true });
  assert.equal(done.body.done, true);
  assert.ok(done.body.done_at);
  assert.equal(done.body.notes, 'leia üles', 'a done patch keeps the notes');

  const listed = await send('GET', '/api/favourites?done=true');
  assert.deepEqual(listed.body.map(e => e.id), [id]);

  const undone = await send('PATCH', `/api/favourites/${id}`, { done: false });
  assert.equal(undone.body.done_at, null);
});

test('PATCH answers 400 for a bad id or body and 404 for an unknown id', async () => {
  assert.equal((await send('PATCH', '/api/favourites/nope', { done: true })).status, 400);
  const id = entryId('show', ['1610000001']);
  assert.equal((await send('PATCH', `/api/favourites/${id}`, { title: 'x' })).status, 400);
  assert.equal((await send('PATCH', `/api/favourites/${id}`, {})).status, 400);
  assert.equal((await send('PATCH', `/api/favourites/${'0'.repeat(24)}`, { done: true })).status, 404);
});

/* --------------------------------- DELETE --------------------------------- */

test('DELETE removes the entry, is idempotent, and a later PATCH answers 404', async () => {
  const id = entryId('album', ['mägi', 'esimene plaat']);
  assert.equal((await send('DELETE', `/api/favourites/${id}`)).status, 204);
  assert.equal((await send('DELETE', `/api/favourites/${id}`)).status, 204);
  const list = await send('GET', '/api/favourites');
  assert.ok(!list.body.some(e => e.id === id));
  assert.equal((await send('PATCH', `/api/favourites/${id}`, { done: true })).status, 404);
  assert.equal((await send('DELETE', '/api/favourites/nope')).status, 400);
});

/* ------------------------- membership on archive routes ------------------------- */

test('favourite_id marks a show on the series listing and the show page', async () => {
  const id = entryId('show', ['1610000001']);
  const listing = await send('GET', '/api/series/testshow/shows');
  const row = listing.body.rows.find(r => r.content_id === 1610000001);
  assert.equal(row.favourite_id, id);
  const other = listing.body.rows.find(r => r.content_id === 1610000003);
  assert.equal(other.favourite_id, null);

  const page = await send('GET', `/api/shows/${showId(1610000001)}`);
  assert.equal(page.body.show.favourite_id, id);
  assert.equal(page.body.show.title, 'Testsaade. Esimene', 'the show fields are untouched');
});

test('favourite_id marks a song on the show page and the tracks search', async () => {
  const id = entryId('song', ['mägi', 'õhtu jõuab']);
  const page = await send('GET', `/api/shows/${showId(1610000001)}`);
  const byTitle = Object.fromEntries(page.body.tracks.map(t => [t.title, t.favourite_id]));
  assert.equal(byTitle['Õhtu jõuab'], id);
  assert.equal(byTitle['Teine lugu'], null);

  const search = await send('GET', '/api/tracks?q=jõuab');
  assert.equal(search.body.rows[0].favourite_id, id);
});

test('favourite_id marks a song whose track has no artist', async () => {
  const r = await post({ kind: 'song', track_id: trackId('Nimeta lugu') });
  assert.equal(r.status, 201);
  const page = await send('GET', `/api/shows/${showId(1610000001)}`);
  const t = page.body.tracks.find(t => t.title === 'Nimeta lugu');
  assert.equal(t.favourite_id, r.body.id);
});

test('favourite_id marks an artist on the list and the artist page', async () => {
  const id = entryId('artist', ['ansambel 50%']);
  const list = await send('GET', '/api/artists');
  const byName = Object.fromEntries(list.body.rows.map(a => [a.name, a.favourite_id]));
  assert.equal(byName['Ansambel 50%'], id);
  assert.equal(byName['Mägi'], null);

  const page = await send('GET', `/api/artists/${artistId('Ansambel 50%')}`);
  assert.equal(page.body.artist.favourite_id, id);
});

test('favourite_id goes back to null after a delete', async () => {
  const id = entryId('artist', ['ansambel 50%']);
  assert.equal((await send('DELETE', `/api/favourites/${id}`)).status, 204);
  const page = await send('GET', `/api/artists/${artistId('Ansambel 50%')}`);
  assert.equal(page.body.artist.favourite_id, null);
});
