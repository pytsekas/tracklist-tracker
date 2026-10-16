import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { unavailable } from '../annotations/store.js';
import { applyPatch } from './store.js';

const DDL = `
CREATE TABLE IF NOT EXISTS favourites (
  owner       TEXT    NOT NULL,
  id          TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  artist      TEXT,
  title       TEXT,
  artist_norm TEXT    NOT NULL DEFAULT '',
  title_norm  TEXT    NOT NULL DEFAULT '',
  show        TEXT,
  notes       TEXT,
  done        INTEGER NOT NULL DEFAULT 0,
  done_at     TEXT,
  added_at    TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  meta        TEXT,
  PRIMARY KEY (owner, id)
);`;

/** DB row -> entry. Booleans are 0/1 and the two objects are JSON text at rest. */
const toEntry = row => ({
  id: row.id,
  kind: row.kind,
  artist: row.artist,
  title: row.title,
  artist_norm: row.artist_norm,
  title_norm: row.title_norm,
  show: row.show === null ? null : JSON.parse(row.show),
  notes: row.notes,
  done: !!row.done,
  done_at: row.done_at,
  added_at: row.added_at,
  updated_at: row.updated_at,
  meta: row.meta === null ? null : JSON.parse(row.meta),
});

const toRow = (owner, e) => ({
  owner,
  id: e.id,
  kind: e.kind,
  artist: e.artist,
  title: e.title,
  artist_norm: e.artist_norm,
  title_norm: e.title_norm,
  show: e.show === null ? null : JSON.stringify(e.show),
  notes: e.notes,
  done: e.done ? 1 : 0,
  done_at: e.done_at,
  added_at: e.added_at,
  updated_at: e.updated_at,
  meta: e.meta === null ? null : JSON.stringify(e.meta),
});

/**
 * The dev and test driver. Same file as the annotation store
 * (data/annotations.sqlite, gitignored), its own table and its own
 * connection: two better-sqlite3 handles on one WAL file in one process are
 * fine, and it keeps this module independent of the annotation driver.
 */
export function createSqliteFavourites(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const handle = new Database(file);
  handle.pragma('journal_mode = WAL');
  handle.exec(DDL);

  const selectOne = handle.prepare('SELECT * FROM favourites WHERE owner = ? AND id = ?');
  const selectAll = handle.prepare(
    'SELECT * FROM favourites WHERE owner = ? ORDER BY added_at DESC, id');
  // DO NOTHING, not an upsert: add() is create-only so that a cache that lags
  // the store can never make a repeat add overwrite notes or the done state.
  const insert = handle.prepare(`
    INSERT INTO favourites
      (owner, id, kind, artist, title, artist_norm, title_norm, show,
       notes, done, done_at, added_at, updated_at, meta)
    VALUES
      (@owner, @id, @kind, @artist, @title, @artist_norm, @title_norm, @show,
       @notes, @done, @done_at, @added_at, @updated_at, @meta)
    ON CONFLICT (owner, id) DO NOTHING`);
  const update = handle.prepare(`
    UPDATE favourites
    SET notes = @notes, done = @done, done_at = @done_at, updated_at = @updated_at
    WHERE owner = @owner AND id = @id`);
  const del = handle.prepare('DELETE FROM favourites WHERE owner = ? AND id = ?');

  // Every method wraps its failure in unavailable(), so a broken store reaches
  // the client as a 502 rather than an opaque 500, as the annotation drivers do.
  return {
    async list(owner) {
      try {
        return new Map(selectAll.all(owner).map(r => [r.id, toEntry(r)]));
      } catch (err) { throw unavailable(err); }
    },

    async get(owner, id) {
      try {
        const row = selectOne.get(owner, id);
        return row ? toEntry(row) : null;
      } catch (err) { throw unavailable(err); }
    },

    async add(owner, entry) {
      try {
        const { changes } = insert.run(toRow(owner, entry));
        return { created: changes === 1, entry: toEntry(selectOne.get(owner, entry.id)) };
      } catch (err) { throw unavailable(err); }
    },

    async merge(owner, id, patch) {
      try {
        const row = selectOne.get(owner, id);
        if (!row) return null;
        const next = applyPatch(toEntry(row), patch);
        update.run({
          owner, id, notes: next.notes, done: next.done ? 1 : 0,
          done_at: next.done_at, updated_at: next.updated_at,
        });
        return next;
      } catch (err) { throw unavailable(err); }
    },

    async remove(owner, id) {
      try {
        del.run(owner, id);
      } catch (err) { throw unavailable(err); }
    },

    close() { handle.close(); },
  };
}
