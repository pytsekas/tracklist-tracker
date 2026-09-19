# Tracklist browser

Browse the scraped ERR radio tracklists (XX sajandi popmuusika, Fantaasia,
Popikroonikad, Sander Varusk, Varuski teematund, Vibratsioon, Eesti Pops) in one place.

* **API** — Express (Node 22, ES modules)
* **UI** — React 18 + Vite, React Router
* **DB** — MariaDB 11 (MySQL-compatible), `mysql2` driver
* **Import** — upload the `*_tracks.csv` / `*_shows.csv` files through the UI

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
cp .env.example .env          # edit the passwords if you like
docker compose up -d --build
open http://localhost:3000
```

That starts two containers: `db` (MariaDB, data in the `dbdata` volume) and
`app` (Express serving the built React bundle on port 3000).
MariaDB is published on host port **3307** so it won't clash with a local MySQL.

Then open **Import** in the UI and drop in the CSV files from the show folders.
Load the `_tracks.csv` files first, then the `_shows.csv` files — the latter add
the episodes that have no tracklist, so the archive gaps stay visible.

```bash
docker compose logs -f app    # follow the API log
docker compose down           # stop (keeps the volume)
docker compose down -v        # stop and wipe the database
```

## Running locally without Docker

Needs Node 22+ and a MariaDB/MySQL you can reach.

```bash
npm install
# point the server at your database
export DB_HOST=127.0.0.1 DB_PORT=3306 \
       DB_NAME=tracklists DB_USER=tracklists DB_PASSWORD=tracklists
npm run dev                   # API on :3000, Vite dev server on :5173
```

Vite proxies `/api` to `:3000`, so use **http://localhost:5173** in dev.
In production the Express server serves the built bundle itself, so there is
only one port.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | API with `--watch` + Vite dev server, side by side |
| `npm run build` | Build the React bundle into `client/dist` |
| `npm start` | Run the API (serves `client/dist` if it exists) |
| `npm run docker:build` | `docker compose build` |
| `npm run docker:up` / `:down` | Start / stop the stack |
| `npm run docker:logs` | Follow the app container's log |

---

## How importing works

The importer figures out what a file is from its **header row**, and which series
it belongs to from its **filename**:

    eesti_pops_tracks.csv  ->  series slug "eesti_pops", kind "tracks"
    fantaasia_shows.csv    ->  series slug "fantaasia",  kind "shows"

**Re-importing the same file is safe.** Shows are matched on `content_id` — ERR's
own episode id, which is stable and unique — and a show's tracks are deleted and
re-inserted rather than appended. So you can re-scrape, re-upload, and the
numbers stay correct.

For `_shows.csv` files there is no `content_id` column, so it is parsed out of
the show URL (`https://r2.err.ee/1610128043/...` → `1610128043`).

Every import is recorded in the `imports` table and shown under **Recent imports**.

## Schema

Five tables, in `server/src/schema.sql`. It is applied on every boot and every
statement is `CREATE TABLE IF NOT EXISTS`, so editing the file and restarting is
the workflow for changing it — this is the starting point, not the final design.

```
series ──< shows ──< tracks >── artists
                          imports   (audit log)
```

* `series` — one row per radio show (slug, display name)
* `shows` — one row per episode; `content_id` is the natural key, `track_count`
  is kept from the scrape so episodes with **no** tracklist are still visible
* `artists` — deduplicated; `name` is what ERR printed, `name_norm` is the
  lowercased/whitespace-collapsed form used for matching
* `tracks` — `position` preserves the play order within an episode; `artist_id`
  is `NULL` where ERR left the artist blank

To change the schema: edit `schema.sql`, then `docker compose restart app`
(or `docker compose down -v && docker compose up -d` to start from empty).

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
| POST | `/api/import` | multipart `files[]` |
| GET | `/api/imports` | last 50 import runs |
| GET | `/healthz` | container healthcheck |

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
