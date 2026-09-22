import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStore } from '../src/annotations/firestore.js';

// The suite must stay hermetic: no network, no cloud project, no emulator in
// CI. This runs only when someone has deliberately pointed it at a project.
const PROJECT = process.env.FIRESTORE_TEST_PROJECT;
const skip = PROJECT ? false : 'set FIRESTORE_TEST_PROJECT to run';

const OWNER = `test-${process.pid}@example.com`;
const SHOW = 1610000001;

test('the Firestore driver satisfies the store contract', { skip }, async () => {
  const store = createFirestoreStore({ projectId: PROJECT });
  try {
    assert.equal(await store.get(OWNER, SHOW), null);

    const first = await store.merge(OWNER, SHOW, { listened: true, rating: 5 });
    assert.equal(first.listened, true);
    assert.equal(first.rating, 5);

    const second = await store.merge(OWNER, SHOW, { notes: 'hea' });
    assert.equal(second.rating, 5, 'a notes-only patch preserves the rating');
    assert.equal(second.notes, 'hea');

    const all = await store.list(OWNER);
    assert.equal(all.size, 1);
    assert.equal(all.get(SHOW).notes, 'hea', 'list keys are numeric content_ids');

    await store.remove(OWNER, SHOW);
    assert.equal(await store.get(OWNER, SHOW), null);
  } finally {
    await store.remove(OWNER, SHOW).catch(() => {});
    store.close();
  }
});

// The tests below exercise the same catch block a real network failure
// would hit, via an injected client instead of a genuinely unreachable
// host — the driver's error handling doesn't care which one threw.

test('a failing client surfaces as ANNOTATION_STORE_UNAVAILABLE', async () => {
  // list() calls collection().doc().collection().get(); make the very
  // first link in that chain throw.
  const listFails = { collection() { throw new Error('offline'); } };
  await assert.rejects(
    () => createFirestoreStore({ projectId: 'p', client: listFails }).list(OWNER),
    err => err.code === 'ANNOTATION_STORE_UNAVAILABLE',
    'list()');

  // merge() builds the same kind of doc ref as list(), then hands its
  // work to runTransaction() instead of a plain get() — a different call
  // on the client itself, so this exercises the transaction path.
  const mergeFails = {
    collection: () => ({
      doc: () => ({ collection: () => ({ doc: () => ({}) }) }),
    }),
    runTransaction() { throw new Error('offline'); },
  };
  await assert.rejects(
    () => createFirestoreStore({ projectId: 'p', client: mergeFails }).merge(OWNER, SHOW, { listened: true }),
    err => err.code === 'ANNOTATION_STORE_UNAVAILABLE',
    'merge()');
});

test('a hung call times out as ANNOTATION_STORE_UNAVAILABLE', async () => {
  // get() never resolves; only the driver's own deadline can end this.
  const client = {
    collection: () => ({
      doc: () => ({
        collection: () => ({ get: () => new Promise(() => {}) }),
      }),
    }),
  };
  const store = createFirestoreStore({ projectId: 'p', client, timeoutMs: 50 });
  await assert.rejects(
    () => store.list(OWNER),
    err => err.code === 'ANNOTATION_STORE_UNAVAILABLE');
});
