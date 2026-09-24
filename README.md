# Tracklist browser

Browse the scraped ERR radio tracklists (XX sajandi popmuusika, Fantaasia,
Popikroonikad, Sander Varusk, Varuski teematund, Vibratsioon, Eesti Pops) in one place.

* **API** — Express (Node 22, ES modules)
* **UI** — React 18 + Vite, React Router
* **Data** — SQLite, committed at `data/tracklists.sqlite` and baked into the image
* **Annotations** — Firestore; listened / rating / notes / tags, keyed on `content_id`
* **Import** — `npm run build:db` rebuilds it from CSVs; commit the result
* **Deploy** — GitHub Actions builds every push to `main` onto Cloud Run (`infra/`)
* **Access** — the whole site is behind Cloud Run IAP; one Google account

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

One container. The SQLite archive is baked into the image at build time, so
there is no database service, no volume and nothing to wait for.

```bash
docker compose up -d --build
open http://localhost:3000
```

`K_SERVICE` is only set by Cloud Run, so it is unset here: the container runs
with the SQLite annotation driver and no IAP, signed in as `dev@localhost`.

```bash
docker compose logs -f app    # follow the API log
docker compose down           # stop
```

## Running locally without Docker

Needs Node 22+. No database server, and no import step — `data/tracklists.sqlite`
is committed.

```bash
npm install
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
| `npm run build:db` | Build `data/tracklists.sqlite` from the CSVs in `data/csv/` |
| `npm start` | Run the API (serves `client/dist` if it exists) |
| `npm test` | Run the test suite |
| `npm run docker:build` | `docker compose build` |
| `npm run docker:up` / `:down` | Start / stop the stack |
| `npm run docker:logs` | Follow the app container's log |

---

## Build and deploy

`.github/workflows/ci.yml` runs on every push to `main`, every pull request
against it, and on demand:

| Job | Pull request | Push to `main` |
| --- | --- | --- |
| **Test and build** | `npm ci`, `npm test`, `npm run build` | same |
| **Container image** | built, nothing published | pushed to Artifact Registry as `:<sha>` and `:latest` |
| **Deploy to Cloud Run** | skipped | new revision, then `/healthz` is curled against the live URL — with an IAP identity token once `GCP_IAP_CLIENT_ID` is set, otherwise the step logs a notice and passes |

The GCP half is Terraform, in [`infra/`](infra/README.md) — Artifact Registry, a
Cloud Run service, and workload identity federation, so the workflow signs in
with a short-lived GitHub identity rather than a stored service-account key.
Read that file before the first deploy; it is one `terraform apply` plus one
command to set the repository variables.

Until those variables exist the workflow still passes: it tests, builds, and
builds the image, then logs a notice saying it is not publishing.

## How importing works

`data/tracklists.sqlite` is the committed artefact, and the Docker build copies
it straight into the image — so the container ships exactly the archive that was
in the commit it was built from, and starts with no import step.

The database itself is produced by `npm run build:db`, which reads
`data/csv/*.csv` and writes `data/tracklists.sqlite`. **The CSVs are not in this
repository**; they are scrape output. Keep them wherever you scrape, drop them
into `data/csv/`, rebuild, and commit the resulting `.sqlite`.

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

## Annotations

The archive is read-only and rebuilt wholesale by `npm run build:db`, so
anything personal has to live outside it. Annotations are stored separately,
one document per annotated show, keyed on `content_id` — ERR's own episode id,
which is stable across a re-scrape in a way the autoincrement `shows.id` is not.

```
annotations/{email}/shows/{content_id}
  listened, listened_at, rating, notes, want_to_listen, tags[], updated_at
```

At boot the server loads them into a `TEMP TABLE` on the archive's read-only
connection. That is the whole trick: SQLite keeps its temp database in a
separate file, so a read-only main database does not forbid writing to it, and
every route can `LEFT JOIN` annotations and keep filtering, sorting and
pagination in SQL. (`ATTACH ':memory:'` on the same connection is *not*
allowed — it fails with "attempt to write a readonly database".)

Writes go to the durable store first and update the temp row only on success,
so the two cannot disagree. `max_instances` is 1 for the same reason: the temp
table is in-process, and a second instance would serve stale rows.

| Variable | Local | Cloud Run |
| --- | --- | --- |
| `ANNOTATIONS_DRIVER` | `sqlite` | `firestore` |
| `DEV_USER_EMAIL` | your stand-in identity | ignored |
| `IAP_AUDIENCE` | unused | required; the server refuses to boot without it. Terraform sets it on the service from `local.iap_audience` |
| `OWNER_EMAIL` | unused | whose annotations to load at boot |

`npm test` and `npm run dev` use the SQLite driver, so neither needs a cloud
project, credentials or an emulator.

## Access

The site is behind [Cloud Run direct IAP](https://docs.cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run) —
Google sign-in, one allowlisted account, no load balancer and no added cost.
There is no password and no session store: IAP signs an assertion, and the
server verifies it (ES256 only, issuer `https://cloud.google.com/iap`, audience
pinned to this service) on every request.

Grant someone access by adding them to `google_iap_web_cloud_run_service_iam_member`
in `infra/main.tf`. Note that they would see *your* annotations — this is a
single-user design; see the spec's non-goals.

Rolling this out from scratch, including a Critical Terraform prerequisite
that a green `apply` does not surface on its own, is documented in
[`infra/README.md`](infra/README.md#rollout-turning-on-iap).

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
