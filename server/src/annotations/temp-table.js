/**
 * Annotations live in a TEMP TABLE on the archive's read-only connection.
 *
 * SQLite keeps the temp database in a separate file from the main one, so
 * SQLITE_OPEN_READONLY does not forbid writing to it. (ATTACH ':memory:' *is*
 * forbidden — it fails with "attempt to write a readonly database".) The point
 * is that routes can LEFT JOIN annotations and keep WHERE, ORDER BY and
 * LIMIT/OFFSET in SQL. Merging annotations onto rows in JavaScript would
 * paginate the unfiltered set and hand back short pages.
 *
 * This table is per-connection and per-process. It is rebuilt at boot and kept
 * in step with the durable store on every write.
 */

const DDL = `
CREATE TEMP TABLE IF NOT EXISTS annotations (
  content_id     INTEGER PRIMARY KEY,
  listened       INTEGER NOT NULL DEFAULT 0,
  listened_at    TEXT,
  rating         INTEGER,
  notes          TEXT,
  want_to_listen INTEGER NOT NULL DEFAULT 0,
  tags           TEXT    NOT NULL DEFAULT '[]',
  updated_at     TEXT    NOT NULL
);`;

/**
 * What routes select. `a` is the alias ANNOTATION_JOIN binds.
 *
 * Every column is prefixed `ann_`, which is not cosmetic: `shows` has its own
 * `updated_at`, and `/api/shows/:id` selects `sh.*`. Unprefixed, SQLite hands
 * back one `updated_at` — the annotation's — and the show's own timestamp is
 * silently lost from the payload.
 */
export const ANNOTATION_COLUMNS = `
  a.listened       AS ann_listened,
  a.listened_at    AS ann_listened_at,
  a.rating         AS ann_rating,
  a.notes          AS ann_notes,
  a.want_to_listen AS ann_want_to_listen,
  a.tags           AS ann_tags,
  a.updated_at     AS ann_updated_at`;

/** What routes join. Expects the shows table to be aliased `sh`. */
export const ANNOTATION_JOIN = 'LEFT JOIN annotations a ON a.content_id = sh.content_id';

export function createAnnotationTable(handle) {
  handle.exec(DDL);
}

const params = (contentId, a) => ({
  content_id: Number(contentId),
  listened: a.listened ? 1 : 0,
  listened_at: a.listened_at,
  rating: a.rating,
  notes: a.notes,
  want_to_listen: a.want_to_listen ? 1 : 0,
  tags: JSON.stringify(a.tags ?? []),
  updated_at: a.updated_at,
});

const UPSERT = `
INSERT INTO annotations
  (content_id, listened, listened_at, rating, notes, want_to_listen, tags, updated_at)
VALUES
  (@content_id, @listened, @listened_at, @rating, @notes, @want_to_listen, @tags, @updated_at)
ON CONFLICT (content_id) DO UPDATE SET
  listened = excluded.listened, listened_at = excluded.listened_at,
  rating = excluded.rating, notes = excluded.notes,
  want_to_listen = excluded.want_to_listen, tags = excluded.tags,
  updated_at = excluded.updated_at`;

/** Replace the table wholesale. Used at boot, from store.list(). */
export function loadAnnotations(handle, map) {
  const insert = handle.prepare(UPSERT);
  handle.transaction(entries => {
    handle.prepare('DELETE FROM annotations').run();
    for (const [contentId, a] of entries) insert.run(params(contentId, a));
  })([...map]);
}

export function upsertAnnotationRow(handle, contentId, a) {
  handle.prepare(UPSERT).run(params(contentId, a));
}

export function removeAnnotationRow(handle, contentId) {
  handle.prepare('DELETE FROM annotations WHERE content_id = ?').run(Number(contentId));
}
