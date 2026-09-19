# Build-time SQLite Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the MariaDB server with a read-only SQLite file that is built from committed CSVs at image build time and shipped inside the container.

**Architecture:** A new `build-db.js` CLI drives the existing `importCsv()` over `data/csv/` and writes `data/tracklists.sqlite`; the Dockerfile runs it in a build stage and copies the result into the runtime image. The server opens that file read-only and never writes. All SQL query shapes in `routes.js` are preserved — only the dialect and the call style change, plus a move to precomputed `_norm` columns so Unicode case-folding survives the loss of MariaDB's `utf8mb4_unicode_ci` collation.

**Tech Stack:** Node 22 (ES modules), Express 4, `better-sqlite3`, `csv-parse`, React 18 + Vite, Docker multi-stage build, `node:test` for tests.

**Spec:** `docs/superpowers/specs/2026-09-18-sqlite-storage-design.md` (committed as `ff468b2`)

## Global Constraints

- Node 22+, ES modules throughout (`"type": "module"`). Use `import`, never `require`.
- Tests use Node's built-in `node:test` and `node:assert/strict`. **Do not add a test framework dependency.**
- `better-sqlite3` is **synchronous**. There is no `await` on any database call. A route handler that still says `async` is a mistake.
- Diacritics are **preserved, never stripped**: `õ`, `ä`, `ö`, `ü` are distinct Estonian letters. `magi` must NOT match `Mägi`.
- The runtime container must have **no write path to the database**. Opened with `{ readonly: true, fileMustExist: true }`.
- Work happens on branch `sqlite-storage`. Commit after every task.
- CSV processing order is always **`*_tracks.csv` first, then `*_shows.csv`** — the shows files add episodes that have no tracklist.

## Prerequisites

**Before Task 8** (and before any full `docker compose build`), the real scraped CSVs must be placed in `data/csv/` and committed. Tasks 1–7 and 9 use only the test fixtures created in Task 4 and do not need them.

**Before deleting the old MariaDB volume**, capture the current row counts for the rollout comparison in Task 10. The container `tracklist-browser-db-1` still exists.

## Out of scope — do not "fix" these

- **`/api/artists` count mismatch.** The rows query joins through `tracks` so it only returns artists that have plays; the `total` count query counts every matching artist. These disagree when an artist has no tracks. This is pre-existing behaviour, unrelated to the migration, and changing it would muddy the diff. Port it as-is.
- FTS5, search ranking, artist punctuation-deduplication, the GCP/Terraform work.

---

### Task 1: Test harness and `normalize.js`

Creates the shared search-normalisation module and the first tests. Nothing else depends on the old database, so this task is fully isolated.

**Files:**
- Create: `server/src/normalize.js`
- Create: `server/test/normalize.test.js`
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `norm(s: string | null | undefined) => string` — trims, lowercases (Unicode-aware), collapses internal whitespace runs to one space
  - `likeEscape(s: string | null | undefined) => string` — backslash-escapes `\`, `%` and `_` for use with `LIKE ... ESCAPE '\'`

- [ ] **Step 1: Add the test script**

In the root `package.json`, add to `"scripts"`:

```json
"test": "node --test 'server/test/**/*.test.js'"
```

The glob is required, not cosmetic: `node --test server/test/` — a bare
directory — fails on Node 24, which treats the path as a test file and reports
`✖ server/test ... pass 0 / fail 1`. Keep the quotes so Node does the globbing
rather than the shell.

- [ ] **Step 2: Write the failing tests**

Create `server/test/normalize.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { norm, likeEscape } from '../src/normalize.js';

test('norm lowercases Estonian letters', () => {
  assert.equal(norm('Õhtu'), 'õhtu');
  assert.equal(norm('MÄGI'), 'mägi');
  assert.equal(norm('Öö ÜLE'), 'öö üle');
});

test('norm trims and collapses whitespace', () => {
  assert.equal(norm('  a   b  '), 'a b');
  assert.equal(norm('a\t\nb'), 'a b');
});

test('norm handles empty input', () => {
  assert.equal(norm(null), '');
  assert.equal(norm(undefined), '');
  assert.equal(norm(''), '');
});

test('norm keeps diacritics distinct', () => {
  // õ/ä/ö/ü are separate Estonian letters, not accented variants.
  assert.notEqual(norm('Mägi'), norm('magi'));
  assert.notEqual(norm('Õhtu'), norm('ohtu'));
});

test('likeEscape escapes LIKE metacharacters', () => {
  assert.equal(likeEscape('50%'), '50\\%');
  assert.equal(likeEscape('a_b'), 'a\\_b');
  assert.equal(likeEscape('c\\d'), 'c\\\\d');
});

test('likeEscape leaves ordinary text alone', () => {
  assert.equal(likeEscape('Õhtu jõuab'), 'Õhtu jõuab');
  assert.equal(likeEscape(null), '');
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/normalize.js'`

- [ ] **Step 4: Write the implementation**

Create `server/src/normalize.js`:

```js
/**
 * Fold a string for case-insensitive search.
 *
 * JavaScript's toLowerCase() is Unicode-aware, so Õ -> õ and Ä -> ä. This is
 * what MariaDB's utf8mb4_unicode_ci collation gave us for free; SQLite's LIKE
 * only folds ASCII, so we precompute this into *_norm columns instead.
 *
 * Diacritics are preserved on purpose: in Estonian õ, ä, ö and ü are distinct
 * letters, so "magi" must not match "Mägi".
 */
export const norm = s => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Escape the LIKE metacharacters in a search needle so a query for "50%"
 * matches a literal percent sign instead of every row. Pair with ESCAPE '\'.
 */
export const likeEscape = s => String(s ?? '').replace(/[\\%_]/g, c => `\\${c}`);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 6 tests

- [ ] **Step 6: Commit**

```bash
git add package.json server/src/normalize.js server/test/normalize.test.js
git commit -m "Add normalize module with Unicode-aware search folding"
```

---

### Task 2: Characterization tests for the importer's pure helpers

These four functions are already exported and currently untested. Pinning their behaviour **before** Task 4 rewrites the file around them is what makes that rewrite safe.

**Files:**
- Create: `server/test/importer-helpers.test.js`

**Interfaces:**
- Consumes: `parseEstDate`, `contentIdFromUrl`, `parseFilename`, `detectKind` from `server/src/importer.js` (all already exported)
- Produces: nothing — test-only task

Note: `importer.js` currently imports `pool` from `db.js`, which calls `mysql.createPool()` at module load. That does not open a connection, so importing the module in a test is safe. After Task 4 the import disappears entirely.

- [ ] **Step 1: Write the tests**

Create `server/test/importer-helpers.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEstDate,
  contentIdFromUrl,
  parseFilename,
  detectKind,
} from '../src/importer.js';

