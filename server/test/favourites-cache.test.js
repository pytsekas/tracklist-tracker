import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadFavourites, setFavourite, deleteFavourite, listFavourites, favouriteIdOf,
  createFavouritesStore,
} from '../src/favourites/index.js';
import { newEntry, entryId } from '../src/favourites/store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const at = iso => new Date(iso);
const older = newEntry({ kind: 'artist', artist: 'Mägi', title: null, show: null },
  at('2026-10-16T10:00:00.000Z'));
const newer = newEntry({ kind: 'album', artist: 'Mägi', title: 'Plaat', show: null },
  at('2026-10-16T11:00:00.000Z'));

test('loadFavourites replaces the cache and listFavourites orders newest first', () => {
  loadFavourites(new Map([[older.id, older], [newer.id, newer]]));
  assert.deepEqual(listFavourites().map(e => e.id), [newer.id, older.id]);
  loadFavourites(new Map());
  assert.deepEqual(listFavourites(), []);
});

test('setFavourite and deleteFavourite keep the cache in step', () => {
  loadFavourites(new Map());
  setFavourite(older);
  assert.equal(listFavourites().length, 1);
  setFavourite({ ...older, notes: 'x' });
  assert.equal(listFavourites()[0].notes, 'x', 'set replaces by id');
  deleteFavourite(older.id);
  assert.deepEqual(listFavourites(), []);
});

test('favouriteIdOf answers the id only for cached entries', () => {
  loadFavourites(new Map([[older.id, older]]));
  assert.equal(favouriteIdOf('artist', ['mägi']), entryId('artist', ['mägi']));
  assert.equal(favouriteIdOf('artist', ['keegi teine']), null);
  assert.equal(favouriteIdOf('album', ['mägi']), null, 'the kind is part of the key');
});

test('createFavouritesStore picks SQLite by default and honours ANNOTATIONS_DB', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-fav-idx-')), 'a.sqlite');
  const store = await createFavouritesStore({ ANNOTATIONS_DB: file });
  assert.ok(fs.existsSync(file));
  assert.equal((await store.list('x@example.com')).size, 0);
  store.close();
});

test('createFavouritesStore rejects an unknown driver', async () => {
  await assert.rejects(() => createFavouritesStore({ ANNOTATIONS_DRIVER: 'redis' }), /unknown ANNOTATIONS_DRIVER/);
});
