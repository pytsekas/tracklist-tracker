import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KINDS, MAX_NAME, entryId, isEntryId, validateAdd, validatePatch, applyPatch, newEntry,
} from '../src/favourites/store.js';

/* -------------------------------- identity -------------------------------- */

test('entryId is deterministic, 24 lowercase hex characters', () => {
  const a = entryId('song', ['mägi', 'õhtu jõuab']);
  assert.equal(a, entryId('song', ['mägi', 'õhtu jõuab']));
  assert.match(a, /^[0-9a-f]{24}$/);
});

test('entryId separates kinds for the same parts', () => {
  assert.notEqual(entryId('song', ['x', 'y']), entryId('album', ['x', 'y']));
});

test('entryId is safe for a slash in a name', () => {
  assert.match(entryId('artist', ['ac/dc']), /^[0-9a-f]{24}$/);
});

test('isEntryId accepts only 24 lowercase hex characters', () => {
  assert.equal(isEntryId('0123456789abcdef01234567'), true);
  assert.equal(isEntryId('0123456789ABCDEF01234567'), false);
  assert.equal(isEntryId('0123456789abcdef0123456'), false);
  assert.equal(isEntryId(42), false);
});

/* ------------------------------- validateAdd ------------------------------ */

test('validateAdd accepts each kind', () => {
  assert.deepEqual(validateAdd({ kind: 'show', content_id: 1610000001 }),
    { ok: true, add: { kind: 'show', content_id: 1610000001 } });
  assert.deepEqual(validateAdd({ kind: 'song', track_id: 3 }),
    { ok: true, add: { kind: 'song', track_id: 3 } });
  assert.deepEqual(validateAdd({ kind: 'artist', artist_id: 2 }),
    { ok: true, add: { kind: 'artist', artist_id: 2 } });
  assert.deepEqual(validateAdd({ kind: 'album', artist: ' Mägi ', title: ' Esimene ' }),
    { ok: true, add: { kind: 'album', artist: 'Mägi', title: 'Esimene' } });
});

test('validateAdd rejects a missing or unknown kind', () => {
  assert.equal(validateAdd({ content_id: 1 }).ok, false);
  assert.equal(validateAdd({ kind: 'series', content_id: 1 }).ok, false);
  assert.equal(validateAdd(null).ok, false);
  assert.equal(validateAdd([]).ok, false);
});

test('validateAdd rejects a non-integer id, including a numeric string', () => {
  assert.equal(validateAdd({ kind: 'show', content_id: '1610000001' }).ok, false);
  assert.equal(validateAdd({ kind: 'song', track_id: 1.5 }).ok, false);
  assert.equal(validateAdd({ kind: 'artist' }).ok, false);
});

test('validateAdd rejects blank or over-long album fields', () => {
  assert.equal(validateAdd({ kind: 'album', artist: '  ', title: 'x' }).ok, false);
  assert.equal(validateAdd({ kind: 'album', artist: 'x', title: 'y'.repeat(MAX_NAME + 1) }).ok, false);
  assert.equal(validateAdd({ kind: 'album', artist: 'x', title: 'y'.repeat(MAX_NAME) }).ok, true);
  assert.equal(validateAdd({ kind: 'album', artist: 'x' }).ok, false);
});

