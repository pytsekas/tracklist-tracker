# Replace MariaDB with a build-time SQLite file

Date: 2026-09-18
Status: approved design, pending implementation plan

## Problem

The app runs a MariaDB 11 container to serve a read-mostly archive browser.
The database itself is not the burden — the operations around it are: a second
container, a `dbdata` volume, five DB environment variables, a compose
healthcheck, and a boot-time retry loop (`server/src/db.js:22`). That weight is
about to be paid a second time, in money and in Terraform, when the app is
deployed to GCP.

The data is small, changes only when the ERR archive is re-scraped, and is
already produced as CSV files. Nothing about it requires a database *server*.

## Decision

Replace MariaDB with a SQLite file that is **built at image build time and
shipped inside the image, read-only**.

SQL is kept. The motivation is operational weight, not SQL, so the query shapes
in `server/src/routes.js` survive the change — only the dialect and the
call style change.

Consequences:

- The running container has no write path and no storage dependency. On Cloud
  Run it scales to zero with no attached volume, no VPC connector, and no
  database instance.
- Importing moves from a UI upload to `npm run build:db`. Re-scraping becomes a
  git commit and a redeploy.
- Local development no longer needs Docker at all.

### Rejected alternatives

**CSV as the runtime store.** Reads would be fine, but `importer.js` currently
relies on transactions, foreign keys and unique constraints for its
delete-and-reinsert-per-show logic. Reproducing that over flat files means
hand-rolling atomicity. It also does not survive Cloud Run's ephemeral
filesystem, so it would relocate the persistence problem rather than remove it.

**CSVs parsed into memory at boot, no database.** Viable, and it would have been
the right answer if SQL were the problem. It is not: this would trade ~20 lines
of dialect changes for ~200 lines of hand-written aggregation and pagination
logic, most of it re-implementing `/api/artists` and `/api/tracks`.

**`node:sqlite` instead of `better-sqlite3`.** Attractive (no dependency, no
native build) but newer and possibly flag-gated on Node 22. Revisit later; it is
a drop-in shape change, not an architectural one.

**FTS5 for search.** Faster and supports ranking, but changes matching from
substring to token-prefix — a user-visible behaviour change that should not ride
along with an unrelated storage migration. Good follow-up.

## Non-goals

- The GCP / Terraform deployment. This design is what makes it simple; it is a
  separate piece of work.
- FTS5 or any search-quality improvement beyond restoring current behaviour.
- The artist punctuation-deduplication pass noted in `README.md`.
- Folding the scraper into this repository.

## Architecture

### Layout

```
data/
  csv/                       committed scraped CSVs
    eesti_pops_tracks.csv
    eesti_pops_shows.csv
    ...
  tracklists.sqlite          generated artifact, gitignored

server/src/
  build-db.js    (new)       CLI: data/csv/*.csv -> data/tracklists.sqlite
  normalize.js   (new)       shared search normalisation
  db.js          (rewritten) opens the .sqlite read-only
  schema.sql     (ported)    SQLite dialect
  importer.js    (kept)      parsing unchanged; writes go through better-sqlite3
  routes.js      (edited)    dialect + sync call port
```

### Build-time flow

`npm run build:db`:

1. Create a fresh database at a temporary path and apply `schema.sql`.
2. Read `data/csv/`, calling the existing `importCsv()` from `importer.js` for
   every `*_tracks.csv` first, then every `*_shows.csv` — the order `README.md`
   already documents, because the shows files add episodes that have no
   tracklist.
3. Report row counts.
4. Rename the temporary file to `data/tracklists.sqlite` and exit 0.

Building through `importCsv()` rather than a parallel code path means the
importer's parsing, artist deduplication and re-import safety are reused
unchanged; only its write calls move from `mysql2` to `better-sqlite3`.

Deterministic and repeatable: deleting the file and re-running produces the same
database.

The Dockerfile gains a `db-build` stage that runs this. Build dependencies for
`better-sqlite3` (`python3`, `make`, `g++`) stay in that stage and never reach
the runtime image. The runtime stage copies the finished `.sqlite` in alongside
`client/dist`.

### Runtime flow

`db.js` opens the file with `{ readonly: true, fileMustExist: true }` and
exports the handle. Routes prepare their own statements — `/api/tracks` and
`/api/artists` assemble their `WHERE` clause at request time, so not every
statement can be precompiled at module load; `better-sqlite3` caches prepared
statements internally, so this costs nothing. `waitForDb()` and the boot-time
`migrate()`
(`server/src/db.js:22`, `:38`) are deleted — there is nothing to wait for and
the schema is already in the file.

