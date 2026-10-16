import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePatch, applyPatch, EMPTY } from '../src/annotations/store.js';
import { createSqliteStore } from '../src/annotations/sqlite.js';

const tmpFile = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-ann-')), 'annotations.sqlite');

const OWNER = 'marko@example.com';

/* ------------------------------- validation ------------------------------- */

test('validatePatch accepts a full body', () => {
  const r = validatePatch({ listened: true, notes: 'hea saade', want_to_listen: false });
  assert.equal(r.ok, true);
  assert.deepEqual(r.patch, { listened: true, notes: 'hea saade', want_to_listen: false });
});

test('validatePatch keeps absent keys absent', () => {
  const r = validatePatch({ listened: true });
  assert.deepEqual(Object.keys(r.patch), ['listened']);
});

test('validatePatch rejects an empty body', () => {
  assert.equal(validatePatch({}).ok, false);
});

test('validatePatch rejects notes over 4000 characters', () => {
  assert.equal(validatePatch({ notes: 'x'.repeat(4001) }).ok, false);
  assert.equal(validatePatch({ notes: 'x'.repeat(4000) }).ok, true);
});

test('validatePatch rejects unknown keys', () => {
  assert.equal(validatePatch({ listened: true, colour: 'red' }).ok, false);
});

test('validatePatch rejects rating and tags as unknown fields', () => {
  const rating = validatePatch({ rating: 3 });
  assert.equal(rating.ok, false);
  assert.match(rating.error, /unknown field: rating/);

  const tags = validatePatch({ tags: ['x'] });
  assert.equal(tags.ok, false);
  assert.match(tags.error, /unknown field: tags/);
});

test('EMPTY has no rating or tags', () => {
  assert.deepEqual(Object.keys(EMPTY).sort(),
    ['listened', 'listened_at', 'notes', 'updated_at', 'want_to_listen']);
});

/* --------------------------------- merge ---------------------------------- */

test('applyPatch changes only the keys present', () => {
  const current = { ...EMPTY, want_to_listen: true, notes: 'keep me' };
  const next = applyPatch(current, { listened: true });
  assert.equal(next.listened, true);
  assert.equal(next.want_to_listen, true, 'the queue flag survives a listened-only patch');
  assert.equal(next.notes, 'keep me');
});

test('applyPatch treats explicit null as a clear', () => {
  const next = applyPatch({ ...EMPTY, notes: 'hea' }, { notes: null });
  assert.equal(next.notes, null);
});

test('applyPatch stamps listened_at when listened becomes true', () => {
  const next = applyPatch(EMPTY, { listened: true });
  assert.match(next.listened_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('applyPatch clears listened_at when listened becomes false', () => {
  const on = applyPatch(EMPTY, { listened: true });
  const off = applyPatch(on, { listened: false });
  assert.equal(off.listened_at, null);
});

test('applyPatch produces exactly the five annotation fields', () => {
  const next = applyPatch(EMPTY, { notes: 'hea' });
  assert.deepEqual(Object.keys(next).sort(),
    ['listened', 'listened_at', 'notes', 'updated_at', 'want_to_listen']);
});

test('applyPatch always moves updated_at', () => {
  const next = applyPatch({ ...EMPTY, updated_at: '2020-01-01T00:00:00.000Z' }, { notes: 'x' });
  assert.notEqual(next.updated_at, '2020-01-01T00:00:00.000Z');
});

/* -------------------------------- the store -------------------------------- */

test('a fresh store lists nothing', async () => {
  const store = createSqliteStore(tmpFile());
  assert.equal((await store.list(OWNER)).size, 0);
  store.close();
});

test('merge upserts, then patches field by field', async () => {
  const store = createSqliteStore(tmpFile());

  const first = await store.merge(OWNER, 1610000001, { listened: true, want_to_listen: true });
  assert.equal(first.listened, true);
  assert.equal(first.want_to_listen, true);

  const second = await store.merge(OWNER, 1610000001, { notes: 'hea' });
  assert.equal(second.notes, 'hea');
  assert.equal(second.want_to_listen, true, 'the earlier queue flag survives');
  assert.equal(second.listened, true);

  store.close();
});

test('list returns a Map keyed by numeric content_id', async () => {
  const store = createSqliteStore(tmpFile());
  await store.merge(OWNER, 1610000001, { listened: true });
  await store.merge(OWNER, 1610000002, { notes: 'suvi' });

  const all = await store.list(OWNER);
  assert.equal(all.size, 2);
  assert.equal(all.get(1610000001).listened, true);
  assert.equal(all.get(1610000002).notes, 'suvi');

  store.close();
});

test('owners are isolated from each other', async () => {
  const store = createSqliteStore(tmpFile());
  await store.merge('a@example.com', 1610000001, { notes: 'a' });
  await store.merge('b@example.com', 1610000001, { notes: 'b' });

  assert.equal((await store.get('a@example.com', 1610000001)).notes, 'a');
  assert.equal((await store.get('b@example.com', 1610000001)).notes, 'b');

  store.close();
});

test('get returns null for an unannotated show', async () => {
  const store = createSqliteStore(tmpFile());
  assert.equal(await store.get(OWNER, 1610000009), null);
  store.close();
});

test('remove deletes the row', async () => {
  const store = createSqliteStore(tmpFile());
  await store.merge(OWNER, 1610000001, { listened: true });
  await store.remove(OWNER, 1610000001);
  assert.equal(await store.get(OWNER, 1610000001), null);
  store.close();
});

test('remove on a missing row is not an error', async () => {
  const store = createSqliteStore(tmpFile());
  await store.remove(OWNER, 1610000009);
  store.close();
});

test('the store survives being reopened', async () => {
  const file = tmpFile();
  const first = createSqliteStore(file);
  await first.merge(OWNER, 1610000001, { notes: 'hea', want_to_listen: true });
  first.close();

  const second = createSqliteStore(file);
  const row = await second.get(OWNER, 1610000001);
  assert.equal(row.notes, 'hea');
  assert.equal(row.want_to_listen, true);
  second.close();
});
