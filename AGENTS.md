# AGENTS.md

Operating notes for AI coding agents working in this repository. The README is
the human-facing overview; this file is the map, the invariants, and the list
of things not to touch. When the three disagree, the code wins, then the
README, then this file. Fix whichever one is stale.

## What this is

A single-user web app for browsing scraped ERR (Estonian public radio)
tracklists: series, shows (episodes), tracks, with artists cross-referenced.
The archive is a read-only SQLite file committed to the repo and baked into the
container image. On top of it sits a personal annotation layer (listened,
notes, queue) stored in Firestore in production and in a local
SQLite file in development, and a favourites list of shows, songs, artists and
albums. It deploys to Cloud Run behind Identity-Aware Proxy
with one allowlisted Google account.

## Layout

```
package.json              npm workspaces root (server, client); every script lives here
server/src/
  index.js                Express boot: IAP gate, owner gate, /healthz, static bundle, error handler
  routes.js               every /api route; inline SQL through better-sqlite3 prepared statements
  db.js                   opens data/tracklists.sqlite read-only; db() returns the handle
  auth.js                 IAP assertion verification with jose; dev identity fallback
  build-db.js             `npm run build:db`: CSVs + the data/*.json files -> data/tracklists.sqlite
  importer.js             one CSV buffer -> rows; idempotent on content_id
  normalize.js            norm() and likeEscape() for search
  schema.sql              archive schema; applied at build time only
  annotations/
    store.js              annotation shape, validatePatch(), applyPatch(), unavailable()
    index.js              driver selection, process-wide store handle, row -> annotation mapping
    sqlite.js             dev and test driver (data/annotations.sqlite, gitignored)
    firestore.js          production driver; every call has a 5 s deadline
    temp-table.js         TEMP TABLE on the read-only connection; the JOIN and COLUMNS fragments
  firestore-timeout.js    withTimeout() and the 5 s deadline, shared by both Firestore drivers
  favourites/
    store.js              entry shape, entryId(), validateAdd(), validatePatch(), applyPatch(), resolveAdd()
    index.js              driver selection, process-wide store handle, the in-process cache, favouriteIdOf()
    sqlite.js             dev and test driver (a table in data/annotations.sqlite)
    firestore.js          production driver; annotations/{owner}/favourites/{id}
server/test/              node:test suites; fixtures/csv/: 1 series, 3 shows, 4 tracks, 2 artists
client/src/
  main.jsx, App.jsx       React 18 + React Router 6; the route table is in App.jsx
  api.js                  the only fetch wrapper, plus fmtDate / fmtNum
  lookup.js               lookupLinks(entry): Spotify, Discogs, Bandcamp and MusicBrainz links
  pages/                  one file per route (Favourites.jsx is the favourites list)
  components/             Annotator (per-field PATCH editor), FavouriteButton, AddAlbum, Pager, useAsync
  styles.css              plain CSS with custom properties on :root; no CSS framework
data/
  tracklists.sqlite       the committed archive (about 4.4 MB); copied into the image as-is
  broadcasters.json       broadcasters keyed by slug (name, url); applied by build:db
  series.json             per-series settings keyed by slug (broadcaster, archive_url); same
  csv/                    scrape output; not in git; only needed to rebuild the archive
infra/                    Terraform for GCP: Cloud Run, IAP, Firestore, Artifact Registry, WIF
docs/database.md          reference for the archive, the annotation store and the temp table
docs/superpowers/         design specs, implementation plans and a known-issues list
.github/workflows/ci.yml  test, build and image on every PR and push; deploy from main only
```

## Commands

Node 22 or newer. Run everything from the repo root.