test('validateAdd rejects unknown keys', () => {
  const r = validateAdd({ kind: 'show', content_id: 1, title: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown field: title/);
});

/* ------------------------------ validatePatch ----------------------------- */

test('validatePatch accepts notes and done', () => {
  assert.deepEqual(validatePatch({ notes: 'leia üles', done: true }),
    { ok: true, patch: { notes: 'leia üles', done: true } });
});

test('validatePatch stores blank notes as null', () => {
  assert.deepEqual(validatePatch({ notes: '   ' }).patch, { notes: null });
  assert.deepEqual(validatePatch({ notes: null }).patch, { notes: null });
});

test('validatePatch rejects notes over 4000 characters', () => {
  assert.equal(validatePatch({ notes: 'x'.repeat(4001) }).ok, false);
  assert.equal(validatePatch({ notes: 'x'.repeat(4000) }).ok, true);
});

test('validatePatch rejects a non-boolean done, unknown keys and an empty patch', () => {
  assert.equal(validatePatch({ done: 'yes' }).ok, false);
  assert.equal(validatePatch({ title: 'x' }).ok, false);
  assert.equal(validatePatch({}).ok, false);
  assert.equal(validatePatch(null).ok, false);
});

/* ------------------------------- applyPatch ------------------------------- */

const base = () => newEntry(
  { kind: 'artist', artist: 'Mägi', title: null, show: null },
  new Date('2026-10-16T10:00:00.000Z'));

test('applyPatch sets done_at when done flips to true and clears it on false', () => {
  const t1 = new Date('2026-10-16T11:00:00.000Z');
  const done = applyPatch(base(), { done: true }, t1);
  assert.equal(done.done, true);
  assert.equal(done.done_at, t1.toISOString());
  assert.equal(done.updated_at, t1.toISOString());

  const undone = applyPatch(done, { done: false }, new Date('2026-10-16T12:00:00.000Z'));
  assert.equal(undone.done, false);
  assert.equal(undone.done_at, null);
});

test('applyPatch keeps the first done_at when done is set true again', () => {
  const t1 = new Date('2026-10-16T11:00:00.000Z');
  const done = applyPatch(base(), { done: true }, t1);
  const again = applyPatch(done, { done: true }, new Date('2026-10-16T12:00:00.000Z'));
  assert.equal(again.done_at, t1.toISOString());
});

test('applyPatch moves only the keys in the patch', () => {
  const e = applyPatch(base(), { notes: 'x' });
  assert.equal(e.notes, 'x');
  assert.equal(e.done, false);
  assert.equal(e.artist, 'Mägi');
  assert.equal(e.added_at, '2026-10-16T10:00:00.000Z');
});

/* -------------------------------- newEntry -------------------------------- */

test('newEntry builds the full shape with normalised parts', () => {
  const now = new Date('2026-10-16T10:00:00.000Z');
  const show = { content_id: 1610000001, title: 'Testsaade. Esimene', show_date: '2024-02-01',
                 series_name: 'Testshow', series_slug: 'testshow' };
  const e = newEntry({ kind: 'song', artist: 'MÄGI', title: 'Õhtu  jõuab', show }, now);
  assert.deepEqual(e, {
    id: entryId('song', ['mägi', 'õhtu jõuab']),
    kind: 'song', artist: 'MÄGI', title: 'Õhtu  jõuab',
    artist_norm: 'mägi', title_norm: 'õhtu jõuab', show,
    notes: null, done: false, done_at: null,
    added_at: now.toISOString(), updated_at: now.toISOString(), meta: null,
  });
});

test('newEntry keys a show on its content_id and an artist on its name', () => {
  const show = { content_id: 1610000002, title: 'T', show_date: '2024-03-15',
                 series_name: 'S', series_slug: 's' };
  assert.equal(newEntry({ kind: 'show', artist: null, title: 'T', show }).id,
    entryId('show', ['1610000002']));
  const a = newEntry({ kind: 'artist', artist: 'Ansambel 50%', title: null, show: null });
  assert.equal(a.id, entryId('artist', ['ansambel 50%']));
  assert.equal(a.title, null);
  assert.equal(a.title_norm, '');
});

test('newEntry treats a missing artist as the empty norm', () => {
  const e = newEntry({ kind: 'song', artist: null, title: 'Nimeta lugu', show: null });
  assert.equal(e.artist, null);
  assert.equal(e.artist_norm, '');
  assert.equal(e.id, entryId('song', ['', 'nimeta lugu']));
});

test('KINDS lists the four kinds', () => {
  assert.deepEqual([...KINDS], ['show', 'song', 'artist', 'album']);
});
