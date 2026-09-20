import { parse } from 'csv-parse/sync';
import { norm } from './normalize.js';

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

function upsertSeries(db, slug, name) {
  db.prepare(
    `INSERT INTO series (slug, name) VALUES (?, ?)
     ON CONFLICT(slug) DO UPDATE SET name = excluded.name`
  ).run(slug, name);
  return db.prepare(`SELECT id FROM series WHERE slug = ?`).get(slug).id;
}

/**
 * Resolve artist names to ids, creating the ones we have not seen.
 * Returns Map(name_norm -> id) and the number of newly created rows.
 */
function resolveArtists(db, names) {
  const wanted = new Map();               // name_norm -> display name
  for (const n of names) {
    const k = norm(n);
    if (k && !wanted.has(k)) wanted.set(k, n.trim());
  }
  if (wanted.size === 0) return { map: new Map(), created: 0 };

  const insert = db.prepare(
    `INSERT INTO artists (name, name_norm) VALUES (?, ?)
     ON CONFLICT(name_norm) DO NOTHING`
  );
  const select = db.prepare(`SELECT id FROM artists WHERE name_norm = ?`);

  const map = new Map();
  let created = 0;
  for (const [key, display] of wanted) {
    if (insert.run(display, key).changes > 0) created++;
    map.set(key, select.get(key).id);
  }
  return { map, created };
}

function upsertShow(db, { contentId, seriesId, title, showDate, url, trackCount }) {
  db.prepare(
    `INSERT INTO shows (content_id, series_id, title, show_date, url, track_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(content_id) DO UPDATE SET
       series_id   = excluded.series_id,
       title       = excluded.title,
       show_date   = COALESCE(excluded.show_date, shows.show_date),
       url         = COALESCE(excluded.url, shows.url),
       track_count = excluded.track_count,
       updated_at  = datetime('now')`
  ).run(contentId, seriesId, title, showDate, url, trackCount);
  return db.prepare(`SELECT id FROM shows WHERE content_id = ?`).get(contentId).id;
}

/* ------------------------------------------------------------------ *
 * Import entry point
 * ------------------------------------------------------------------ */

/**
 * Import one CSV buffer into `db`. Synchronous: better-sqlite3 has no async API.
 *
 * Re-importing the same file is safe: shows match on content_id and a show's
 * tracks are replaced wholesale, so nothing is duplicated.
 */
export function importCsv({ db, filename, buffer, seriesSlug: slugOverride, seriesName }) {
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
    return result;
  }

  const run = db.transaction(() => {
    const displayName =
      seriesName ||
      (kind === 'tracks' && records[0]?.show_title
        ? String(records[0].show_title).split(/[.:]/)[0].trim()
        : prettify(slug));
    const seriesId = upsertSeries(db, slug, displayName || prettify(slug));

    if (kind === 'shows') {
      for (const r of records) {
        const url = r.show_url?.trim();
        const contentId = contentIdFromUrl(url);
        if (!contentId) { result.skipped++; continue; }
        upsertShow(db, {
          contentId, seriesId,
          title: (r.show_title || '').trim() || prettify(slug),
          showDate: parseEstDate(r.show_date),
          url,
          trackCount: Number(r.track_count || 0),
        });
        result.shows_upserted++;
      }
      return;
    }

    // group rows by episode, preserving file order as the track order
    const groups = new Map();
    for (const r of records) {
      const contentId = Number(r.content_id) || contentIdFromUrl(r.show_url);
      if (!contentId) { result.skipped++; continue; }
      if (!groups.has(contentId)) groups.set(contentId, []);
      groups.get(contentId).push(r);
    }

    const { map: artistMap, created } = resolveArtists(
      db, records.map(r => r.artist).filter(Boolean)
    );
    result.artists_created = created;

    const deleteTracks = db.prepare(`DELETE FROM tracks WHERE show_id = ?`);
    const insertTrack = db.prepare(
      `INSERT INTO tracks (show_id, artist_id, title, title_norm, position)
       VALUES (?, ?, ?, ?, ?)`
    );

    for (const [contentId, rows] of groups) {
      const first = rows[0];
      const showId = upsertShow(db, {
        contentId, seriesId,
        title: (first.show_title || '').trim() || prettify(slug),
        showDate: parseEstDate(first.show_date),
        url: first.show_url?.trim() || null,
        trackCount: rows.length,
      });
      result.shows_upserted++;

      // replace, don't append - keeps re-imports idempotent
      deleteTracks.run(showId);

      rows.forEach((r, i) => {
        const title = (r.title || '').trim();
        insertTrack.run(showId, artistMap.get(norm(r.artist)) ?? null, title, norm(title), i + 1);
        result.tracks_inserted++;
      });
    }
  });

  try {
    run();
  } catch (err) {
    // db.transaction() has already rolled back by the time we get here.
    result.ok = false;
    result.message = err.message;
    result.shows_upserted = 0;
    result.tracks_inserted = 0;
    result.artists_created = 0;
  }

  return result;
}