| Command | Notes |
| --- | --- |
| `npm install` | once |
| `npm test` | node:test; needs no cloud project, emulator or CSVs |
| `npm run dev` | API on :3000 with `--watch` plus Vite on :5173; open :5173 |
| `npm run build` | React bundle into client/dist |
| `npm start` | API only; serves client/dist when it exists |
| `npm run build:db` | rebuild the archive from data/csv and data/*.json; commit the result |
| `docker compose up -d --build` | one container on :3000, no IAP, SQLite annotations |

There is no lint or format step. Match the surrounding code (see Conventions).

Run `npm test` before claiming anything works. At the time of writing the
suite is 211 tests: 209 pass and 2 are skipped (the live Firestore contract
tests, which need FIRESTORE_TEST_PROJECT). A few `console.warn` lines from
auth.js during the run are expected output from the failure-path tests.

## Invariants

The code depends on these. Breaking one can leave the tests green and
production wrong.

1. **The archive is read-only at runtime.** db.js opens it with `readonly` and
   `fileMustExist`. The server never writes to it. Anything that must persist
   goes through the annotation store.
2. **The archive is a build artefact.** Change schema.sql or the importer, run
   `npm run build:db`, and commit the new data/tracklists.sqlite. The CSVs are
   not in git. If data/csv is absent you cannot rebuild; say so rather than
   editing the .sqlite by hand.
3. **content_id is the natural key for shows.** It is ERR's own episode id and
   survives a re-scrape; shows.id is autoincrement and does not. Annotations
   key on content_id. Read routes take `:id` (shows.id); annotation routes
   take `:contentId`.
4. **Annotations live in a TEMP TABLE on the read-only connection.** Routes
   LEFT JOIN it through ANNOTATION_JOIN, which expects shows aliased as `sh`,
   and select ANNOTATION_COLUMNS, whose `ann_` prefix keeps the annotation's
   updated_at from shadowing the show's. Filtering, sorting and pagination
   stay in SQL. `ATTACH ':memory:'` is not an alternative: it fails on a
   read-only connection.
5. **Write order is durable store first, temp table second.** The temp table
   may lag the store and never lead it; a boot reloads it. Do not reverse the
   order or add a re-read on the failure path. The reasoning is in the PATCH
   handler comment in routes.js.
6. **max_instances = 1 is load-bearing.** The temp table is per process. A
   second instance would serve stale rows.
7. **Auth fails closed.** On Cloud Run a missing IAP_AUDIENCE or OWNER_EMAIL is
   a fatal boot error. Assertions are ES256 only, issuer and audience pinned,
   `exp` required. requireOwner answers 403 to every /api request that is not
   from the owner, reads included. Do not add an anonymous fallback or widen
   the algorithm list.
8. **Diacritics are preserved.** õ, ä, ö and ü are distinct letters; `magi`
   must not match `Mägi`. norm() lowercases and collapses whitespace, nothing
   else. Search goes through the precomputed `*_norm` columns with
   `ESCAPE '\'`. Never LIKE against the raw columns.
9. **CSV order is `*_tracks.csv` before `*_shows.csv`.** The shows files add
   episodes with no tracklist, and those gaps are real data, not failures.
10. **The annotation store must not take the process down.** Driver failures
    surface as 502 through unavailable(); boot continues without a store and
    the archive stays readable.
11. **Favourites live in an in-process Map, not a temp table.** Loaded at boot
    from the store, kept in step store-first on every write, never joined in
    SQL. Archive routes compute `favourite_id` from the Map after the query.
    Entries key on a hash of kind plus natural identity (content_id, or
    normalised artist and title, or normalised name), never on shows.id,
    tracks.id or artists.id. `add` is create-only and `merge` consults the
    store, so a lagging cache cannot overwrite or falsely 404.

## Conventions

- ES modules throughout. `import`, never `require`; Node built-ins with the
  `node:` prefix.
- better-sqlite3 is synchronous. No `await` on archive calls. A handler is
  `async` only when it touches the annotation store.
- Style as found: 2-space indent, single quotes, semicolons, lines near 100
  columns, small `const` arrow helpers.
- SQL is inline in template literals with `?` or `@named` placeholders. User
  input is never interpolated into a query string.
- Bad query parameters answer 400 with `{ error }`. Unknown routes answer 404
  as JSON. Every error body is `{ error: message }` and nothing more.
- Comments explain why, and several document accepted trade-offs (the PATCH
  handler in routes.js, the deadline in firestore.js, requireOwner in
  index.js). When you change the code under one, update or delete it.
- Client pages fetch through `api` in api.js and `useAsync`. No state library.
  Every interactive control has an accessible name. UI text is English; dates
  render as dd.mm.yyyy and numbers use the et-EE locale.
- Client styling uses the custom properties on `:root` in styles.css: white
  background, #1a1a1a ink, #6b7280 muted, #f5f7fa panels, #2e6fdb accent with
  #1f4fa0 hover, Inter, 6px radius. Blue is for links and buttons only.
  Headings are sentence case.
- Tests use `node:test` and `node:assert/strict`. No test framework. Build
  fixture databases in a temp dir from server/test/fixtures/csv/; route tests
  start a real Express server on port 0. New tests go in
  server/test/<area>.test.js.
- Commit subjects are short imperative sentences in sentence case with no
  trailing period; the body says why. Some older commits carry a `fix:` or
  `docs:` prefix, but recent ones on main do not.
- Stage only the files you touched. Never `git add -A`: the tree often
  carries the user's unrelated edits.
- Once a task is complete and `npm test` passes, commit and push to main
  without asking. A push to main deploys to production through ci.yml, so
  the test run has to be the one you just did on the final tree, not an
  earlier one. Half-done work stays on a branch.

## Environment variables

Read straight from the process. Nothing loads a dotenv file. The README's
Annotations section has the same table with more context.

| Variable | Local | Cloud Run |
| --- | --- | --- |
| PORT | 3000 | injected by the platform |
| DB_PATH | data/tracklists.sqlite | same, inside the image |
| ANNOTATIONS_DRIVER | sqlite (default when K_SERVICE is unset) | firestore (default when set) |
| ANNOTATIONS_DB | data/annotations.sqlite | unused |
| DEV_USER_EMAIL | dev@localhost | ignored |
| IAP_AUDIENCE | unused | required; set by Terraform |
| OWNER_EMAIL | unused | required; whose annotations load at boot |
| GOOGLE_CLOUD_PROJECT | unused | the Firestore project |

## Working on a feature

- Non-trivial features here start with a design spec in docs/superpowers/specs/
  and a task plan in docs/superpowers/plans/. Read the two existing specs
  before touching the archive or the annotation layer; they record rejected
  alternatives and non-goals (no multi-user, no annotations on tracks or
  artists, no full-text search over notes, no change to the import pipeline
  from the annotation work).
- docs/superpowers/2026-09-22-show-annotations-known-issues.md lists minor
  defects that were seen and deliberately left. Check it before fixing
  something that may be an accepted trade-off, and do not re-report its items.
- Known and accepted: `/api/artists` rows and total can disagree, because the
  rows join through tracks while total counts every artist. Out of scope
  unless asked.
- Schema change: edit schema.sql, rebuild, commit the .sqlite, update the
  README's Schema section.
- API change: update the README's API table and api.js in the client.
- Infra change: infra/README.md holds the rollout runbook and the reasons
  behind max_instances, firestore_location and the IAP prerequisites.
  Terraform state is local and gitignored.

## Do not

- Edit data/tracklists.sqlite by hand, or commit data/annotations.sqlite and
  its -wal and -shm files.
- Add a write path to the archive connection.
- Add a test framework, a state library, a CSS framework or an ORM.
- Change the IAP issuer, the audience format or the algorithm allowlist.
- Loosen the validatePatch limit (notes 4000 characters; favourites album artist
  and title 200 characters each) without updating the README.
- Raise max_instances above 1.
- Run `terraform apply` or `terraform destroy`, or change GitHub repository
  variables. Those are the user's calls.
- Push to main with failing or unrun tests, or with a task still half-done.
  See Conventions for when a push to main is allowed.
- Commit anything under .omc/ or .superpowers/. Both are local tooling state.
  .omc/ is in the root .gitignore; .superpowers/sdd/ is ignored only by its
  own nested ignore-all .gitignore, so a fresh clone has no such protection.

## Pointers

- README.md: scripts, import rules, schema, annotations design, API table.
- docs/database.md: every table and column, the build pipeline, the annotation
  shape and stores, and the temp table invariants.
- infra/README.md: request and deploy diagrams, bootstrap, IAP rollout
  runbook, rollback notes.
- docs/superpowers/specs/: why things are the way they are.
