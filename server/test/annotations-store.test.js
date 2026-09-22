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
  const r = validatePatch({
    listened: true, rating: 4, notes: 'hea saade',
    want_to_listen: false, tags: ['suvi', 'intervjuu'],
  });
  assert.equal(r.ok, true);
  assert.equal(r.patch.rating, 4);
  assert.deepEqual(r.patch.tags, ['suvi', 'intervjuu']);
});

test('validatePatch keeps absent keys absent', () => {
  const r = validatePatch({ listened: true });
  assert.deepEqual(Object.keys(r.patch), ['listened']);
});

test('validatePatch rejects an empty body', () => {
  assert.equal(validatePatch({}).ok, false);
});

test('validatePatch rejects a rating outside 1..5', () => {
  for (const rating of [0, 6, -1, 2.5, '4']) {
    assert.equal(validatePatch({ rating }).ok, false, `rating ${rating}`);
  }
});

test('validatePatch accepts a null rating as "clear it"', () => {
  const r = validatePatch({ rating: null });
  assert.equal(r.ok, true);
  assert.equal(r.patch.rating, null);
});

test('validatePatch rejects notes over 4000 characters', () => {
  assert.equal(validatePatch({ notes: 'x'.repeat(4001) }).ok, false);
  assert.equal(validatePatch({ notes: 'x'.repeat(4000) }).ok, true);
});

test('validatePatch trims, dedupes and drops empty tags', () => {
  const r = validatePatch({ tags: ['  suvi ', 'suvi', '', '   ', 'talv'] });
  assert.deepEqual(r.patch.tags, ['suvi', 'talv']);
});

test('validatePatch preserves Estonian diacritics in tags', () => {
  const r = validatePatch({ tags: ['Mägi', 'õhtu'] });
  assert.deepEqual(r.patch.tags, ['Mägi', 'õhtu']);
});

test('validatePatch rejects too many or too long tags', () => {
  assert.equal(validatePatch({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }).ok, false);
  assert.equal(validatePatch({ tags: ['x'.repeat(41)] }).ok, false);
  assert.equal(validatePatch({ tags: 'suvi' }).ok, false);
});

test('validatePatch rejects unknown keys', () => {
  assert.equal(validatePatch({ listened: true, colour: 'red' }).ok, false);
});

/* --------------------------------- merge ---------------------------------- */

test('applyPatch changes only the keys present', () => {
  const current = { ...EMPTY, rating: 5, notes: 'keep me' };
  const next = applyPatch(current, { listened: true });
  assert.equal(next.listened, true);
  assert.equal(next.rating, 5, 'rating survives a listened-only patch');
  assert.equal(next.notes, 'keep me');
});

test('applyPatch treats explicit null as a clear', () => {
  const next = applyPatch({ ...EMPTY, rating: 5 }, { rating: null });
  assert.equal(next.rating, null);
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

test('applyPatch always moves updated_at', () => {
  const next = applyPatch({ ...EMPTY, updated_at: '2020-01-01T00:00:00.000Z' }, { rating: 3 });
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

  const first = await store.merge(OWNER, 1610000001, { listened: true, rating: 5 });
  assert.equal(first.listened, true);
  assert.equal(first.rating, 5);

  const second = await store.merge(OWNER, 1610000001, { notes: 'hea' });
  assert.equal(second.notes, 'hea');
  assert.equal(second.rating, 5, 'earlier rating survives');
  assert.equal(second.listened, true);

  store.close();
});

test('list returns a Map keyed by numeric content_id', async () => {
  const store = createSqliteStore(tmpFile());
  await store.merge(OWNER, 1610000001, { listened: true });
  await store.merge(OWNER, 1610000002, { tags: ['suvi'] });

  const all = await store.list(OWNER);
  assert.equal(all.size, 2);
  assert.equal(all.get(1610000001).listened, true);
  assert.deepEqual(all.get(1610000002).tags, ['suvi']);

  store.close();
});

test('owners are isolated from each other', async () => {
  const store = createSqliteStore(tmpFile());
  await store.merge('a@example.com', 1610000001, { rating: 5 });
  await store.merge('b@example.com', 1610000001, { rating: 1 });

  assert.equal((await store.get('a@example.com', 1610000001)).rating, 5);
  assert.equal((await store.get('b@example.com', 1610000001)).rating, 1);

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
  await first.merge(OWNER, 1610000001, { rating: 3, tags: ['suvi'] });
  first.close();

  const second = createSqliteStore(file);
  const row = await second.get(OWNER, 1610000001);
  assert.equal(row.rating, 3);
  assert.deepEqual(row.tags, ['suvi']);
  second.close();
});
