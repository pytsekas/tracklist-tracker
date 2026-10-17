import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDatabase } from '../src/build-db.js';
import { openDb } from '../src/db.js';
import {
  createAnnotationTable, loadAnnotations,
  upsertAnnotationRow, removeAnnotationRow,
  ANNOTATION_COLUMNS, ANNOTATION_JOIN,
} from '../src/annotations/temp-table.js';
import { annotationOf } from '../src/annotations/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CSV = path.join(__dirname, 'fixtures/csv');

let handle;

const ann = over => ({
  good: false, good_at: null, notes: null,
  want_to_listen: false, updated_at: '2026-09-22T10:00:00.000Z', ...over,
});

before(() => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-tmp-')), 'test.sqlite');
  buildDatabase({ csvDir: FIXTURE_CSV, outPath: out });
  handle = openDb(out);
  createAnnotationTable(handle);
});

after(() => handle?.close());

test('the archive connection is still read-only', () => {
  assert.throws(
    () => handle.prepare('DELETE FROM shows').run(),
    /readonly/,
    'the temp table must not have made the archive writable');
});

test('loadAnnotations replaces the whole table', () => {
  loadAnnotations(handle, new Map([[1610000001, ann({ good: true })]]));
  assert.equal(handle.prepare('SELECT COUNT(*) n FROM annotations').get().n, 1);

  loadAnnotations(handle, new Map([[1610000002, ann({ notes: 'teine' })]]));
  const rows = handle.prepare('SELECT content_id FROM annotations').all();
  assert.deepEqual(rows.map(r => r.content_id), [1610000002], 'the earlier row is gone');
});

test('booleans round-trip as 0/1', () => {
  loadAnnotations(handle, new Map([[1610000001, ann({ good: true, want_to_listen: false })]]));
  const row = handle.prepare('SELECT good, want_to_listen FROM annotations').get();
  assert.equal(row.good, 1);
  assert.equal(row.want_to_listen, 0);
});

test('upsertAnnotationRow inserts then updates one row', () => {
  loadAnnotations(handle, new Map());
  upsertAnnotationRow(handle, 1610000001, ann({ notes: 'esimene' }));
  assert.equal(handle.prepare('SELECT notes FROM annotations WHERE content_id = 1610000001').get().notes, 'esimene');

  upsertAnnotationRow(handle, 1610000001, ann({ good: true, notes: 'hea' }));
  const row = handle.prepare('SELECT good, notes FROM annotations WHERE content_id = 1610000001').get();
  assert.equal(row.good, 1);
  assert.equal(row.notes, 'hea');
  assert.equal(handle.prepare('SELECT COUNT(*) n FROM annotations').get().n, 1);
});

test('removeAnnotationRow deletes one row', () => {
  loadAnnotations(handle, new Map([[1610000001, ann({ good: true })]]));
  removeAnnotationRow(handle, 1610000001);
  assert.equal(handle.prepare('SELECT COUNT(*) n FROM annotations').get().n, 0);
});

test('the join exposes annotation columns and nulls for unannotated shows', () => {
  loadAnnotations(handle, new Map([[1610000001, ann({ good: true, notes: 'hea' })]]));
  const rows = handle.prepare(`
    SELECT sh.content_id, ${ANNOTATION_COLUMNS}
    FROM shows sh ${ANNOTATION_JOIN}
    ORDER BY sh.content_id`).all();

  const annotated = rows.find(r => r.content_id === 1610000001);
  assert.equal(annotated.ann_good, 1);
  assert.equal(annotated.ann_notes, 'hea');

  const untouched = rows.find(r => r.content_id !== 1610000001);
  assert.equal(untouched.ann_good, null, 'unannotated shows join to NULL');
});

test('the selected columns carry no rating or tags', () => {
  assert.doesNotMatch(ANNOTATION_COLUMNS, /ann_rating|ann_tags/);
});

test('a loaded row round-trips through annotationOf without rating or tags', () => {
  loadAnnotations(handle, new Map([[1610000001, ann({ good: true, notes: 'hea' })]]));
  const row = handle.prepare(`
    SELECT sh.content_id, ${ANNOTATION_COLUMNS}
    FROM shows sh ${ANNOTATION_JOIN}
    WHERE sh.content_id = 1610000001`).get();
  const a = annotationOf(row);
  assert.deepEqual(Object.keys(a).sort(),
    ['good', 'good_at', 'notes', 'updated_at', 'want_to_listen']);
  assert.equal(a.good, true);
  assert.equal(a.notes, 'hea');
});

test('the join does not clobber the show\'s own updated_at', () => {
  loadAnnotations(handle, new Map([[1610000001, ann({ good: true })]]));
  const row = handle.prepare(`
    SELECT sh.*, ${ANNOTATION_COLUMNS}
    FROM shows sh ${ANNOTATION_JOIN}
    WHERE sh.content_id = 1610000001`).get();

  // shows has its own updated_at. Unprefixed annotation columns would
  // overwrite it here and the show's timestamp would vanish from the API.
  assert.notEqual(row.updated_at, '2026-09-22T10:00:00.000Z');
  assert.equal(row.ann_updated_at, '2026-09-22T10:00:00.000Z');
});

test('good filtering works in SQL', () => {
  loadAnnotations(handle, new Map([[1610000001, ann({ good: true })]]));
  const n = handle.prepare(`
    SELECT COUNT(*) n FROM shows sh ${ANNOTATION_JOIN}
    WHERE COALESCE(a.good, 0) = 1`).get().n;
  assert.equal(n, 1, 'unannotated shows join to NULL and COALESCE to 0');
});
