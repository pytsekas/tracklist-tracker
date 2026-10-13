import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { importCsv } from './importer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

export const DEFAULT_CSV_DIR      = path.resolve(__dirname, '../../data/csv');
export const DEFAULT_OUT          = path.resolve(__dirname, '../../data/tracklists.sqlite');
export const DEFAULT_SERIES       = path.resolve(__dirname, '../../data/series.json');
export const DEFAULT_BROADCASTERS = path.resolve(__dirname, '../../data/broadcasters.json');

/** Create a fresh database at `file` with the schema applied. */
export function createDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

/** List the CSVs in `dir`, tracks files first. Throws if there are none. */
function readCsvDir(dir) {
  if (!fs.existsSync(dir)) throw new Error(`CSV directory not found: ${dir}`);

  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.csv'));
  if (files.length === 0) throw new Error(`No CSV files in ${dir}`);

  // tracks first: the shows files add episodes that have no tracklist, and
  // they must land on top of the shows the tracks files already created.
  const rank = f => (/_tracks\.csv$/i.test(f) ? 0 : 1);
  return files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * Insert the broadcasters from `file` (data/broadcasters.json, keyed by slug).
 * Applied before the series file, which refers to these rows by slug.
 */
function applyBroadcastersFile(db, file) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const insert = db.prepare(`INSERT INTO broadcasters (slug, name, url) VALUES (?, ?, ?)`);
  for (const [slug, entry] of Object.entries(config)) {
    const { name, url } = entry ?? {};
    if (!name) throw new Error(`broadcasters.json: ${slug} has no name`);
    insert.run(slug, name, url ?? null);
  }
}

/**
 * Copy per-series settings from `file` (data/series.json, keyed by slug) onto
 * the imported series. An unknown series slug, or a `broadcaster` that is not
 * in the broadcasters table, throws: a typo would otherwise leave a series
 * without its archive URL or broadcaster and nothing would notice.
 */
function applySeriesFile(db, file) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const idOf = db.prepare(`SELECT id FROM broadcasters WHERE slug = ?`).pluck();
  const update = db.prepare(
    `UPDATE series SET archive_url = ?, broadcaster_id = ? WHERE slug = ?`);

  const resolveBroadcaster = slug => {
    if (slug == null) return null;
    const id = idOf.get(slug);
    if (id === undefined) throw new Error(`series.json names unknown broadcaster: ${slug}`);
    return id;
  };

  const unknown = Object.entries(config)
    .filter(([slug, { archive_url, broadcaster }]) =>
      update.run(archive_url ?? null, resolveBroadcaster(broadcaster), slug).changes === 0)
    .map(([slug]) => slug);
  if (unknown.length) {
    throw new Error(`series.json names unknown series: ${unknown.join(', ')}`);
  }
}

/**
 * Build a complete database from `csvDir` and move it into place at `outPath`.
 * Builds to a temporary file and renames only on success, so a failed build
 * never leaves a half-populated database behind.
 */
export function buildDatabase({
  csvDir = DEFAULT_CSV_DIR, outPath = DEFAULT_OUT,
  seriesFile = null, broadcastersFile = null,
} = {}) {
  const files = readCsvDir(csvDir);
  const tmp = `${outPath}.building`;
  // `db` is declared outside the try but ASSIGNED inside it. createDatabase()
  // creates the file before applying the schema, so a schema error would
  // otherwise escape with the temp file already on disk and no cleanup - the
  // exact leak this function's docstring promises not to have.
  let db = null;
  const results = [];

  try {
    db = createDatabase(tmp);
    for (const name of files) {
      const result = importCsv({
        db,
        filename: name,
        buffer: fs.readFileSync(path.join(csvDir, name)),
      });
      if (!result.ok) throw new Error(`${name}: ${result.message}`);
      results.push(result);
    }
    if (broadcastersFile) applyBroadcastersFile(db, broadcastersFile);
    if (seriesFile) applySeriesFile(db, seriesFile);

    const count = table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    const counts = {
      series: count('series'),
      shows: count('shows'),
      tracks: count('tracks'),
      artists: count('artists'),
    };

    if (counts.tracks === 0) {
      throw new Error('built database contains no tracks - refusing to ship it');
    }

    db.exec('VACUUM');
    db.close();
    fs.renameSync(tmp, outPath);
    return { counts, results };
  } catch (err) {
    // db may be null if createDatabase() itself threw. close() is a no-op on
    // an already-closed handle, and is wrapped so a close failure can never
    // mask the real error or skip the cleanup below.
    try { db?.close(); } catch { /* ignore */ }
    fs.rmSync(tmp, { force: true, recursive: true });
    throw err;
  }
}

/* --------------------------------- cli ------------------------------------ */

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { counts, results } = buildDatabase({
      seriesFile: DEFAULT_SERIES, broadcastersFile: DEFAULT_BROADCASTERS,
    });
    for (const r of results) {
      console.log(`  ${r.filename}: ${r.rows_read} rows, ${r.skipped} skipped`);
    }
    console.log(`built ${DEFAULT_OUT}`);
    console.log(
      `  series ${counts.series}  shows ${counts.shows}` +
      `  tracks ${counts.tracks}  artists ${counts.artists}`
    );
  } catch (err) {
    console.error(`build failed: ${err.message}`);
    process.exit(1);
  }
}
