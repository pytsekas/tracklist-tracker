import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { EMPTY, applyPatch, unavailable } from './store.js';

// A dev file created before 2026-10-16 still has the dropped `rating` and
// `tags` columns, and one from before 2026-10-17 the dropped `listened` and
// `listened_at`. CREATE TABLE IF NOT EXISTS leaves them in place, the insert
// below names its columns and never touches them, and their old defaults
// tolerate that, so dropped columns need no migration: delete the gitignored
// file if the leftovers bother you. Added columns are another matter — see
// the ALTER TABLE guard in createSqliteStore.
const DDL = `
CREATE TABLE IF NOT EXISTS annotations (
  owner          TEXT    NOT NULL,
  content_id     INTEGER NOT NULL,
  good           INTEGER NOT NULL DEFAULT 0,
  good_at        TEXT,
  notes          TEXT,
  want_to_listen INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT    NOT NULL,
  PRIMARY KEY (owner, content_id)
);`;

/** DB row -> Annotation. Booleans are 0/1 at rest. */
const toAnnotation = row => ({
  good: !!row.good,
  good_at: row.good_at,
  notes: row.notes,
  want_to_listen: !!row.want_to_listen,
  updated_at: row.updated_at,
});

/**
 * The dev and test driver: a plain writable SQLite file, entirely separate from
 * the read-only archive. Scratch state — `data/annotations.sqlite` is gitignored.
 */
export function createSqliteStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const handle = new Database(file);
  handle.pragma('journal_mode = WAL');
  handle.exec(DDL);
  // CREATE TABLE IF NOT EXISTS adds nothing to a table that already exists,
  // so a dev file from before the `good` flag would make the upsert below
  // fail with "no such column". Add the missing columns once; SQLite has no
  // ADD COLUMN IF NOT EXISTS, hence the pragma check. Each column is checked
  // on its own, so a migration that was interrupted between the two ALTERs
  // heals on the next open instead of failing every write for good.
  const columns = handle.pragma('table_info(annotations)').map(c => c.name);
  if (!columns.includes('good')) {
    handle.exec('ALTER TABLE annotations ADD COLUMN good INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.includes('good_at')) {
    handle.exec('ALTER TABLE annotations ADD COLUMN good_at TEXT');
  }

  const selectOne = handle.prepare(
    'SELECT * FROM annotations WHERE owner = ? AND content_id = ?');
  const selectAll = handle.prepare(
    'SELECT * FROM annotations WHERE owner = ? ORDER BY content_id');
  const upsert = handle.prepare(`
    INSERT INTO annotations
      (owner, content_id, good, good_at, notes, want_to_listen, updated_at)
    VALUES
      (@owner, @content_id, @good, @good_at, @notes, @want_to_listen, @updated_at)
    ON CONFLICT (owner, content_id) DO UPDATE SET
      good = excluded.good, good_at = excluded.good_at,
      notes = excluded.notes, want_to_listen = excluded.want_to_listen,
      updated_at = excluded.updated_at`);
  const del = handle.prepare(
    'DELETE FROM annotations WHERE owner = ? AND content_id = ?');

  // Every method wraps its failure in unavailable(), so a broken store reaches
  // the client as a 502 rather than an opaque 500 — the same contract the
  // Firestore driver honours.
  return {
    async list(owner) {
      try {
        return new Map(
          selectAll.all(owner).map(r => [Number(r.content_id), toAnnotation(r)]));
      } catch (err) { throw unavailable(err); }
    },

    async get(owner, contentId) {
      try {
        const row = selectOne.get(owner, Number(contentId));
        return row ? toAnnotation(row) : null;
      } catch (err) { throw unavailable(err); }
    },

    async merge(owner, contentId, patch) {
      try {
        const id = Number(contentId);
        const current = selectOne.get(owner, id);
        const next = applyPatch(current ? toAnnotation(current) : { ...EMPTY }, patch);
        upsert.run({
          owner,
          content_id: id,
          good: next.good ? 1 : 0,
          good_at: next.good_at,
          notes: next.notes,
          want_to_listen: next.want_to_listen ? 1 : 0,
          updated_at: next.updated_at,
        });
        return next;
      } catch (err) { throw unavailable(err); }
    },

    async remove(owner, contentId) {
      try {
        del.run(owner, Number(contentId));
      } catch (err) { throw unavailable(err); }
    },

    close() { handle.close(); },
  };
}
