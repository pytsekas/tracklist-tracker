import express from 'express';
import { db } from './db.js';
import { norm, likeEscape } from './normalize.js';
import { getStore, withAnnotation } from './annotations/index.js';
import { validatePatch } from './annotations/store.js';
import { upsertAnnotationRow, removeAnnotationRow, ANNOTATION_JOIN, ANNOTATION_COLUMNS }
  from './annotations/temp-table.js';
import {
  getFavouritesStore, listFavourites, setFavourite, deleteFavourite, favouriteIdOf,
} from './favourites/index.js';
import {
  KINDS, isEntryId, validateAdd, resolveAdd, validatePatch as validateFavouritePatch,
} from './favourites/store.js';

const router = express.Router();

const page = q => Math.max(1, Number(q.page) || 1);
const size = q => Math.min(500, Math.max(1, Number(q.pageSize) || 100));

// SQLite's LIKE only folds ASCII, so we match against the precomputed *_norm
// columns. ESCAPE lets a needle contain a literal % or _.
const LIKE_ESC = "ESCAPE '\\'";
const needle = q => `%${likeEscape(norm(q))}%`;

// Membership in the favourites cache, computed from the row's display fields.
// norm() here gives the same strings the importer put in the *_norm columns,
// so recomputing is equivalent to selecting them and leaves the SQL alone.
const markShow = row => ({ ...row, favourite_id: favouriteIdOf('show', [String(row.content_id)]) });
const markSong = row =>
  ({ ...row, favourite_id: favouriteIdOf('song', [norm(row.artist), norm(row.title)]) });
const markArtist = row => ({ ...row, favourite_id: favouriteIdOf('artist', [norm(row.name)]) });

/* ---------------------------------- stats --------------------------------- */

router.get('/stats', (_req, res, next) => {
  try {
    res.json(db().prepare(`
      SELECT
        (SELECT COUNT(*) FROM series)  AS series,
        (SELECT COUNT(*) FROM shows)   AS shows,
        (SELECT COUNT(*) FROM tracks)  AS tracks,
        (SELECT COUNT(*) FROM artists) AS artists`).get());
  } catch (e) { next(e); }
});

/* --------------------------------- series --------------------------------- */

router.get('/series', (_req, res, next) => {
  try {
    res.json(db().prepare(`
      SELECT s.id, s.slug, s.name,
             COUNT(DISTINCT sh.id) AS show_count,
             COALESCE(SUM(sh.track_count), 0) AS track_count,
             MIN(sh.show_date) AS first_show,
             MAX(sh.show_date) AS last_show
      FROM series s
      LEFT JOIN shows sh ON sh.series_id = s.id
      GROUP BY s.id
      ORDER BY s.name COLLATE NOCASE`).all());
  } catch (e) { next(e); }
});

router.get('/series/:slug/shows', (req, res, next) => {
  try {
    const p = page(req.query), ps = size(req.query);
    const where = ['s.slug = ?'], args = [req.params.slug];

    // COALESCE, because an unannotated show LEFT JOINs to NULL and NULL = 0
    // is NULL, not true — without it "unlistened" would return nothing.
    if (req.query.listened === 'true')  where.push('COALESCE(a.listened, 0) = 1');
    if (req.query.listened === 'false') where.push('COALESCE(a.listened, 0) = 0');
    if (req.query.want === 'true')      where.push('COALESCE(a.want_to_listen, 0) = 1');

    const clause = `WHERE ${where.join(' AND ')}`;
    const from = `
      FROM shows sh
      JOIN series s ON s.id = sh.series_id
      ${ANNOTATION_JOIN}
      ${clause}`;

    const rows = db().prepare(`
      SELECT sh.id, sh.content_id, sh.title, sh.show_date, sh.url, sh.track_count,
             ${ANNOTATION_COLUMNS}
      ${from}
      ORDER BY sh.show_date DESC, sh.id DESC
      LIMIT ? OFFSET ?`).all(...args, ps, (p - 1) * ps);

    const { total } = db().prepare(`SELECT COUNT(*) AS total ${from}`).get(...args);

    res.json({ rows: rows.map(withAnnotation).map(markShow), total, page: p, pageSize: ps });
  } catch (e) { next(e); }
});

/* ---------------------------------- shows --------------------------------- */

router.get('/shows/:id', (req, res, next) => {
  try {
    const show = db().prepare(`
      SELECT sh.*, s.name AS series_name, s.slug AS series_slug,
             ${ANNOTATION_COLUMNS}
      FROM shows sh
      JOIN series s ON s.id = sh.series_id
      ${ANNOTATION_JOIN}
      WHERE sh.id = ?`).get(req.params.id);
    if (!show) return res.status(404).json({ error: 'not found' });
    const tracks = db().prepare(`
      SELECT t.id, t.position, t.title, a.id AS artist_id, a.name AS artist
      FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id
      WHERE t.show_id = ? ORDER BY t.position`).all(req.params.id);
    const { annotation, ...rest } = withAnnotation(show);
    res.json({ show: markShow(rest), tracks: tracks.map(markSong), annotation });
  } catch (e) { next(e); }
});