test('parseEstDate converts dd.mm.yyyy to ISO', () => {
  assert.equal(parseEstDate('12.09.2026'), '2026-09-12');
  assert.equal(parseEstDate('  01.02.2024  '), '2024-02-01');
});

test('parseEstDate returns null for junk', () => {
  assert.equal(parseEstDate('?'), null);
  assert.equal(parseEstDate(''), null);
  assert.equal(parseEstDate(null), null);
  assert.equal(parseEstDate('2024-02-01'), null);
});

test('contentIdFromUrl pulls the episode id out of an ERR url', () => {
  assert.equal(contentIdFromUrl('https://r2.err.ee/1610128043/saade'), 1610128043);
  assert.equal(contentIdFromUrl('https://err.ee/123'), 123);
});

test('contentIdFromUrl returns null when there is no id', () => {
  assert.equal(contentIdFromUrl('https://example.com/x'), null);
  assert.equal(contentIdFromUrl(''), null);
  assert.equal(contentIdFromUrl(null), null);
});

test('parseFilename splits slug and kind', () => {
  assert.deepEqual(parseFilename('eesti_pops_tracks.csv'), { slug: 'eesti_pops', kind: 'tracks' });
  assert.deepEqual(parseFilename('fantaasia_shows.csv'), { slug: 'fantaasia', kind: 'shows' });
  assert.deepEqual(parseFilename('Eesti_Pops_tracks.csv'), { slug: 'eesti_pops', kind: 'tracks' });
});

test('parseFilename returns nulls for an unrecognised name', () => {
  assert.deepEqual(parseFilename('random.csv'), { slug: null, kind: null });
});

test('detectKind reads the header row', () => {
  assert.equal(detectKind(['content_id', 'artist', 'title']), 'tracks');
  assert.equal(detectKind(['show_title', 'track_count']), 'shows');
  assert.equal(detectKind([' Content_ID ', 'ARTIST', 'Title']), 'tracks');
  assert.equal(detectKind(['foo', 'bar']), 'unknown');
});
```

- [ ] **Step 2: Run the tests**

Run: `npm test`
Expected: PASS — all tests green. These describe existing behaviour, so they must pass without touching `importer.js`.

If any fail, **stop and report** — it means the helper does not behave as the plan assumed, and Task 4 needs rethinking before it starts.

- [ ] **Step 3: Commit**

```bash
git add server/test/importer-helpers.test.js
git commit -m "Add characterization tests for importer helpers"
```

---

### Task 3: SQLite schema and `createDatabase()`

Ports `schema.sql` and adds the function that creates a fresh database from it.

**Files:**
- Modify: `server/src/schema.sql` (full rewrite)
- Create: `server/src/build-db.js`
- Create: `server/test/build-db.test.js`
- Modify: `server/package.json` (add `better-sqlite3`)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `createDatabase(file: string) => Database` — removes any existing file, creates it, enables foreign keys, applies `schema.sql`, returns the open handle
  - `DEFAULT_CSV_DIR: string`, `DEFAULT_OUT: string` — absolute paths to `data/csv` and `data/tracklists.sqlite`

**Deliberate refinement of the spec:** the spec's schema listing opens with `PRAGMA foreign_keys = ON;`. That line is **not** in the ported file. `foreign_keys` is per-connection state, not schema, and it is silently a no-op if executed inside a transaction — so it belongs in code where it is unambiguous. `createDatabase()` sets it via `db.pragma()`.

- [ ] **Step 1: Add the dependency**

```bash
npm install --workspace server better-sqlite3
```

Verify it appears in `server/package.json` dependencies. Do not remove `mysql2` or `multer` yet — `routes.js` and `importer.js` still use them until Tasks 4 and 6.

- [ ] **Step 2: Write the failing test**

Create `server/test/build-db.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../src/build-db.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-')), 'test.sqlite');
}

test('createDatabase applies the schema', () => {
  const db = createDatabase(tmpFile());
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
  ).all().map(r => r.name);
  assert.deepEqual(tables, ['artists', 'series', 'shows', 'tracks']);
  db.close();
});

