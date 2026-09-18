import express from 'express';
import multer from 'multer';
import { pool } from './db.js';
import { importCsv } from './importer.js';

const router = express.Router();
const maxMb = Number(process.env.MAX_UPLOAD_MB || 32);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxMb * 1024 * 1024, files: 40 },
});

const page = q => Math.max(1, Number(q.page) || 1);
const size = q => Math.min(500, Math.max(1, Number(q.pageSize) || 100));

/* ---------------------------------- stats --------------------------------- */

router.get('/stats', async (_req, res, next) => {
  try {
    const [[row]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM series)  AS series,
        (SELECT COUNT(*) FROM shows)   AS shows,
        (SELECT COUNT(*) FROM tracks)  AS tracks,
        (SELECT COUNT(*) FROM artists) AS artists`);
    res.json(row);
  } catch (e) { next(e); }
});

/* --------------------------------- series --------------------------------- */

router.get('/series', async (_req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.id, s.slug, s.name,
             COUNT(DISTINCT sh.id) AS show_count,
             COALESCE(SUM(sh.track_count), 0) AS track_count,
             MIN(sh.show_date) AS first_show,
             MAX(sh.show_date) AS last_show
      FROM series s
      LEFT JOIN shows sh ON sh.series_id = s.id
      GROUP BY s.id
      ORDER BY s.name`);
    res.json(rows);
  } catch (e) { next(e); }
});

router.get('/series/:slug/shows', async (req, res, next) => {
  try {
    const p = page(req.query), ps = size(req.query);
    const [rows] = await pool.query(`
      SELECT sh.id, sh.content_id, sh.title, sh.show_date, sh.url, sh.track_count
      FROM shows sh
      JOIN series s ON s.id = sh.series_id
      WHERE s.slug = ?
      ORDER BY sh.show_date DESC, sh.id DESC
      LIMIT ? OFFSET ?`, [req.params.slug, ps, (p - 1) * ps]);
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM shows sh JOIN series s ON s.id = sh.series_id WHERE s.slug = ?`,
      [req.params.slug]);
    res.json({ rows, total, page: p, pageSize: ps });
  } catch (e) { next(e); }
});

/* ---------------------------------- shows --------------------------------- */

router.get('/shows/:id', async (req, res, next) => {
  try {
    const [[show]] = await pool.query(`
      SELECT sh.*, s.name AS series_name, s.slug AS series_slug
      FROM shows sh JOIN series s ON s.id = sh.series_id
      WHERE sh.id = ?`, [req.params.id]);
    if (!show) return res.status(404).json({ error: 'not found' });
    const [tracks] = await pool.query(`
      SELECT t.id, t.position, t.title, a.id AS artist_id, a.name AS artist
      FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id
      WHERE t.show_id = ? ORDER BY t.position`, [req.params.id]);
    res.json({ show, tracks });
  } catch (e) { next(e); }
});

/* --------------------------------- tracks --------------------------------- */

router.get('/tracks', async (req, res, next) => {
  try {
    const p = page(req.query), ps = size(req.query);
    const where = [], args = [];
    if (req.query.q) {
      where.push('(t.title LIKE ? OR a.name LIKE ?)');
      args.push(`%${req.query.q}%`, `%${req.query.q}%`);
    }
    if (req.query.series) { where.push('s.slug = ?'); args.push(req.query.series); }
    if (req.query.from) { where.push('sh.show_date >= ?'); args.push(req.query.from); }
    if (req.query.to) { where.push('sh.show_date <= ?'); args.push(req.query.to); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(`
      SELECT t.id, t.title, a.id AS artist_id, a.name AS artist,
             sh.id AS show_id, sh.title AS show_title, sh.show_date, sh.url AS show_url,
             s.name AS series_name, s.slug AS series_slug
      FROM tracks t
      LEFT JOIN artists a ON a.id = t.artist_id
      JOIN shows sh ON sh.id = t.show_id
      JOIN series s ON s.id = sh.series_id
      ${clause}
      ORDER BY sh.show_date DESC, t.position
      LIMIT ? OFFSET ?`, [...args, ps, (p - 1) * ps]);

    const [[{ total }]] = await pool.query(`
      SELECT COUNT(*) AS total
      FROM tracks t
      LEFT JOIN artists a ON a.id = t.artist_id
      JOIN shows sh ON sh.id = t.show_id
      JOIN series s ON s.id = sh.series_id
      ${clause}`, args);

    res.json({ rows, total, page: p, pageSize: ps });
  } catch (e) { next(e); }
});

/* --------------------------------- artists -------------------------------- */

router.get('/artists', async (req, res, next) => {
  try {
    const p = page(req.query), ps = size(req.query);
    const where = [], args = [];
    if (req.query.q) { where.push('a.name LIKE ?'); args.push(`%${req.query.q}%`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(`
      SELECT a.id, a.name, COUNT(t.id) AS plays,
             COUNT(DISTINCT sh.series_id) AS series_count
      FROM artists a
      JOIN tracks t ON t.artist_id = a.id
      JOIN shows sh ON sh.id = t.show_id
      ${clause}
      GROUP BY a.id
      ORDER BY plays DESC, a.name
      LIMIT ? OFFSET ?`, [...args, ps, (p - 1) * ps]);
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM artists a ${clause}`, args);
    res.json({ rows, total, page: p, pageSize: ps });
  } catch (e) { next(e); }
});

router.get('/artists/:id', async (req, res, next) => {
  try {
    const [[artist]] = await pool.query(`SELECT * FROM artists WHERE id = ?`, [req.params.id]);
    if (!artist) return res.status(404).json({ error: 'not found' });
    const [tracks] = await pool.query(`
      SELECT t.id, t.title, sh.id AS show_id, sh.title AS show_title, sh.show_date,
             sh.url AS show_url, s.name AS series_name, s.slug AS series_slug
      FROM tracks t
      JOIN shows sh ON sh.id = t.show_id
      JOIN series s ON s.id = sh.series_id
      WHERE t.artist_id = ?
      ORDER BY sh.show_date DESC`, [req.params.id]);
    res.json({ artist, tracks });
  } catch (e) { next(e); }
});

/* --------------------------------- import --------------------------------- */

router.post('/import', upload.array('files'), async (req, res, next) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error: 'no files uploaded' });
    const results = [];
    for (const f of req.files) {
      results.push(await importCsv({
        filename: f.originalname,
        buffer: f.buffer,
        seriesSlug: req.body.seriesSlug || null,
        seriesName: req.body.seriesName || null,
      }));
    }
    res.json({ results });
  } catch (e) { next(e); }
});

router.get('/imports', async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM imports ORDER BY created_at DESC, id DESC LIMIT 50`);
    res.json(rows);
  } catch (e) { next(e); }
});

export default router;