/* --------------------------------- tracks --------------------------------- */

router.get('/tracks', (req, res, next) => {
  try {
    const p = page(req.query), ps = size(req.query);
    const where = [], args = [];
    if (req.query.q) {
      where.push(`(t.title_norm LIKE ? ${LIKE_ESC} OR a.name_norm LIKE ? ${LIKE_ESC})`);
      args.push(needle(req.query.q), needle(req.query.q));
    }
    if (req.query.series) { where.push('s.slug = ?'); args.push(req.query.series); }
    if (req.query.from) { where.push('sh.show_date >= ?'); args.push(req.query.from); }
    if (req.query.to) { where.push('sh.show_date <= ?'); args.push(req.query.to); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = db().prepare(`
      SELECT t.id, t.title, a.id AS artist_id, a.name AS artist,
             sh.id AS show_id, sh.title AS show_title, sh.show_date, sh.url AS show_url,
             s.name AS series_name, s.slug AS series_slug
      FROM tracks t
      LEFT JOIN artists a ON a.id = t.artist_id
      JOIN shows sh ON sh.id = t.show_id
      JOIN series s ON s.id = sh.series_id
      ${clause}
      ORDER BY sh.show_date DESC, t.position
      LIMIT ? OFFSET ?`).all(...args, ps, (p - 1) * ps);

    const { total } = db().prepare(`
      SELECT COUNT(*) AS total
      FROM tracks t
      LEFT JOIN artists a ON a.id = t.artist_id
      JOIN shows sh ON sh.id = t.show_id
      JOIN series s ON s.id = sh.series_id
      ${clause}`).get(...args);

    res.json({ rows: rows.map(markSong), total, page: p, pageSize: ps });
  } catch (e) { next(e); }
});

/* --------------------------------- artists -------------------------------- */

router.get('/artists', (req, res, next) => {
  try {
    const p = page(req.query), ps = size(req.query);
    const where = [], args = [];
    if (req.query.q) {
      where.push(`a.name_norm LIKE ? ${LIKE_ESC}`);
      args.push(needle(req.query.q));
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = db().prepare(`
      SELECT a.id, a.name, COUNT(t.id) AS plays,
             COUNT(DISTINCT sh.series_id) AS series_count
      FROM artists a
      JOIN tracks t ON t.artist_id = a.id
      JOIN shows sh ON sh.id = t.show_id
      ${clause}
      GROUP BY a.id
      ORDER BY plays DESC, a.name_norm
      LIMIT ? OFFSET ?`).all(...args, ps, (p - 1) * ps);

    const { total } = db().prepare(
      `SELECT COUNT(*) AS total FROM artists a ${clause}`).get(...args);
    res.json({ rows: rows.map(markArtist), total, page: p, pageSize: ps });
  } catch (e) { next(e); }
});

router.get('/artists/:id', (req, res, next) => {
  try {
    const artist = db().prepare(`SELECT * FROM artists WHERE id = ?`).get(req.params.id);
    if (!artist) return res.status(404).json({ error: 'not found' });
    const tracks = db().prepare(`
      SELECT t.id, t.title, sh.id AS show_id, sh.title AS show_title, sh.show_date,
             sh.url AS show_url, s.name AS series_name, s.slug AS series_slug
      FROM tracks t
      JOIN shows sh ON sh.id = t.show_id
      JOIN series s ON s.id = sh.series_id
      WHERE t.artist_id = ?
      ORDER BY sh.show_date DESC`).all(req.params.id);
    res.json({ artist: markArtist(artist), tracks });
  } catch (e) { next(e); }
});

/* ------------------------------ annotations -------------------------------- */

router.get('/me', (req, res) => res.json({ email: req.user.email }));

/** The archive is the authority on which episodes exist. */
function requireShow(req, res) {
  const contentId = Number(req.params.contentId);
  if (!Number.isInteger(contentId)) {
    res.status(400).json({ error: 'content_id must be an integer' });
    return null;
  }
  const row = db().prepare('SELECT content_id FROM shows WHERE content_id = ?').get(contentId);
  if (!row) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  return contentId;
}

router.patch('/shows/:contentId/annotation', async (req, res, next) => {
  try {
    const contentId = requireShow(req, res);
    if (contentId === null) return;

    const check = validatePatch(req.body);
    if (!check.ok) return res.status(400).json({ error: check.error });

    // Durable store first, temp table only once it has accepted the write.
    // The invariant this keeps is one-directional: the temp table never moves
    // ahead of the durable store. The store can briefly be ahead of the temp
    // table — a cache that is behind is safe, a cache that is ahead is a lie —
    // and a boot reconciles it by reloading from the store. Two ways that gap
    // opens, both accepted rather than guarded: a timed-out Firestore call
    // (server/src/annotations/firestore.js) can still commit after this route
    // has already answered 502 and skipped the update below; and if
    // upsertAnnotationRow itself throws after merge() already committed, this
    // process's own temp table falls behind until its next boot. Neither is
    // reconciled mid-process — that would cost a round trip on the failure
    // branch of a case that already self-heals at next boot, and would need
    // its own retry loop for when the re-read also times out.
    const merged = await getStore().merge(req.user.email, contentId, check.patch);
    upsertAnnotationRow(db(), contentId, merged);
    res.json(merged);
  } catch (e) { next(e); }
});

router.delete('/shows/:contentId/annotation', async (req, res, next) => {
  try {
    const contentId = requireShow(req, res);
    if (contentId === null) return;

    // Same order, and the same accepted gap, as the PATCH handler above:
    // store first, temp table only on success — the temp table can fall
    // behind (a timed-out-but-committed delete, or a post-commit temp-table
    // throw here) but never ahead, and a boot reconciles it.
    await getStore().remove(req.user.email, contentId);
    removeAnnotationRow(db(), contentId);
    res.status(204).end();
  } catch (e) { next(e); }
});

/* ------------------------------- favourites -------------------------------- */

/**
 * Entries snapshot their names so they survive a rebuild; the archive ids the
 * client needs for links are looked up fresh on every read and may be null
 * when the archive no longer has the row.
 */
function withArchiveIds(entry) {
  const show = entry.show
    ? db().prepare('SELECT id, url FROM shows WHERE content_id = ?').get(entry.show.content_id)
    : null;
  const artist = entry.artist_norm
    ? db().prepare('SELECT id FROM artists WHERE name_norm = ?').get(entry.artist_norm)
    : null;
  return {
    ...entry,
    show_id: show?.id ?? null,
    show_url: show?.url ?? null,
    artist_id: artist?.id ?? null,
  };
}

router.get('/favourites', (req, res, next) => {
  try {
    const { done, kind } = req.query;
    // An empty kind means "all": api.js drops empty params, and a hand-typed
    // `?kind=` should not be an error.
    if (kind && !KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
    }
    let rows = listFavourites();
    if (done === 'true') rows = rows.filter(e => e.done);
    if (done === 'false') rows = rows.filter(e => !e.done);
    if (kind) rows = rows.filter(e => e.kind === kind);
    res.json(rows.map(withArchiveIds));
  } catch (e) { next(e); }
});

router.post('/favourites', async (req, res, next) => {
  try {
    const check = validateAdd(req.body);
    if (!check.ok) return res.status(400).json({ error: check.error });
    const candidate = resolveAdd(db(), check.add);
    if (!candidate) return res.status(404).json({ error: 'not found' });

    // Store first, cache second, with the same accepted gap as the annotation
    // PATCH handler above. add() is create-only, so a cache that lags the
    // store cannot make a repeat add overwrite notes or the done state.
    const { created, entry } = await getFavouritesStore().add(req.user.email, candidate);
    setFavourite(entry);
    res.status(created ? 201 : 200).json(withArchiveIds(entry));
  } catch (e) { next(e); }
});

function requireEntryId(req, res) {
  if (!isEntryId(req.params.id)) {
    res.status(400).json({ error: 'id must be 24 lowercase hex characters' });
    return null;
  }
  return req.params.id;
}

router.patch('/favourites/:id', async (req, res, next) => {
  try {
    const id = requireEntryId(req, res);
    if (id === null) return;
    const check = validateFavouritePatch(req.body);
    if (!check.ok) return res.status(400).json({ error: check.error });

    // merge() asks the store, not the cache, whether the id exists: the
    // store is the authority, and the cache may lag it.
    const merged = await getFavouritesStore().merge(req.user.email, id, check.patch);
    if (!merged) return res.status(404).json({ error: 'not found' });
    setFavourite(merged);
    res.json(withArchiveIds(merged));
  } catch (e) { next(e); }
});

router.delete('/favourites/:id', async (req, res, next) => {
  try {
    const id = requireEntryId(req, res);
    if (id === null) return;
    await getFavouritesStore().remove(req.user.email, id);
    deleteFavourite(id);
    res.status(204).end();
  } catch (e) { next(e); }
});

// Everything else (including the removed import endpoints) 404s as JSON
// rather than falling through to Express's default HTML error page.
router.use((_req, res) => res.status(404).json({ error: 'not found' }));

export default router;
