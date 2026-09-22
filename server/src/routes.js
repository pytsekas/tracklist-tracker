import express from 'express';
import { db } from './db.js';
import { norm, likeEscape } from './normalize.js';
import { getStore, withAnnotation } from './annotations/index.js';
import { validatePatch } from './annotations/store.js';
import { upsertAnnotationRow, removeAnnotationRow, ANNOTATION_JOIN, ANNOTATION_COLUMNS }
  from './annotations/temp-table.js';

const router = express.Router();

const page = q => Math.max(1, Number(q.page) || 1);
const size = q => Math.min(500, Math.max(1, Number(q.pageSize) || 100));

// SQLite's LIKE only folds ASCII, so we match against the precomputed *_norm
// columns. ESCAPE lets a needle contain a literal % or _.
const LIKE_ESC = "ESCAPE '\\'";
const needle = q => `%${likeEscape(norm(q))}%`;

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
    const rows = db().prepare(`
      SELECT sh.id, sh.content_id, sh.title, sh.show_date, sh.url, sh.track_count,
             ${ANNOTATION_COLUMNS}
      FROM shows sh
      JOIN series s ON s.id = sh.series_id
      ${ANNOTATION_JOIN}
      WHERE s.slug = ?
      ORDER BY sh.show_date DESC, sh.id DESC
      LIMIT ? OFFSET ?`).all(req.params.slug, ps, (p - 1) * ps);
    const { total } = db().prepare(
      `SELECT COUNT(*) AS total FROM shows sh JOIN series s ON s.id = sh.series_id WHERE s.slug = ?`
    ).get(req.params.slug);
    res.json({ rows: rows.map(withAnnotation), total, page: p, pageSize: ps });
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
    res.json({ show: rest, tracks, annotation });
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

    res.json({ rows, total, page: p, pageSize: ps });
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
    res.json({ rows, total, page: p, pageSize: ps });
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
    res.json({ artist, tracks });
  } catch (e) { next(e); }
});

/* ------------------------------ annotations -------------------------------- */

router.get('/me', (req, res) => res.json({ email: req.user.email }));

router.get('/tags', (_req, res, next) => {
  try {
    res.json(db().prepare(`
      SELECT j.value AS tag, COUNT(*) AS count
      FROM annotations a, json_each(a.tags) j
      GROUP BY j.value
      ORDER BY count DESC, tag COLLATE NOCASE`).all());
  } catch (e) { next(e); }
});

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

    // Durable store first. Only once it has accepted the write does the temp
    // table move, so the two cannot disagree. Known residual: if
    // upsertAnnotationRow itself throws after merge() already committed, the
    // store and temp table could disagree. Accepted rather than guarded —
    // same process, same connection, temp table this process just created.
    const merged = await getStore().merge(req.user.email, contentId, check.patch);
    upsertAnnotationRow(db(), contentId, merged);
    res.json(merged);
  } catch (e) { next(e); }
});

router.delete('/shows/:contentId/annotation', async (req, res, next) => {
  try {
    const contentId = requireShow(req, res);
    if (contentId === null) return;

    // Same order and the same residual as the PATCH handler above: store
    // first, temp table only on success; a post-commit temp-table throw here
    // is accepted, not guarded.
    await getStore().remove(req.user.email, contentId);
    removeAnnotationRow(db(), contentId);
    res.status(204).end();
  } catch (e) { next(e); }
});

// Everything else (including the removed import endpoints) 404s as JSON
// rather than falling through to Express's default HTML error page.
router.use((_req, res) => res.status(404).json({ error: 'not found' }));

export default router;
