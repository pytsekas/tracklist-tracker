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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CSV = path.join(__dirname, 'fixtures/csv');

let handle;

const ann = over => ({
  listened: false, listened_at: null, rating: null, notes: null,
  want_to_listen: false, tags: [], updated_at: '2026-09-22T10:00:00.000Z', ...over,
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
  loadAnnotations(handle, new Map([[1610000001, ann({ listened: true, rating: 5 })]]));
  assert.equal(handle.prepare('SELECT COUNT(*) n FROM annotations').get().n, 1);

  loadAnnotations(handle, new Map([[1610000002, ann({ rating: 2 })]]));
  const rows = handle.prepare('SELECT content_id FROM annotations').all();
  assert.deepEqual(rows.map(r => r.content_id), [1610000002], 'the earlier row is gone');
});

test('booleans round-trip as 0/1', () => {
  loadAnnotations(handle, new Map([[1610000001, ann({ listened: true, want_to_listen: false })]]));
  const row = handle.prepare('SELECT listened, want_to_listen FROM annotations').get();
  assert.equal(row.listened, 1);
  assert.equal(row.want_to_listen, 0);
});

test('upsertAnnotationRow inserts then updates one row', () => {
  loadAnnotations(handle, new Map());
  upsertAnnotationRow(handle, 1610000001, ann({ rating: 3 }));
  assert.equal(handle.prepare('SELECT rating FROM annotations WHERE content_id = 1610000001').get().rating, 3);

  upsertAnnotationRow(handle, 1610000001, ann({ rating: 5, notes: 'hea' }));
  const row = handle.prepare('SELECT rating, notes FROM annotations WHERE content_id = 1610000001').get();
  assert.equal(row.rating, 5);
  assert.equal(row.notes, 'hea');
  assert.equal(handle.prepare('SELECT COUNT(*) n FROM annotations').get().n, 1);
});

test('removeAnnotationRow deletes one row', () => {
  loadAnnotations(handle, new Map([[1610000001, ann({ listened: true })]]));
  removeAnnotationRow(handle, 1610000001);
  assert.equal(handle.prepare('SELECT COUNT(*) n FROM annotations').get().n, 0);
});

test('the join exposes annotation columns and nulls for unannotated shows', () => {
  loadAnnotations(handle, new Map([[1610000001, ann({ listened: true, rating: 4, tags: ['suvi'] })]]));
  const rows = handle.prepare(`
    SELECT sh.content_id, ${ANNOTATION_COLUMNS}
    FROM shows sh ${ANNOTATION_JOIN}
    ORDER BY sh.content_id`).all();

  const annotated = rows.find(r => r.content_id === 1610000001);
  assert.equal(annotated.ann_listened, 1);
  assert.equal(annotated.ann_rating, 4);
  assert.equal(annotated.ann_tags, '["suvi"]');

  const untouched = rows.find(r => r.content_id !== 1610000001);
  assert.equal(untouched.ann_listened, null, 'unannotated shows join to NULL');
});

test('the join does not clobber the show\'s own updated_at', () => {
  loadAnnotations(handle, new Map([[1610000001, ann({ listened: true })]]));
  const row = handle.prepare(`
    SELECT sh.*, ${ANNOTATION_COLUMNS}
    FROM shows sh ${ANNOTATION_JOIN}
    WHERE sh.content_id = 1610000001`).get();

  // shows has its own updated_at. Unprefixed annotation columns would
  // overwrite it here and the show's timestamp would vanish from the API.
  assert.notEqual(row.updated_at, '2026-09-22T10:00:00.000Z');
  assert.equal(row.ann_updated_at, '2026-09-22T10:00:00.000Z');
});

test('unlistened filtering works in SQL', () => {
  loadAnnotations(handle, new Map([[1610000001, ann({ listened: true })]]));
  const n = handle.prepare(`
    SELECT COUNT(*) n FROM shows sh ${ANNOTATION_JOIN}
    WHERE COALESCE(a.listened, 0) = 0`).get().n;
  const total = handle.prepare('SELECT COUNT(*) n FROM shows').get().n;
  assert.equal(n, total - 1);
});

test('tag filtering works via json_each', () => {
  loadAnnotations(handle, new Map([
    [1610000001, ann({ tags: ['suvi', 'intervjuu'] })],
    [1610000002, ann({ tags: ['talv'] })],
  ]));
  const rows = handle.prepare(`
    SELECT sh.content_id FROM shows sh ${ANNOTATION_JOIN}, json_each(a.tags) j
    WHERE j.value = ?`).all('suvi');
  assert.deepEqual(rows.map(r => r.content_id), [1610000001]);
});
