import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqliteFavourites } from '../src/favourites/sqlite.js';
import { newEntry } from '../src/favourites/store.js';

const tmpFile = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-fav-sqlite-')), 'annotations.sqlite');

const OWNER = 'marko@example.com';
const show = { content_id: 1610000001, title: 'Testsaade. Esimene', show_date: '2024-02-01',
               series_name: 'Testshow', series_slug: 'testshow' };
const song = () => newEntry({ kind: 'song', artist: 'Mägi', title: 'Õhtu jõuab', show },
  new Date('2026-10-16T10:00:00.000Z'));
const artist = () => newEntry({ kind: 'artist', artist: 'Ansambel 50%', title: null, show: null },
  new Date('2026-10-16T11:00:00.000Z'));

test('add creates once and then reports the existing entry', async () => {
  const store = createSqliteFavourites(tmpFile());
  const first = await store.add(OWNER, song());
  assert.equal(first.created, true);
  assert.deepEqual(first.entry, song());

  await store.merge(OWNER, song().id, { notes: 'leia' });
  const second = await store.add(OWNER, song());
  assert.equal(second.created, false);
  assert.equal(second.entry.notes, 'leia', 'the existing entry is returned, not overwritten');
  store.close();
});

test('get returns the entry or null', async () => {
  const store = createSqliteFavourites(tmpFile());
  assert.equal(await store.get(OWNER, song().id), null);
  await store.add(OWNER, song());
  const got = await store.get(OWNER, song().id);
  assert.deepEqual(got.show, show, 'the snapshot round-trips through JSON');
  assert.equal(got.done, false);
  assert.equal(got.meta, null);
  store.close();
});

test('merge applies a patch and returns null for an absent id', async () => {
  const store = createSqliteFavourites(tmpFile());
  await store.add(OWNER, song());
  const done = await store.merge(OWNER, song().id, { done: true });
  assert.equal(done.done, true);
  assert.ok(done.done_at);
  const again = await store.get(OWNER, song().id);
  assert.equal(again.done, true, 'the write is durable');
  assert.equal(await store.merge(OWNER, '0'.repeat(24), { done: true }), null);
  store.close();
});

test('list keys by id and keeps owners apart', async () => {
  const store = createSqliteFavourites(tmpFile());
  await store.add(OWNER, song());
  await store.add(OWNER, artist());
  await store.add('other@example.com', song());
  const all = await store.list(OWNER);
  assert.equal(all.size, 2);
  assert.equal(all.get(artist().id).artist, 'Ansambel 50%');
  assert.equal((await store.list('other@example.com')).size, 1);
  store.close();
});

test('remove is idempotent', async () => {
  const store = createSqliteFavourites(tmpFile());
  await store.add(OWNER, song());
  await store.remove(OWNER, song().id);
  await store.remove(OWNER, song().id);
  assert.equal(await store.get(OWNER, song().id), null);
  store.close();
});

test('a broken handle surfaces as ANNOTATION_STORE_UNAVAILABLE', async () => {
  const store = createSqliteFavourites(tmpFile());
  store.close();
  for (const call of [
    () => store.list(OWNER),
    () => store.get(OWNER, song().id),
    () => store.add(OWNER, song()),
    () => store.merge(OWNER, song().id, { done: true }),
    () => store.remove(OWNER, song().id),
  ]) {
    await assert.rejects(call, err => err.code === 'ANNOTATION_STORE_UNAVAILABLE');
  }
});

test('the file is created with its directory', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-fav-dir-')), 'deep', 'a.sqlite');
  const store = createSqliteFavourites(file);
  assert.ok(fs.existsSync(file));
  store.close();
});