test('createDatabase does not create an imports table', () => {
  const db = createDatabase(tmpFile());
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'imports'`
  ).get();
  assert.equal(row, undefined);
  db.close();
});

test('createDatabase enforces foreign keys', () => {
  const db = createDatabase(tmpFile());
  assert.throws(
    () => db.prepare(
      `INSERT INTO shows (content_id, series_id, title, track_count)
       VALUES (1, 999, 'orphan', 0)`
    ).run(),
    /FOREIGN KEY constraint failed/
  );
  db.close();
});

test('createDatabase starts from empty each time', () => {
  const file = tmpFile();
  const first = createDatabase(file);
  first.prepare(`INSERT INTO series (slug, name) VALUES ('x', 'X')`).run();
  first.close();

  const second = createDatabase(file);
  assert.equal(second.prepare(`SELECT COUNT(*) AS n FROM series`).get().n, 0);
  second.close();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/build-db.js'`

- [ ] **Step 4: Rewrite the schema**

Replace the entire contents of `server/src/schema.sql`:

```sql
-- SQLite schema. Applied once, at build time, by server/src/build-db.js.
-- The running server opens the resulting file read-only and never writes.
-- Foreign keys are enabled in code (see createDatabase), not here: the pragma
-- is per-connection state and is a silent no-op inside a transaction.

CREATE TABLE IF NOT EXISTS series (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  channel     TEXT,
  archive_url TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shows (
  id          INTEGER PRIMARY KEY,
  content_id  INTEGER NOT NULL UNIQUE,      -- ERR's own episode id: the natural key
  series_id   INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  show_date   TEXT,                          -- YYYY-MM-DD, compared lexicographically
  url         TEXT,
  track_count INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shows_date        ON shows(show_date);
CREATE INDEX IF NOT EXISTS idx_shows_series_date ON shows(series_id, show_date);

CREATE TABLE IF NOT EXISTS artists (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,                   -- as printed by ERR
  name_norm TEXT NOT NULL UNIQUE             -- normalize.js norm(), used for matching
);

CREATE TABLE IF NOT EXISTS tracks (
  id         INTEGER PRIMARY KEY,
  show_id    INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  artist_id  INTEGER REFERENCES artists(id) ON DELETE SET NULL,
  title      TEXT NOT NULL,
  title_norm TEXT NOT NULL,                  -- normalize.js norm(), used for search
  position   INTEGER NOT NULL,               -- order within the show, 1-based
  UNIQUE (show_id, position)
);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id);
```

No index is created for `artists.name_norm`, `shows.content_id`, or `tracks(show_id, position)` — the `UNIQUE` constraints already create one. `tracks(show_id, position)` in particular serves the `WHERE show_id = ? ORDER BY position` query in `/api/shows/:id`.

- [ ] **Step 5: Write `createDatabase()`**

Create `server/src/build-db.js`:

```js
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

export const DEFAULT_CSV_DIR = path.resolve(__dirname, '../../data/csv');
export const DEFAULT_OUT     = path.resolve(__dirname, '../../data/tracklists.sqlite');

/** Create a fresh database at `file` with the schema applied. */
export function createDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 4 new tests green, Tasks 1 and 2 still green.

- [ ] **Step 7: Commit**

```bash
git add server/package.json server/src/schema.sql server/src/build-db.js server/test/build-db.test.js package-lock.json
git commit -m "Port schema to SQLite and add createDatabase"
```

---

### Task 4: Port `importer.js` to better-sqlite3

The largest behavioural change. All parsing stays; every write moves. The helper tests from Task 2 must stay green throughout — they are the safety net for this rewrite.

**Files:**
- Modify: `server/src/importer.js`
- Create: `server/test/fixtures/csv/testshow_tracks.csv`
- Create: `server/test/fixtures/csv/testshow_shows.csv`
- Create: `server/test/importer.test.js`

**Interfaces:**
- Consumes: `createDatabase(file)` from Task 3; `norm(s)` from Task 1
- Produces:
  - `importCsv({ db, filename, buffer, seriesSlug?, seriesName? }) => result` — **synchronous**, no longer returns a Promise
  - `result` shape: `{ filename, kind, series_slug, rows_read, shows_upserted, tracks_inserted, artists_created, skipped, ok, message }`

Three changes beyond the mechanical port:
1. `logImport()` and the `imports` table are deleted.
2. The local `const norm = ...` at `importer.js:34` is deleted; `norm` is imported from `normalize.js`.
3. The 500/1000-row chunking loops are removed. They existed to limit MySQL round trips; better-sqlite3 runs in-process, so a straight loop over prepared statements is both simpler and faster.

- [ ] **Step 1: Create the test fixtures**

Create `server/test/fixtures/csv/testshow_tracks.csv`:

```
content_id,show_title,show_date,show_url,artist,title
1610000001,Testsaade. Esimene,01.02.2024,https://r2.err.ee/1610000001/testsaade,Mägi,Õhtu jõuab
1610000001,Testsaade. Esimene,01.02.2024,https://r2.err.ee/1610000001/testsaade,MÄGI,Teine lugu
1610000001,Testsaade. Esimene,01.02.2024,https://r2.err.ee/1610000001/testsaade,,Nimeta lugu
1610000002,Testsaade. Teine,15.03.2024,https://r2.err.ee/1610000002/testsaade,Ansambel 50%,Sada protsenti
```

Create `server/test/fixtures/csv/testshow_shows.csv`:

```
show_title,show_date,show_url,track_count
Testsaade. Kolmas,20.04.2024,https://r2.err.ee/1610000003/testsaade,0
```

These fixtures deliberately exercise: artist deduplication (`Mägi` / `MÄGI` fold to one artist), a blank artist, a `%` in an artist name for the LIKE-escape test, Estonian letters, and an episode with no tracklist.

- [ ] **Step 2: Write the failing tests**

Create `server/test/importer.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../src/build-db.js';
import { importCsv } from '../src/importer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures/csv');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-'));
  return createDatabase(path.join(dir, 'test.sqlite'));
}

function load(db, name) {
  return importCsv({ db, filename: name, buffer: fs.readFileSync(path.join(FIXTURES, name)) });
}

test('importing a tracks file fills series, shows, artists and tracks', () => {
  const db = freshDb();
  const r = load(db, 'testshow_tracks.csv');

  assert.equal(r.ok, true);
  assert.equal(r.kind, 'tracks');
  assert.equal(r.series_slug, 'testshow');
  assert.equal(r.rows_read, 4);
  assert.equal(r.shows_upserted, 2);
  assert.equal(r.tracks_inserted, 4);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM series').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shows').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, 4);
  db.close();
});

test('artists are deduplicated on the normalised name', () => {
  const db = freshDb();
  load(db, 'testshow_tracks.csv');

  // "Mägi" and "MÄGI" fold together; the blank artist creates no row.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM artists').get().n, 2);

  const magi = db.prepare('SELECT name FROM artists WHERE name_norm = ?').get('mägi');
  assert.equal(magi.name, 'Mägi', 'keeps the first spelling seen');
  db.close();
});

test('a blank artist becomes a NULL artist_id, not a dropped row', () => {
  const db = freshDb();
  load(db, 'testshow_tracks.csv');
  const row = db.prepare('SELECT artist_id FROM tracks WHERE title = ?').get('Nimeta lugu');
  assert.equal(row.artist_id, null);
  db.close();
});

