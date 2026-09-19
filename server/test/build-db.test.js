import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../src/build-db.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-')), 'test.sqlite');
}

test('createDatabase applies the schema', () => {
  const db = createDatabase(tmpFile());
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
  ).all().map(r => r.name);
  assert.deepEqual(tables, ['artists', 'series', 'shows', 'tracks']);
  db.close();
});

test('createDatabase does not create an imports table', () => {
  const db = createDatabase(tmpFile());
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'imports'`
  ).get();
  assert.equal(row, undefined);
  db.close();
});

test('createDatabase enforces foreign keys', () => {
  const db = createDatabase(tmpFile());
  assert.throws(
    () => db.prepare(
      `INSERT INTO shows (content_id, series_id, title, track_count)
       VALUES (1, 999, 'orphan', 0)`
    ).run(),
    /FOREIGN KEY constraint failed/
  );
  db.close();
});

test('createDatabase starts from empty each time', () => {
  const file = tmpFile();
  const first = createDatabase(file);
  first.prepare(`INSERT INTO series (slug, name) VALUES ('x', 'X')`).run();
  first.close();

  const second = createDatabase(file);
  assert.equal(second.prepare(`SELECT COUNT(*) AS n FROM series`).get().n, 0);
  second.close();
});