`/healthz` runs `SELECT COUNT(*) FROM tracks` and returns 503 when it is zero,
so a build that produced an empty database never takes traffic.

### Dev flow

```bash
npm run build:db    # once, after changing CSVs
npm run dev         # unchanged
```

## Schema

`server/src/schema.sql` becomes:

```sql
PRAGMA foreign_keys = ON;

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
  content_id  INTEGER NOT NULL UNIQUE,
  series_id   INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  show_date   TEXT,                       -- YYYY-MM-DD
  url         TEXT,
  track_count INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shows_date        ON shows(show_date);
CREATE INDEX IF NOT EXISTS idx_shows_series_date ON shows(series_id, show_date);

CREATE TABLE IF NOT EXISTS artists (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  name_norm TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS tracks (
  id         INTEGER PRIMARY KEY,
  show_id    INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  artist_id  INTEGER REFERENCES artists(id) ON DELETE SET NULL,
  title      TEXT NOT NULL,
  title_norm TEXT NOT NULL,
  position   INTEGER NOT NULL,
  UNIQUE (show_id, position)
);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id);
```

Notes on the port:

- `INT AUTO_INCREMENT PRIMARY KEY` becomes `INTEGER PRIMARY KEY` (a rowid alias,
  which auto-assigns). `AUTOINCREMENT` is deliberately not used — it adds
  bookkeeping for a guarantee this app does not need.
- `BIGINT content_id` becomes `INTEGER`; SQLite integers are 64-bit.
- `show_date` becomes `TEXT` in `YYYY-MM-DD`. The date filters at
  `server/src/routes.js:92` compare lexicographically, which is correct for that
  format, and `parseEstDate()` already produces it.
- `INDEX idx_tracks_title (title(64))` is dropped rather than ported. A prefix
  index cannot serve a `LIKE '%...%'` query, so MariaDB was not using it for
  search either.
- `INDEX idx_artists_name (name(64))` is dropped for the same reason; search
  moves to `name_norm`.
- No separate index is created for `artists.name_norm`, `shows.content_id`, or
  `tracks(show_id, position)` — the `UNIQUE` constraints already create one.
  `tracks(show_id, position)` in particular serves the
  `WHERE show_id = ? ORDER BY position` query in `/api/shows/:id`.
- `ON UPDATE CURRENT_TIMESTAMP` has no SQLite equivalent. Since writes now only
  happen at build time, `build-db.js` sets `updated_at` explicitly.
- The `imports` table is removed along with the import UI.

## Search and normalisation

### The regression being fixed

MariaDB's `utf8mb4_unicode_ci` collation makes `LIKE` case-insensitive across
all of Unicode. **SQLite's `LIKE` folds ASCII only.** Ported naively, `õhtu`
would stop matching `Õhtu` and `mägi` would stop matching `Mägi` — unacceptable
for an Estonian archive.

### The fix

Precomputed normalised columns, extending the pattern `artists.name_norm`
already uses. `server/src/normalize.js` exports the single function both the
build and the routes use:

```js
export const norm = s => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
```

JavaScript's `toLowerCase()` is fully Unicode-aware, so `Õ` folds to `õ`
correctly. This function currently lives unexported inside `importer.js:34`;
it moves to its own module so `routes.js` can use it without importing from a
build-only module.

`build-db.js` computes `tracks.title_norm` and `artists.name_norm` on insert.
The routes normalise the incoming query and match against those columns:

- `/api/tracks` (`routes.js:85`): `(t.title LIKE ? OR a.name LIKE ?)` becomes
  `(t.title_norm LIKE ? OR a.name_norm LIKE ?)`.
- `/api/artists` (`routes.js:126`): `a.name LIKE ?` becomes
  `a.name_norm LIKE ?`.

Both bind `%${norm(req.query.q)}%`.

### Diacritics

Diacritics are **preserved, not stripped**. `õ`, `ä`, `ö` and `ü` are distinct
letters in Estonian rather than accented variants, so `magi` correctly does not
match `Mägi`. This matches today's MariaDB behaviour exactly, keeping the change
a pure regression fix with no user-visible difference.

### Performance

`LIKE '%...%'` cannot use an index in either engine, so search is a full scan
today and remains one. At this data size that is single-digit milliseconds in
SQLite. If it ever stops being fast enough, FTS5 is the answer, not an index.

## Code changes

