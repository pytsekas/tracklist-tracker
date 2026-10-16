import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreFavourites } from '../src/favourites/firestore.js';
import { newEntry } from '../src/favourites/store.js';

// Hermetic: no network, no cloud project, no emulator in CI. The live
// contract test runs only when someone has deliberately pointed it at a project.
const PROJECT = process.env.FIRESTORE_TEST_PROJECT;
const skip = PROJECT ? false : 'set FIRESTORE_TEST_PROJECT to run';

const OWNER = `test-${process.pid}@example.com`;

test('the Firestore favourites driver satisfies the store contract', { skip }, async () => {
  const store = createFirestoreFavourites({ projectId: PROJECT });
  const id = SONG.id;
  try {
    assert.equal(await store.get(OWNER, id), null);
    const first = await store.add(OWNER, SONG);
    assert.equal(first.created, true);
    const merged = await store.merge(OWNER, id, { notes: 'hea' });
    assert.equal(merged.notes, 'hea');
    const second = await store.add(OWNER, SONG);
    assert.equal(second.created, false);
    assert.equal(second.entry.notes, 'hea');
    const all = await store.list(OWNER);
    assert.equal(all.size, 1);
    assert.equal(all.get(id).notes, 'hea');
    await store.remove(OWNER, id);
    assert.equal(await store.get(OWNER, id), null);
    assert.equal(await store.merge(OWNER, id, { done: true }), null);
  } finally {
    await store.remove(OWNER, id).catch(() => {});
    store.close();
  }
});

// The stub tests exercise the same catch blocks a real network failure would.
// SONG has a fixed timestamp so deepEqual comparisons are stable.

const SONG = newEntry({ kind: 'song', artist: 'Mägi', title: 'Õhtu jõuab', show: null },
  new Date('2026-10-16T10:00:00.000Z'));
/** A stub client whose annotations/{owner}/favourites subcollection is `sub`. */
const clientWith = sub => ({ collection: () => ({ doc: () => ({ collection: () => sub }) }) });
const withoutId = entry => { const { id, ...fields } = entry; return fields; };

test('a failing client surfaces as ANNOTATION_STORE_UNAVAILABLE', async () => {
  const listFails = { collection() { throw new Error('offline'); } };
  await assert.rejects(
    () => createFirestoreFavourites({ projectId: 'p', client: listFails }).list(OWNER),
    err => err.code === 'ANNOTATION_STORE_UNAVAILABLE', 'list()');

  // add() and merge() build a doc ref and then hand the work to
  // runTransaction(); make that call throw.
  const txFails = {
    ...clientWith({ doc: () => ({}) }),
    runTransaction() { throw new Error('offline'); },
  };
  const store = createFirestoreFavourites({ projectId: 'p', client: txFails });
  await assert.rejects(() => store.add(OWNER, SONG),
    err => err.code === 'ANNOTATION_STORE_UNAVAILABLE', 'add()');
  await assert.rejects(() => store.merge(OWNER, SONG.id, { done: true }),
    err => err.code === 'ANNOTATION_STORE_UNAVAILABLE', 'merge()');
});

test('a hung call times out as ANNOTATION_STORE_UNAVAILABLE', async () => {
  // get() never resolves; only the driver's own deadline can end this.
  const client = clientWith({ get: () => new Promise(() => {}) });
  const store = createFirestoreFavourites({ projectId: 'p', client, timeoutMs: 50 });
  await assert.rejects(() => store.list(OWNER),
    err => err.code === 'ANNOTATION_STORE_UNAVAILABLE');
});

test('add reports created false and returns the stored document when it exists', async () => {
  const existing = { ...withoutId(SONG), notes: 'olemas' };
  const client = {
    ...clientWith({ doc: () => ({}) }),
    runTransaction: async fn => fn({
      get: async () => ({ exists: true, id: SONG.id, data: () => existing }),
      set: () => { throw new Error('must not write over an existing entry'); },
    }),
  };
  const store = createFirestoreFavourites({ projectId: 'p', client });
  const r = await store.add(OWNER, SONG);
  assert.equal(r.created, false);
  assert.equal(r.entry.notes, 'olemas');
  assert.equal(r.entry.id, SONG.id);
});

test('add writes the document without an id field when it is new', async () => {
  let written = null;
  const client = {
    ...clientWith({ doc: () => ({}) }),
    runTransaction: async fn => fn({
      get: async () => ({ exists: false }),
      set: (_ref, fields) => { written = fields; },
    }),
  };
  const r = await createFirestoreFavourites({ projectId: 'p', client }).add(OWNER, SONG);
  assert.equal(r.created, true);
  assert.deepEqual(r.entry, SONG);
  assert.deepEqual(written, withoutId(SONG), 'the id lives in the path, not the document');
});

test('list maps document ids back onto entries', async () => {
  const data = withoutId(SONG);
  const client = clientWith({ get: async () => ({ docs: [{ id: SONG.id, data: () => data }] }) });
  const all = await createFirestoreFavourites({ projectId: 'p', client }).list(OWNER);
  assert.deepEqual(all.get(SONG.id), SONG);
});
