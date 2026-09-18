import { parse } from 'csv-parse/sync';
import { pool } from './db.js';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** "12.09.2026" -> "2026-09-12" (MySQL DATE). Returns null for "?" or junk. */
export function parseEstDate(s) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec((s || '').trim());
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Pull ERR's numeric episode id out of a show URL. */
export function contentIdFromUrl(url) {
  const m = /err\.ee\/(\d+)/.exec(url || '');
  return m ? Number(m[1]) : null;
}

/** eesti_pops_tracks.csv -> { slug: 'eesti_pops', kind: 'tracks' } */
export function parseFilename(filename) {
  const base = filename.replace(/\.csv$/i, '');
  const m = /^(.*)_(tracks|shows)$/.exec(base);
  if (!m) return { slug: null, kind: null };
  return { slug: m[1].toLowerCase(), kind: m[2] };
}

/** Turn a slug into something readable if we have nothing better. */
function prettify(slug) {
  return slug.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

const norm = s => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Decide what a CSV is from its header row. */
export function detectKind(headers) {
  const h = headers.map(x => x.trim().toLowerCase());
  if (h.includes('artist') && h.includes('title') && h.includes('content_id')) return 'tracks';
  if (h.includes('show_title') && h.includes('track_count')) return 'shows';
  return 'unknown';
}

/* ------------------------------------------------------------------ *
 * Lookups
 * ------------------------------------------------------------------ */

async function upsertSeries(conn, slug, name) {
  await conn.query(
    `INSERT INTO series (slug, name) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [slug, name]
  );
  const [rows] = await conn.query(`SELECT id FROM series WHERE slug = ?`, [slug]);
  return rows[0].id;
}

/**
 * Resolve many artist names to ids in as few round trips as possible.
 * Returns Map(name_norm -> id) and the number of newly created rows.
 */
async function resolveArtists(conn, names) {
  const wanted = new Map();               // name_norm -> display name
  for (const n of names) {
    const k = norm(n);
    if (k && !wanted.has(k)) wanted.set(k, n.trim());
  }
  if (wanted.size === 0) return { map: new Map(), created: 0 };

  const keys = [...wanted.keys()];
  const map = new Map();

  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const [rows] = await conn.query(
      `SELECT id, name_norm FROM artists WHERE name_norm IN (?)`, [chunk]
    );
    for (const r of rows) map.set(r.name_norm, r.id);
  }

  const missing = keys.filter(k => !map.has(k));
  let created = 0;
  for (let i = 0; i < missing.length; i += 500) {
    const chunk = missing.slice(i, i + 500);
    const values = chunk.map(k => [wanted.get(k), k]);
    const [res] = await conn.query(
      `INSERT IGNORE INTO artists (name, name_norm) VALUES ?`, [values]
    );
    created += res.affectedRows || 0;
    const [rows] = await conn.query(
      `SELECT id, name_norm FROM artists WHERE name_norm IN (?)`, [chunk]
    );
    for (const r of rows) map.set(r.name_norm, r.id);
  }
  return { map, created };
}

async function upsertShow(conn, { contentId, seriesId, title, showDate, url, trackCount }) {
  await conn.query(
    `INSERT INTO shows (content_id, series_id, title, show_date, url, track_count)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       series_id   = VALUES(series_id),
       title       = VALUES(title),
       show_date   = COALESCE(VALUES(show_date), show_date),
       url         = COALESCE(VALUES(url), url),
       track_count = VALUES(track_count)`,
    [contentId, seriesId, title, showDate, url, trackCount]
  );
  const [rows] = await conn.query(`SELECT id FROM shows WHERE content_id = ?`, [contentId]);
  return rows[0].id;
}

/* ------------------------------------------------------------------ *
 * Import entry point
 * ------------------------------------------------------------------ */

/**
 * Import one CSV buffer.
 * Re-importing the same file is safe: shows match on content_id and a show's
 * tracks are replaced wholesale, so nothing is duplicated.
 */
export async function importCsv({ filename, buffer, seriesSlug: slugOverride, seriesName }) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const records = parse(text, { columns: true, skip_empty_lines: true, trim: false, bom: true });
  const headers = records.length ? Object.keys(records[0]) : [];
  const kind = detectKind(headers);
  const fromName = parseFilename(filename);
  const slug = (slugOverride || fromName.slug || 'unknown').toLowerCase();

  const result = {
    filename, kind, series_slug: slug,
    rows_read: records.length,
    shows_upserted: 0, tracks_inserted: 0, artists_created: 0, skipped: 0,
    ok: true, message: null,
  };

  if (kind === 'unknown') {
    result.ok = false;
    result.message = `Unrecognised columns: ${headers.join(', ')}`;
    await logImport(result);
    return result;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const displayName =
      seriesName ||
      (kind === 'tracks' && records[0]?.show_title
        ? String(records[0].show_title).split(/[.:]/)[0].trim()
        : prettify(slug));
    const seriesId = await upsertSeries(conn, slug, displayName || prettify(slug));

    if (kind === 'shows') {
      for (const r of records) {
        const url = r.show_url?.trim();
        const contentId = contentIdFromUrl(url);
        if (!contentId) { result.skipped++; continue; }
        await upsertShow(conn, {
          contentId, seriesId,
          title: (r.show_title || '').trim() || prettify(slug),
          showDate: parseEstDate(r.show_date),
          url,
          trackCount: Number(r.track_count || 0),
        });
        result.shows_upserted++;
      }
    } else {
      // group rows by episode, preserving file order as the track order
      const groups = new Map();
      for (const r of records) {
        const contentId = Number(r.content_id) || contentIdFromUrl(r.show_url);
        if (!contentId) { result.skipped++; continue; }
        if (!groups.has(contentId)) groups.set(contentId, []);
        groups.get(contentId).push(r);
      }

      const { map: artistMap, created } = await resolveArtists(
        conn, records.map(r => r.artist).filter(Boolean)
      );
      result.artists_created = created;

      for (const [contentId, rows] of groups) {
        const first = rows[0];
        const showId = await upsertShow(conn, {
          contentId, seriesId,
          title: (first.show_title || '').trim() || prettify(slug),
          showDate: parseEstDate(first.show_date),
          url: first.show_url?.trim() || null,
          trackCount: rows.length,
        });
        result.shows_upserted++;

        // replace, don't append - keeps re-imports idempotent
        await conn.query(`DELETE FROM tracks WHERE show_id = ?`, [showId]);

        const values = rows.map((r, i) => [
          showId,
          artistMap.get(norm(r.artist)) ?? null,
          (r.title || '').trim(),
          i + 1,
        ]);
        for (let i = 0; i < values.length; i += 1000) {
          const chunk = values.slice(i, i + 1000);
          const [res] = await conn.query(
            `INSERT INTO tracks (show_id, artist_id, title, position) VALUES ?`, [chunk]
          );
          result.tracks_inserted += res.affectedRows || 0;
        }
      }
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    result.ok = false;
    result.message = err.message;
  } finally {
    conn.release();
  }

  await logImport(result);
  return result;
}

async function logImport(r) {
  await pool.query(
    `INSERT INTO imports
       (filename, kind, series_slug, rows_read, shows_upserted, tracks_inserted,
        artists_created, skipped, ok, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [r.filename, r.kind, r.series_slug, r.rows_read, r.shows_upserted,
     r.tracks_inserted, r.artists_created, r.skipped, r.ok ? 1 : 0, r.message]
  );
}