| File | Change |
| --- | --- |
| `server/src/schema.sql` | Ported as above |
| `server/src/normalize.js` | New; `norm()` extracted from `importer.js` |
| `server/src/build-db.js` | New CLI |
| `server/src/db.js` | Rewritten; `waitForDb()` and `migrate()` deleted |
| `server/src/importer.js` | Parsing helpers untouched; writes use `better-sqlite3`; `ON DUPLICATE KEY UPDATE ... VALUES(x)` becomes `ON CONFLICT(col) DO UPDATE SET x = excluded.x`; `imports` logging removed |
| `server/src/routes.js` | Dialect + sync port; search hits `_norm`; `POST /api/import` and `GET /api/imports` deleted |
| `server/src/index.js` | Boot simplifies to open-then-serve; `/healthz` verifies row counts |
| `client/src/pages/Import.jsx` | Deleted |
| `client/src/App.jsx` | Import route and nav entry removed |
| `client/src/api.js` | `import` helper removed |
| `docker-compose.yml` | `db` service, `dbdata` volume and DB environment variables removed; one service remains |
| `Dockerfile` | New `db-build` stage; runtime copies the `.sqlite` |
| `.env.example` | DB connection settings removed |
| `.gitignore` | `data/*.sqlite` added |
| `package.json` | `build:db` script added |
| `server/package.json` | `mysql2` and `multer` removed; `better-sqlite3` added |
| `README.md` | Quick start, schema, importing and API sections rewritten |

`better-sqlite3` is synchronous, so `const [[row]] = await pool.query(...)`
collapses to `const row = stmt.get(...)` and `const [rows] = await ...` to
`stmt.all(...)`. The existing `try`/`catch (e) { next(e) }` wrappers stay. The
`page()` and `size()` helpers (`routes.js:13`) already coerce to `Number`, which
`better-sqlite3` requires for `LIMIT`/`OFFSET` binding.

No client-side date handling changes: `fmtDate` (`client/src/api.js:29`) slices
the first ten characters, so a plain `YYYY-MM-DD` string renders exactly as the
current ISO timestamp does.

## Failure modes

**A build that succeeds and produces an empty database** is the main risk —
nothing looks broken, the app just shows zero tracks. `build-db.js` therefore
exits non-zero when: `data/csv/` is missing, no CSV files match, any file's kind
cannot be detected by `detectKind()`, or the final track count is zero. A broken
build fails in CI rather than deploying quietly.

**A missing or unreadable `.sqlite` at runtime** is fatal at boot rather than
per-request, so the process exits and the revision never becomes ready.

**A partially-built database** cannot occur: `build-db.js` writes to a temporary
path and renames it into place only after a successful run.

## Testing

No test setup exists in the repo. Use Node's built-in `node:test` — no new
dependency, which suits the project. Tests are written before the code they
cover.

1. **Normalisation** (`normalize.js`) — the regression being fixed, so it gets
   explicit cases: `Õhtu` matches `õhtu`, `MÄGI` matches `mägi`, whitespace
   collapses, and a negative case proving `magi` does **not** match `Mägi`.
2. **Existing pure helpers** — `parseEstDate`, `contentIdFromUrl`,
   `parseFilename`, `detectKind` are already exported and currently untested.
3. **`build-db` integration** — fixture CSVs to a temp `.sqlite`; assert row
   counts, that foreign keys hold, that episodes with no tracklist survive, and
   that a second run produces an identical database.
4. **Routes against a fixture database** — where the dialect port can actually
   break. Cover pagination boundaries, date filters, `/api/artists` ranking
   order, `/api/shows/:id` track ordering, a 404 path, a `q` containing `Õ`, and
   a `q` containing `%` (which must match literally, not as a wildcard).

## Rollout

A single commit; no data migration. The CSVs are the source of truth and
everything in MariaDB came from them, so the old `dbdata` volume is simply
dropped.

Verification before deleting anything:

1. Run `npm run build:db` and compare `/api/stats` against the current
   MariaDB-backed numbers. Series, show, track and artist counts must match.
2. Spot-check a search containing `Õ` or `Ä` against both, confirming the
   normalised columns reproduce the collation behaviour.
3. Check a few rendered dates. They may shift by one day relative to today's
   output — `mysql2` returns a local-midnight `Date` that serialises to the
   previous day in UTC. If that shift appears, the new value is the correct one
   and this design incidentally fixes a latent bug.

## One correctness fix taken along the way

A `q` containing `%` or `_` is currently treated as a `LIKE` wildcard rather
than a literal — searching for `50%` matches everything. This is pre-existing
behaviour, not a regression, but the search clauses are being rewritten anyway
and the fix is one line: escape `%`, `_` and `\` in the needle and add
`ESCAPE '\'` to the clause. It is taken, and covered by a test.

Nothing else in current behaviour changes.
