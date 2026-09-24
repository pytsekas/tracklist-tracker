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

// A call that wins the race well inside its deadline must not log the
// "deadline had already fired" warning — it did not fire. This is the case
// the fix wave's own first pass got wrong: it warned on every successful
// call, not just late ones, because the log line hung off the promise
// resolving at all rather than off the timer having actually gone first.
test('a call that resolves in time logs nothing', async (t) => {
  const warn = t.mock.method(console, 'warn');
  const client = {
    collection: () => ({
      doc: () => ({
        collection: () => ({ get: async () => ({ docs: [] }) }),
      }),
    }),
  };
  await createFirestoreStore({ projectId: 'p', client, timeoutMs: 5000 }).list(OWNER);
  assert.equal(warn.mock.callCount(), 0);
});

test('a call that times out but later succeeds logs the deadline warning exactly once', async (t) => {
  const warn = t.mock.method(console, 'warn');
  let resolveLate;
  const late = new Promise(resolve => { resolveLate = resolve; });
  const client = {
    collection: () => ({
      doc: () => ({
        collection: () => ({ get: () => late }),
      }),
    }),
  };
  const store = createFirestoreStore({ projectId: 'p', client, timeoutMs: 20 });
  await assert.rejects(
    () => store.list(OWNER),
    err => err.code === 'ANNOTATION_STORE_UNAVAILABLE');

  // The abandoned call goes on to succeed after the deadline already fired —
  // exactly the case the warning exists to surface.
  resolveLate({ docs: [] });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(warn.mock.callCount(), 1);
  assert.match(
    warn.mock.calls[0].arguments[0],
    /Firestore list completed after its 20ms deadline had already fired/);
});
