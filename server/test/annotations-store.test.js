import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { validatePatch, applyPatch, EMPTY } from '../src/annotations/store.js';
import { createSqliteStore } from '../src/annotations/sqlite.js';

const tmpFile = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-ann-')), 'annotations.sqlite');

const OWNER = 'marko@example.com';

/* ------------------------------- validation ------------------------------- */

test('validatePatch accepts a full body', () => {
  const r = validatePatch({ good: true, notes: 'hea saade', want_to_listen: false });
  assert.equal(r.ok, true);
  assert.deepEqual(r.patch, { good: true, notes: 'hea saade', want_to_listen: false });
});

test('validatePatch keeps absent keys absent', () => {
  const r = validatePatch({ good: true });
  assert.deepEqual(Object.keys(r.patch), ['good']);
});

test('validatePatch rejects an empty body', () => {
  assert.equal(validatePatch({}).ok, false);
});

test('validatePatch rejects notes over 4000 characters', () => {
  assert.equal(validatePatch({ notes: 'x'.repeat(4001) }).ok, false);
  assert.equal(validatePatch({ notes: 'x'.repeat(4000) }).ok, true);
});

test('validatePatch rejects unknown keys', () => {
  assert.equal(validatePatch({ good: true, colour: 'red' }).ok, false);
});

test('validatePatch rejects rating and tags as unknown fields', () => {
  const rating = validatePatch({ rating: 3 });
  assert.equal(rating.ok, false);
  assert.match(rating.error, /unknown field: rating/);

  const tags = validatePatch({ tags: ['x'] });
  assert.equal(tags.ok, false);
  assert.match(tags.error, /unknown field: tags/);
});

test('validatePatch rejects listened as an unknown field', () => {
  const r = validatePatch({ listened: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown field: listened/);
});

test('EMPTY has no rating or tags', () => {
  assert.deepEqual(Object.keys(EMPTY).sort(),
    ['good', 'good_at', 'notes', 'updated_at', 'want_to_listen']);
});

/* --------------------------------- merge ---------------------------------- */

test('applyPatch changes only the keys present', () => {
  const current = { ...EMPTY, want_to_listen: true, notes: 'keep me' };
  const next = applyPatch(current, { good: true });
  assert.equal(next.good, true);
  assert.equal(next.want_to_listen, true, 'the queue flag survives a good-only patch');
  assert.equal(next.notes, 'keep me');
});

test('applyPatch treats explicit null as a clear', () => {
  const next = applyPatch({ ...EMPTY, notes: 'hea' }, { notes: null });
  assert.equal(next.notes, null);
});

test('applyPatch stamps good_at when good becomes true', () => {
  const next = applyPatch(EMPTY, { good: true });
  assert.match(next.good_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('applyPatch clears good_at when good becomes false', () => {
  const on = applyPatch(EMPTY, { good: true });
  const off = applyPatch(on, { good: false });
  assert.equal(off.good_at, null);
});

test('applyPatch produces exactly the five annotation fields', () => {
  const next = applyPatch(EMPTY, { notes: 'hea' });
  assert.deepEqual(Object.keys(next).sort(),
    ['good', 'good_at', 'notes', 'updated_at', 'want_to_listen']);
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

  const first = await store.merge(OWNER, 1610000001, { good: true, want_to_listen: true });
  assert.equal(first.good, true);
  assert.equal(first.want_to_listen, true);

  const second = await store.merge(OWNER, 1610000001, { notes: 'hea' });
  assert.equal(second.notes, 'hea');
  assert.equal(second.want_to_listen, true, 'the earlier queue flag survives');
  assert.equal(second.good, true);

  store.close();
});

test('list returns a Map keyed by numeric content_id', async () => {
  const store = createSqliteStore(tmpFile());
  await store.merge(OWNER, 1610000001, { good: true });
  await store.merge(OWNER, 1610000002, { notes: 'suvi' });

  const all = await store.list(OWNER);
  assert.equal(all.size, 2);
  assert.equal(all.get(1610000001).good, true);
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
  await store.merge(OWNER, 1610000001, { good: true });
  await store.remove(OWNER, 1610000001);
  assert.equal(await store.get(OWNER, 1610000001), null);
  store.close();
});

test('remove on a missing row is not an error', async () => {
  const store = createSqliteStore(tmpFile());
  await store.remove(OWNER, 1610000009);
  store.close();
});

test('a dev file from before the good flag gains the two columns on open', async () => {
  // The dropped `listened` columns stay; the missing `good` ones are added.
  const file = tmpFile();
  const old = new Database(file);
  old.exec(`
    CREATE TABLE annotations (
      owner          TEXT    NOT NULL,
      content_id     INTEGER NOT NULL,
      listened       INTEGER NOT NULL DEFAULT 0,
      listened_at    TEXT,
      notes          TEXT,
      want_to_listen INTEGER NOT NULL DEFAULT 0,
      updated_at     TEXT    NOT NULL,
      PRIMARY KEY (owner, content_id)
    )`);
  old.prepare(`
    INSERT INTO annotations (owner, content_id, listened, notes, updated_at)
    VALUES (?, ?, 1, 'vana', '2026-10-01T00:00:00.000Z')`).run(OWNER, 1610000001);
  old.close();

  const store = createSqliteStore(file);
  const before = await store.get(OWNER, 1610000001);
  assert.equal(before.good, false, 'an old row reads as not good');
  assert.equal(before.notes, 'vana', 'the old row survives the migration');

  const next = await store.merge(OWNER, 1610000001, { good: true });
  assert.equal(next.good, true);
  assert.match(next.good_at, /^\d{4}-\d{2}-\d{2}T/);
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