test('tracks get a normalised title and 1-based positions', () => {
  const db = freshDb();
  load(db, 'testshow_tracks.csv');
  const rows = db.prepare(`
    SELECT t.position, t.title, t.title_norm
    FROM tracks t JOIN shows s ON s.id = t.show_id
    WHERE s.content_id = 1610000001 ORDER BY t.position`).all();

  assert.deepEqual(rows.map(r => r.position), [1, 2, 3]);
  assert.equal(rows[0].title, 'Õhtu jõuab');
  assert.equal(rows[0].title_norm, 'õhtu jõuab');
  db.close();
});

test('dates are stored as YYYY-MM-DD text', () => {
  const db = freshDb();
  load(db, 'testshow_tracks.csv');
  const show = db.prepare('SELECT show_date FROM shows WHERE content_id = 1610000001').get();
  assert.equal(show.show_date, '2024-02-01');
  db.close();
});

test('a shows file adds episodes that have no tracklist', () => {
  const db = freshDb();
  load(db, 'testshow_tracks.csv');
  load(db, 'testshow_shows.csv');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shows').get().n, 3);
  const gap = db.prepare('SELECT track_count FROM shows WHERE content_id = 1610000003').get();
  assert.equal(gap.track_count, 0);
  db.close();
});

test('re-importing the same file is idempotent', () => {
  const db = freshDb();
  load(db, 'testshow_tracks.csv');
  load(db, 'testshow_tracks.csv');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shows').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM artists').get().n, 2);
  db.close();
});

