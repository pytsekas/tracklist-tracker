import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { EMPTY, applyPatch, unavailable } from './store.js';

const DDL = `
CREATE TABLE IF NOT EXISTS annotations (
  owner          TEXT    NOT NULL,
  content_id     INTEGER NOT NULL,
  listened       INTEGER NOT NULL DEFAULT 0,
  listened_at    TEXT,
  rating         INTEGER,
  notes          TEXT,
  want_to_listen INTEGER NOT NULL DEFAULT 0,
  tags           TEXT    NOT NULL DEFAULT '[]',
  updated_at     TEXT    NOT NULL,
  PRIMARY KEY (owner, content_id)
);`;

/** DB row -> Annotation. Booleans are 0/1 and tags are JSON text at rest. */
const toAnnotation = row => ({
  listened: !!row.listened,
  listened_at: row.listened_at,
  rating: row.rating,
  notes: row.notes,
  want_to_listen: !!row.want_to_listen,
  tags: JSON.parse(row.tags),
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

  const selectOne = handle.prepare(
    'SELECT * FROM annotations WHERE owner = ? AND content_id = ?');
  const selectAll = handle.prepare(
    'SELECT * FROM annotations WHERE owner = ? ORDER BY content_id');
  const upsert = handle.prepare(`
    INSERT INTO annotations
      (owner, content_id, listened, listened_at, rating, notes, want_to_listen, tags, updated_at)
    VALUES
      (@owner, @content_id, @listened, @listened_at, @rating, @notes, @want_to_listen, @tags, @updated_at)
    ON CONFLICT (owner, content_id) DO UPDATE SET
      listened = excluded.listened, listened_at = excluded.listened_at,
      rating = excluded.rating, notes = excluded.notes,
      want_to_listen = excluded.want_to_listen, tags = excluded.tags,
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
          listened: next.listened ? 1 : 0,
          listened_at: next.listened_at,
          rating: next.rating,
          notes: next.notes,
          want_to_listen: next.want_to_listen ? 1 : 0,
          tags: JSON.stringify(next.tags),
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
