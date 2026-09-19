# Tracklist browser

Browse the scraped ERR radio tracklists (XX sajandi popmuusika, Fantaasia,
Popikroonikad, Sander Varusk, Varuski teematund, Vibratsioon, Eesti Pops) in one place.

* **API** — Express (Node 22, ES modules)
* **UI** — React 18 + Vite, React Router
* **Data** — SQLite, built from the CSVs in `data/csv/` at image build time
* **Import** — `npm run build:db`; re-scraping means committing new CSVs

---

###
* Clean project - clean data import and storage options. Data load when viewing from frontend
* Github build
* Best GCP deploy options + github action




❯ for a start this app looks OK,
  i now want to implement CI&/CD
  when pushing to github, project is built and deplyed

  for deployment I want to use GCP

  lets start with setting up infra

  for that I want to use Terraform
  What is thre simpliest solution



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

> **Note:** the Docker build is not yet wired up for the new flow — see Task 8
> of the migration plan.

## Running locally without Docker

Needs Node 22+. No database server.

```bash
npm install
npm run build:db              # data/csv/*.csv -> data/tracklists.sqlite
npm run dev                   # API on :3000, Vite dev server on :5173
```

Vite proxies `/api` to `:3000`, so use **http://localhost:5173** in dev.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | API with `--watch` + Vite dev server, side by side |
| `npm run build` | Build the React bundle into `client/dist` |
| `npm run build:db` | Build `data/tracklists.sqlite` from the CSVs in `data/csv/` |
| `npm start` | Run the API (serves `client/dist` if it exists) |
| `npm test` | Run the test suite |
| `npm run docker:build` | `docker compose build` |
| `npm run docker:up` / `:down` | Start / stop the stack |
| `npm run docker:logs` | Follow the app container's log |

---

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

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/stats` | row counts |
| GET | `/api/series` | series with show/track counts and date range |
| GET | `/api/series/:slug/shows` | `?page=&pageSize=` |
| GET | `/api/shows/:id` | episode plus its tracks |
| GET | `/api/tracks` | `?q=&series=&from=&to=&page=&pageSize=` |
| GET | `/api/artists` | `?q=&page=` — ranked by play count |
| GET | `/api/artists/:id` | every play, across all series |
| GET | `/healthz` | container healthcheck; 503 when the database is empty |

---

## Notes on the data

Things worth knowing before you build anything on top of this:

* **Artist names are not normalised at the source.** The same track appears as
  `You've Got Me Beat` and `Youve Got Me Beat` in two different shows. Matching
  on `name_norm` handles case and spacing, not punctuation — if you want true
  deduplication, that is a later pass over the `artists` table.
* **Some tracks have no artist.** ERR left the field blank; those rows import
  with `artist_id = NULL` rather than being dropped.
* **Episodes without a tracklist are real data**, not import failures. Loading
  the `_shows.csv` files is what makes those gaps visible in the UI.
* **`content_id` is the join key across everything.** If you scrape more shows
  later, the same id always means the same episode.