test('an unrecognised file is reported, not thrown', () => {
  const db = freshDb();
  const r = importCsv({
    db,
    filename: 'mystery.csv',
    buffer: Buffer.from('foo,bar\n1,2\n', 'utf8'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'unknown');
  assert.match(r.message, /Unrecognised columns/);
  db.close();
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `importCsv` still returns a Promise and talks to `pool`, so the assertions on `r.ok` fail.

- [ ] **Step 4: Rewrite the module header**

In `server/src/importer.js`, replace the two import lines at the top:

```js
import { parse } from 'csv-parse/sync';
import { norm } from './normalize.js';
```

Then delete the local definition at line 34:

```js
const norm = s => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
```

Leave `parseEstDate`, `contentIdFromUrl`, `parseFilename`, `prettify` and `detectKind` untouched.

- [ ] **Step 5: Rewrite the lookup helpers**

Replace `upsertSeries`, `resolveArtists` and `upsertShow` with:

```js
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
```

- [ ] **Step 6: Rewrite `importCsv` and delete `logImport`**

Replace everything from `export async function importCsv` to the end of the file:

```js
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
```

Note: the BOM strip is written as `﻿` rather than the raw character the old code used, so the intent survives any editor that normalises the file.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 8 new importer tests, plus Tasks 1–3 still green.

`routes.js` still imports `importCsv` and will now be calling a sync function with the wrong arguments. That is expected and is fixed in Task 6; the server is knowingly broken between here and there.

- [ ] **Step 8: Commit**

```bash
git add server/src/importer.js server/test/importer.test.js server/test/fixtures
git commit -m "Port importer to better-sqlite3"
```

---

### Task 5: `buildDatabase()` and the `build:db` CLI

Wraps Task 4's importer in a directory walk with the validation that stops an empty database from ever shipping.

**Files:**
- Modify: `server/src/build-db.js`
- Modify: `server/test/build-db.test.js` (add cases)
- Modify: `package.json` (add `build:db` script)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `createDatabase(file)`, `importCsv({ db, filename, buffer })`
- Produces:
  - `buildDatabase({ csvDir?, outPath? }) => { counts, results }` where `counts` is `{ series, shows, tracks, artists }` (all numbers) and `results` is the array of per-file `importCsv` results. Throws on any failure.

- [ ] **Step 1: Write the failing tests**

First extend the **existing import block** at the top of `server/test/build-db.test.js` — Task 3's version has no `fileURLToPath` import and imports only `createDatabase`:

```js
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createDatabase, buildDatabase } from '../src/build-db.js';
```

(Replace the existing `import { createDatabase }` line rather than adding a second one.)

Then append to the same file:

```js
const FIXTURE_CSV = path.join(
  path.dirname(fileURLToPath(import.meta.url)), 'fixtures/csv'
);

test('buildDatabase imports every csv and reports counts', () => {
  const out = tmpFile();
  const { counts } = buildDatabase({ csvDir: FIXTURE_CSV, outPath: out });

  assert.deepEqual(counts, { series: 1, shows: 3, tracks: 4, artists: 2 });
  assert.ok(fs.existsSync(out), 'writes the database to outPath');
  assert.ok(!fs.existsSync(`${out}.building`), 'cleans up the temporary file');
});

test('buildDatabase produces a readable database', () => {
  const out = tmpFile();
  buildDatabase({ csvDir: FIXTURE_CSV, outPath: out });

  const db = new Database(out, { readonly: true, fileMustExist: true });
  const titles = db.prepare(`SELECT title FROM tracks ORDER BY id`).all().map(r => r.title);
  assert.ok(titles.includes('Õhtu jõuab'));
  db.close();
});

test('buildDatabase is deterministic', () => {
  // Logical equivalence, not byte equality. created_at/updated_at embed the
  // build time via datetime('now'), which has SECOND granularity: two builds
  // inside the same second come out byte-identical, two builds straddling a
  // second boundary do not. Both were measured.
  // Do NOT "strengthen" this into a file-hash comparison. It would pass
  // almost every run and fail unpredictably on the rare boundary crossing -
  // the worst kind of flake, and the reason this asserts counts instead.
  const a = tmpFile();
  const b = tmpFile();
  const first = buildDatabase({ csvDir: FIXTURE_CSV, outPath: a });
  const second = buildDatabase({ csvDir: FIXTURE_CSV, outPath: b });
  assert.deepEqual(first.counts, second.counts);
});

test('buildDatabase refuses a missing csv directory', () => {
  assert.throws(
    () => buildDatabase({ csvDir: '/nonexistent/csv', outPath: tmpFile() }),
    /CSV directory not found/
  );
});

test('buildDatabase refuses an empty csv directory', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-empty-'));
  assert.throws(
    () => buildDatabase({ csvDir: empty, outPath: tmpFile() }),
    /No CSV files/
  );
});

test('buildDatabase refuses a file it cannot recognise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-bad-'));
  fs.copyFileSync(path.join(FIXTURE_CSV, 'testshow_tracks.csv'),
    path.join(dir, 'testshow_tracks.csv'));
  fs.writeFileSync(path.join(dir, 'mystery.csv'), 'foo,bar\n1,2\n');

  const out = tmpFile();
  assert.throws(
    () => buildDatabase({ csvDir: dir, outPath: out }),
    /Unrecognised columns/
  );
  assert.ok(!fs.existsSync(out), 'leaves no database behind on failure');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `buildDatabase is not a function`

- [ ] **Step 3: Implement `buildDatabase` and the CLI**

Append to `server/src/build-db.js` (and add `pathToFileURL` to the `node:url` import):

```js
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
 * Build a complete database from `csvDir` and move it into place at `outPath`.
 * Builds to a temporary file and renames only on success, so a failed build
 * never leaves a half-populated database behind.
 */
export function buildDatabase({ csvDir = DEFAULT_CSV_DIR, outPath = DEFAULT_OUT } = {}) {
  const files = readCsvDir(csvDir);
  const tmp = `${outPath}.building`;
  const db = createDatabase(tmp);
  const results = [];

  try {
    for (const name of files) {
      const result = importCsv({
        db,
        filename: name,
        buffer: fs.readFileSync(path.join(csvDir, name)),
      });
      if (!result.ok) throw new Error(`${name}: ${result.message}`);
      results.push(result);
    }

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
    db.close();
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/* --------------------------------- cli ------------------------------------ */

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { counts, results } = buildDatabase();
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
```

Add the `importCsv` import to the top of the file:

```js
import { importCsv } from './importer.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 6 new tests, everything from Tasks 1–4 still green.

- [ ] **Step 5: Add the script and ignore the artifact**

In the root `package.json` scripts:

```json
"build:db": "node server/src/build-db.js"
```

Append to `.gitignore`:

```
data/*.sqlite
data/*.sqlite.building
```

- [ ] **Step 6: Commit**

```bash
git add server/src/build-db.js server/test/build-db.test.js package.json .gitignore
git commit -m "Add buildDatabase and the build:db CLI"
```

---

### Task 6: Rewrite `db.js` and port `routes.js`

`routes.js` cannot compile without `db.js` changing, so they move together. This is the task that makes the server run again.

**Files:**
- Modify: `server/src/db.js` (full rewrite)
- Modify: `server/src/routes.js`
- Modify: `server/src/index.js`
- Create: `server/test/routes.test.js`
- Modify: `server/package.json` (drop `mysql2` and `multer`)

**Interfaces:**
- Consumes: `buildDatabase()` (tests only), `norm`, `likeEscape`
- Produces:
  - `openDb(file?: string) => Database` — opens read-only, caches the handle, throws if the file is missing
  - `db() => Database` — returns the cached handle; throws if `openDb()` has not run
  - `DB_PATH: string` — `process.env.DB_PATH` or `data/tracklists.sqlite`

- [ ] **Step 1: Write the failing tests**

Create `server/test/routes.test.js`:

```js
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { buildDatabase } from '../src/build-db.js';
import { openDb } from '../src/db.js';
import routes from '../src/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CSV = path.join(__dirname, 'fixtures/csv');

let server;
let base;

before(async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-routes-')), 'test.sqlite');
  buildDatabase({ csvDir: FIXTURE_CSV, outPath: out });
  openDb(out);

  const app = express();
  app.use('/api', routes);
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

const get = async p => {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: await res.json() };
};

test('GET /api/stats returns row counts', async () => {
  const { body } = await get('/api/stats');
  assert.deepEqual(body, { series: 1, shows: 3, tracks: 4, artists: 2 });
});

test('GET /api/series aggregates shows and dates', async () => {
  const { body } = await get('/api/series');
  assert.equal(body.length, 1);
  assert.equal(body[0].slug, 'testshow');
  assert.equal(body[0].show_count, 3);
  assert.equal(body[0].track_count, 4);
  assert.equal(body[0].first_show, '2024-02-01');
  assert.equal(body[0].last_show, '2024-04-20');
});

test('GET /api/series/:slug/shows paginates newest first', async () => {
  const { body } = await get('/api/series/testshow/shows?page=1&pageSize=2');
  assert.equal(body.total, 3);
  assert.equal(body.rows.length, 2);
  assert.equal(body.rows[0].content_id, 1610000003, 'newest show first');
});

test('GET /api/shows/:id returns tracks in play order', async () => {
  const { body: list } = await get('/api/series/testshow/shows');
  const first = list.rows.find(r => r.content_id === 1610000001);

  const { body } = await get(`/api/shows/${first.id}`);
  assert.equal(body.show.series_slug, 'testshow');
  assert.deepEqual(body.tracks.map(t => t.position), [1, 2, 3]);
  assert.equal(body.tracks[0].artist, 'Mägi');
  assert.equal(body.tracks[2].artist, null, 'blank artist stays null');
});

test('GET /api/shows/:id 404s for an unknown id', async () => {
  const { status } = await get('/api/shows/999999');
  assert.equal(status, 404);
});

test('GET /api/tracks folds case across Estonian letters', async () => {
  const { body } = await get('/api/tracks?q=õhtu');
  assert.equal(body.total, 1);
  assert.equal(body.rows[0].title, 'Õhtu jõuab');

  const upper = await get('/api/tracks?q=ÕHTU');
  assert.equal(upper.body.total, 1, 'uppercase needle matches too');
});

test('GET /api/tracks keeps diacritics distinct', async () => {
  const { body } = await get('/api/tracks?q=magi');
  assert.equal(body.total, 0, '"magi" must not match "Mägi"');
});

test('GET /api/tracks matches on artist name too', async () => {
  const { body } = await get('/api/tracks?q=ansambel');
  assert.equal(body.total, 1);
  assert.equal(body.rows[0].title, 'Sada protsenti');
});

test('GET /api/tracks treats % as a literal, not a wildcard', async () => {
  const { body } = await get('/api/tracks?q=%25');   // %25 is an encoded "%"
  assert.equal(body.total, 1, 'matches only the artist literally containing "%"');
  assert.equal(body.rows[0].title, 'Sada protsenti');
});

test('GET /api/tracks filters by date range', async () => {
  const { body } = await get('/api/tracks?from=2024-03-01');
  assert.equal(body.total, 1);
  assert.equal(body.rows[0].title, 'Sada protsenti');
});

test('GET /api/tracks paginates', async () => {
  const { body } = await get('/api/tracks?page=1&pageSize=2');
  assert.equal(body.total, 4);
  assert.equal(body.rows.length, 2);

  const p2 = await get('/api/tracks?page=2&pageSize=2');
  assert.equal(p2.body.rows.length, 2);
  assert.notDeepEqual(p2.body.rows[0].id, body.rows[0].id);
});

test('GET /api/artists ranks by play count', async () => {
  const { body } = await get('/api/artists');
  assert.equal(body.rows[0].name, 'Mägi');
  assert.equal(body.rows[0].plays, 2);
  assert.equal(body.rows[1].plays, 1);
});

test('GET /api/artists filters on the normalised name', async () => {
  const { body } = await get('/api/artists?q=MÄGI');
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].name, 'Mägi');
});

test('GET /api/artists/:id lists every play', async () => {
  const { body: list } = await get('/api/artists');
  const { body } = await get(`/api/artists/${list.rows[0].id}`);
  assert.equal(body.artist.name, 'Mägi');
  assert.equal(body.tracks.length, 2);
});

test('the import endpoints are gone', async () => {
  assert.equal((await get('/api/imports')).status, 404);

  const res = await fetch(`${base}/api/import`, { method: 'POST' });
  assert.equal(res.status, 404);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `openDb is not exported from '../src/db.js'`

- [ ] **Step 3: Rewrite `db.js`**

Replace the entire contents of `server/src/db.js`:

```js
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The baked database. Built at image build time by build-db.js. */
export const DB_PATH =
  process.env.DB_PATH || path.resolve(__dirname, '../../data/tracklists.sqlite');

let handle = null;

/**
 * Open the database read-only. Throws if the file is missing, which is what we
 * want: a container with no data should fail at boot rather than serve an
 * empty archive.
 */
export function openDb(file = DB_PATH) {
  handle = new Database(file, { readonly: true, fileMustExist: true });
  return handle;
}

/** The open handle. Throws if openDb() has not been called yet. */
export function db() {
  if (!handle) throw new Error('database not opened; call openDb() first');
  return handle;
}
```

`waitForDb()` and `migrate()` are deleted outright — there is no server to wait for and the schema is already baked into the file.

- [ ] **Step 4: Port `routes.js`**

Replace the entire contents of `server/src/routes.js`:

```js
import express from 'express';
import { db } from './db.js';
import { norm, likeEscape } from './normalize.js';

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
      ORDER BY s.name`).all());
  } catch (e) { next(e); }
});

router.get('/series/:slug/shows', (req, res, next) => {
  try {
    const p = page(req.query), ps = size(req.query);
    const rows = db().prepare(`
      SELECT sh.id, sh.content_id, sh.title, sh.show_date, sh.url, sh.track_count
      FROM shows sh
      JOIN series s ON s.id = sh.series_id
      WHERE s.slug = ?
      ORDER BY sh.show_date DESC, sh.id DESC
      LIMIT ? OFFSET ?`).all(req.params.slug, ps, (p - 1) * ps);
    const { total } = db().prepare(
      `SELECT COUNT(*) AS total FROM shows sh JOIN series s ON s.id = sh.series_id WHERE s.slug = ?`
    ).get(req.params.slug);
    res.json({ rows, total, page: p, pageSize: ps });
  } catch (e) { next(e); }
});

/* ---------------------------------- shows --------------------------------- */

router.get('/shows/:id', (req, res, next) => {
  try {
    const show = db().prepare(`
      SELECT sh.*, s.name AS series_name, s.slug AS series_slug
      FROM shows sh JOIN series s ON s.id = sh.series_id
      WHERE sh.id = ?`).get(req.params.id);
    if (!show) return res.status(404).json({ error: 'not found' });
    const tracks = db().prepare(`
      SELECT t.id, t.position, t.title, a.id AS artist_id, a.name AS artist
      FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id
      WHERE t.show_id = ? ORDER BY t.position`).all(req.params.id);
    res.json({ show, tracks });
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
      ORDER BY plays DESC, a.name
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

export default router;
```

`POST /api/import`, `GET /api/imports`, the `multer` import and the `maxMb`/`upload` constants are all gone.

The `/artists` `total` still counts every matching artist while `rows` only returns artists with plays. That mismatch is pre-existing — see "Out of scope" at the top. Do not change it.

- [ ] **Step 5: Update `index.js`**

In `server/src/index.js`, replace the `db.js` import:

```js
import { openDb, db, DB_PATH } from './db.js';
```

Replace the `/healthz` handler:

```js
app.get('/healthz', (_req, res) => {
  try {
    const { n } = db().prepare('SELECT COUNT(*) AS n FROM tracks').get();
    if (n === 0) return res.status(503).json({ ok: false, error: 'database is empty' });
    res.json({ ok: true, tracks: n });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});
```

**Coverage note:** `/healthz` lives in `index.js`, which opens the database and
calls `listen()` at module load, so the route tests (which mount `routes.js`
alone) do not reach it. Its happy path is gated by the container check in Task 8
Step 6. The 503-when-empty branch is not automatically tested — making it so
would mean extracting an app factory, which is scope this migration does not
need. Leave it; do not restructure `index.js` to chase the coverage.

Simplify the error middleware — `LIMIT_FILE_SIZE` was multer-specific and multer is gone:

```js
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});
```

Replace the boot sequence at the bottom:

```js
const port = Number(process.env.PORT || 3000);

try {
  openDb();
  console.log(`opened ${DB_PATH}`);
} catch (err) {
  console.error(`cannot open database at ${DB_PATH}: ${err.message}`);
  console.error('run `npm run build:db` first');
  process.exit(1);
}

app.listen(port, () => console.log(`api + ui listening on :${port}`));
```

- [ ] **Step 6: Drop the dead dependencies**

```bash
npm uninstall --workspace server mysql2 multer
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 15 new route tests, everything from Tasks 1–5 still green.

- [ ] **Step 8: Commit**

```bash
git add server/src/db.js server/src/routes.js server/src/index.js server/test/routes.test.js server/package.json package-lock.json
git commit -m "Open SQLite read-only and port routes off mysql2"
```

---

### Task 7: Remove the Import page from the client

**Files:**
- Delete: `client/src/pages/Import.jsx`
- Modify: `client/src/App.jsx`
- Modify: `client/src/api.js`

**Interfaces:**
- Consumes: nothing
- Produces: nothing

- [ ] **Step 1: Delete the page**

```bash
git rm client/src/pages/Import.jsx
```

- [ ] **Step 2: Remove the route and nav entry**

In `client/src/App.jsx`, delete the import line:

```js
import Import from './pages/Import.jsx';
```

delete the nav link:

```jsx
<NavLink to="/import">Import</NavLink>
```

and delete the route:

```jsx
<Route path="/import" element={<Import />} />
```

- [ ] **Step 3: Remove the API helpers**

In `client/src/api.js`, delete the `imports` and `upload` entries from the `api` object, leaving:

```js
export const api = {
  stats:      ()             => get('/stats'),
  series:     ()             => get('/series'),
  shows:      (slug, p)      => get(`/series/${slug}/shows`, p),
  show:       (id)           => get(`/shows/${id}`),
  tracks:     (p)            => get('/tracks', p),
  artists:    (p)            => get('/artists', p),
  artist:     (id)           => get(`/artists/${id}`),
};
```

Leave `get`, `fmtDate` and `fmtNum` exactly as they are. `fmtDate` already slices the first ten characters, so a plain `YYYY-MM-DD` string renders identically to the old ISO timestamp — no change needed.

- [ ] **Step 4: Verify the bundle builds**

Run: `npm run build`
Expected: Vite build succeeds with no unresolved-import errors.

- [ ] **Step 5: Verify nothing still references the page**

Run: `grep -rn "Import\|/import\|upload" client/src`
Expected: no matches other than ordinary `import` statements at the top of files.

- [ ] **Step 6: Commit**

```bash
git add client/src/App.jsx client/src/api.js
git commit -m "Remove the Import page"
```

---

### Task 8: Docker and compose

**Requires the real CSVs to be present in `data/csv/`.** See Prerequisites.

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `.dockerignore`

**Interfaces:**
- Consumes: `npm run build:db`
- Produces: an image that contains `data/tracklists.sqlite` and no database client

- [ ] **Step 1: Add the build deps and the db-build stage**

In `Dockerfile`, add the native toolchain to the `server-deps` stage (`better-sqlite3` compiles from source on Alpine) and add a stage that extends it:

```dockerfile
# ---- stage 2: production dependencies for the server -------------------------
FROM node:22-alpine AS server-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json ./
COPY server/package.json ./server/
RUN npm install --workspace server --include-workspace-root --omit=dev --no-audit --no-fund

# ---- stage 2b: bake the SQLite database from the committed CSVs --------------
FROM server-deps AS db-build
COPY server/src ./server/src
COPY data/csv ./data/csv
RUN node server/src/build-db.js
```

The toolchain stays in the build stages and never reaches the runtime image.

- [ ] **Step 2: Copy the database into the runtime stage**

In the `runtime` stage, after the `client/dist` copy, add:

```dockerfile
COPY --from=db-build /app/data/tracklists.sqlite ./data/tracklists.sqlite
```

- [ ] **Step 3: Reduce compose to one service**

Replace the entire contents of `docker-compose.yml`:

```yaml
services:
  app:
    build: .
    restart: unless-stopped
    environment:
      PORT: 3000
    ports:
      - "${APP_PORT:-3000}:3000"
```

The `db` service, the `dbdata` volume, the `depends_on` healthcheck gate and every `DB_*` variable are gone.

- [ ] **Step 4: Trim the example environment file**

Replace the entire contents of `.env.example` with:

```
# Host port for the app (container always listens on 3000).
APP_PORT=3000
```

Every other variable it previously held referred to the database or to upload limits, both of which no longer exist.

- [ ] **Step 5: Keep the generated database out of the build context**

Check `.dockerignore`. It must not exclude `data/csv`, and it should exclude the locally built artifact so a stale one is never copied in. Add if missing:

```
data/*.sqlite
data/*.sqlite.building
```

- [ ] **Step 6: Build and verify**

```bash
npm run build:db
docker compose build
docker compose up -d
sleep 5
curl -s localhost:3000/healthz
curl -s localhost:3000/api/stats
```

Expected: `/healthz` returns `{"ok":true,"tracks":<n>}` with n > 0, and `/api/stats` returns the same four counts that `npm run build:db` printed.

- [ ] **Step 7: Confirm the image has no database server**

```bash
docker compose exec app ls -la /app/data
docker compose exec app sh -c 'ls /app/node_modules | grep -c mysql2 || echo "mysql2 absent"'
```

Expected: `tracklists.sqlite` is present, and `mysql2` is absent.

- [ ] **Step 8: Commit**

```bash
git add Dockerfile docker-compose.yml .env.example .dockerignore
git commit -m "Bake the database into the image and drop the db service"
```

---

### Task 9: Rewrite the README

**Files:**
- Modify: `README.md`

Note: `README.md` currently has uncommitted changes — a pasted note about CI/CD to GCP. **Preserve that note**; the user put it there deliberately. Rewrite the surrounding documentation around it.

- [ ] **Step 1: Update the stack summary**

Replace the `**DB**` and `**Import**` bullets at the top:

```markdown
* **API** — Express (Node 22, ES modules)
* **UI** — React 18 + Vite, React Router
* **Data** — SQLite, built from the CSVs in `data/csv/` at image build time
* **Import** — `npm run build:db`; re-scraping means committing new CSVs
```

- [ ] **Step 2: Rewrite the quick start**

```markdown
## Quick start (Docker)

```bash
docker compose up -d --build
open http://localhost:3000
```

One container. The database is built from `data/csv/` during the image build
and shipped inside the image, so there is nothing to wait for and no volume to
manage.

```bash
docker compose logs -f app    # follow the API log
docker compose down           # stop
```
```

- [ ] **Step 3: Rewrite the local-development section**

```markdown
## Running locally without Docker

Needs Node 22+. No database server.

```bash
npm install
npm run build:db              # data/csv/*.csv -> data/tracklists.sqlite
npm run dev                   # API on :3000, Vite dev server on :5173
```

Vite proxies `/api` to `:3000`, so use **http://localhost:5173** in dev.
```

- [ ] **Step 4: Update the scripts table**

Add `npm run build:db` ("Build `data/tracklists.sqlite` from the CSVs in `data/csv/`") and `npm test` ("Run the test suite"). Remove `npm run docker:*` entries only if they no longer work — they still do, so leave them.

- [ ] **Step 5: Rewrite the importing section**

Replace the whole "How importing works" section with:

```markdown
## How importing works

The CSVs live in `data/csv/` and are committed. `npm run build:db` reads them
all and writes `data/tracklists.sqlite`; the Docker build runs the same command,
so the image always ships a database built from exactly the CSVs in the commit
it was built from.

The importer figures out what a file is from its **header row**, and which
series it belongs to from its **filename**:

    eesti_pops_tracks.csv  ->  series slug "eesti_pops", kind "tracks"
    fantaasia_shows.csv    ->  series slug "fantaasia",  kind "shows"

`*_tracks.csv` files are processed before `*_shows.csv` files, because the shows
files add the episodes that have no tracklist — the ones that keep the archive
gaps visible.

For `_shows.csv` files there is no `content_id` column, so it is parsed out of
the show URL (`https://r2.err.ee/1610128043/...` → `1610128043`).

**Re-running the build is safe.** Shows are matched on `content_id` — ERR's own
episode id, which is stable and unique — and a show's tracks are deleted and
re-inserted rather than appended. Re-scrape, replace the CSVs, rebuild, and the
numbers stay correct.

The build refuses to produce a database it cannot vouch for: a missing
`data/csv/`, no CSV files, a file whose columns it does not recognise, or a
final track count of zero all fail the build rather than shipping an empty
archive.
```

- [ ] **Step 6: Update the schema section**

Replace the schema section's table list and diagram with:

```markdown
## Schema

Four tables, in `server/src/schema.sql`. It is applied once, when the database
is built — the running server opens the file read-only and never writes to it.

```
series ──< shows ──< tracks >── artists
```

* `series` — one row per radio show (slug, display name)
* `shows` — one row per episode; `content_id` is the natural key, `track_count`
  is kept from the scrape so episodes with **no** tracklist are still visible
* `artists` — deduplicated; `name` is what ERR printed, `name_norm` is the
  lowercased/whitespace-collapsed form used for matching
* `tracks` — `position` preserves the play order within an episode; `artist_id`
  is `NULL` where ERR left the artist blank; `title_norm` mirrors `name_norm`

**About the `_norm` columns.** SQLite's `LIKE` only folds case for ASCII, so
searching would otherwise miss `Õhtu` when you typed `õhtu`. Both search routes
match against the precomputed `_norm` columns instead. Diacritics are preserved
on purpose — `õ`, `ä`, `ö` and `ü` are distinct Estonian letters, so `magi` does
not match `Mägi`.

To change the schema: edit `schema.sql`, then re-run `npm run build:db`.
```

- [ ] **Step 7: Update the API table**

Remove the `POST /api/import` and `GET /api/imports` rows. Update the `/healthz` note to "container healthcheck; 503 when the database is empty".

- [ ] **Step 8: Verify no stale references remain**

Run: `grep -rn "MariaDB\|mysql\|MYSQL\|DB_HOST\|DB_PASSWORD\|dbdata\|3307\|imports table" README.md`
Expected: no matches, except inside the preserved CI/CD note if it mentions them.

- [ ] **Step 9: Commit**

```bash
git add README.md
git commit -m "Update README for build-time SQLite storage"
```

---

### Task 10: Rollout verification

The spec's acceptance check. Nothing is deleted until this passes.

**Files:** none — verification only

- [ ] **Step 1: Confirm the full suite is green**

Run: `npm test`
Expected: PASS, all tasks' tests.

- [ ] **Step 2: Compare row counts against the old database**

Start the old MariaDB container, read its counts, and compare against `/api/stats` from the new build:

```bash
docker start tracklist-browser-db-1
sleep 10
docker exec tracklist-browser-db-1 mariadb -utracklists -ptracklists tracklists \
  -e "SELECT (SELECT COUNT(*) FROM series) AS series, (SELECT COUNT(*) FROM shows) AS shows, (SELECT COUNT(*) FROM tracks) AS tracks, (SELECT COUNT(*) FROM artists) AS artists"
```

Expected: identical to the new `/api/stats`. **If they differ, stop and report** — it means `data/csv/` is not a complete record of what was imported, and the CSVs must be completed before the old volume is dropped.

- [ ] **Step 3: Spot-check Unicode search against both**

Search for a term containing `Õ` or `Ä` in the running app. Confirm the same tracks come back as the old stack returned.

- [ ] **Step 4: Check rendered dates**

Open a series page and compare a few dates against the old UI. They may shift by one day: `mysql2` returned a local-midnight `Date` that serialised to the previous day in UTC. **If that shift appears, the new value is the correct one** — this design incidentally fixes a latent off-by-one.

- [ ] **Step 5: Report before deleting anything**

Summarise: the four row counts from both stacks, the Unicode spot-check result, and whether dates shifted. The old volume is dropped only after the user confirms.

Do **not** run `docker compose down -v` or delete `tracklist-browser-db-1` as part of this plan.

---

## Verification summary

| Task | Gate |
| --- | --- |
| 1 | `npm test` — 6 normalize tests |
| 2 | `npm test` — 7 helper tests, no production changes |
| 3 | `npm test` — 4 schema tests |
| 4 | `npm test` — 8 importer tests |
| 5 | `npm test` — 6 build tests |
| 6 | `npm test` — 15 route tests |
| 7 | `npm run build` succeeds; no dangling references |
| 8 | `/healthz` and `/api/stats` respond correctly from the container |
| 9 | No stale MariaDB references in the README |
| 10 | Row counts match the old database |
