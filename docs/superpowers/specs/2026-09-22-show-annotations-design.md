# Personal annotations on shows, behind IAP

Date: 2026-09-22
Status: approved design, pending implementation plan

## Problem

The archive is browsable but inert. There is nowhere to record that an episode
has been listened to, what it was worth, or that it should be queued for later.

The obvious place to put that — `data/tracklists.sqlite` — is the one place it
cannot go. That file is regenerated wholesale by `npm run build:db`, committed,
and baked into the image; anything written into it is destroyed by the next
re-scrape. It is also opened `readonly: true` (`server/src/db.js:20`) and served
from Cloud Run with `min_instances = 0` on an ephemeral filesystem, so there is
no write path and nothing on disk survives a redeploy.

So this is not "add a database". The archive already has one, and it is the
right one. What is missing is a **second, mutable store for per-user annotations
that outlives image rebuilds**, plus the identity to attach them to.

## Decision

Add a durable annotation store in **Firestore**, joined to the archive on
`content_id`, and put the whole site behind **Cloud Run direct IAP**.

Three decisions, each load-bearing:

**1. Annotations key on `content_id`, not `shows.id`.** `content_id` is ERR's
own episode id — stable, unique, and already the join key across the archive.
`shows.id` is an autoincrement assigned during import and is not guaranteed
stable across a rebuild. Keying on it would silently scramble every annotation
the next time the CSVs are re-imported.

**2. Reads happen through a `TEMP TABLE`, not a JavaScript merge.** At boot the
server loads the annotations into a temp table on the existing read-only
connection and every route `LEFT JOIN`s it. This was verified against the real
archive before the design was accepted:

    TEMP TABLE on readonly conn: OK -> [{"title":"XX sajandi popmuusika…","rating":5}]
    ATTACH ':memory:' failed:     attempt to write a readonly database

SQLite's temp database is separate from the main one, so `SQLITE_OPEN_READONLY`
does not forbid it; `ATTACH` of a writable in-memory database is forbidden. The
consequence is that filtering, sorting and pagination stay in SQL. Merging
annotations onto rows in JavaScript would have broken `LIMIT`/`OFFSET` the
moment a filter like "unlistened only" was applied, because the database would
be paginating a set the filter had not yet been applied to.

**3. Auth is IAP, so there is no auth code.** Direct IAP on Cloud Run reached GA
without needing a load balancer, and the pinned provider (`google` 8.3.0,
already in `infra/.terraform.lock.hcl`) carries both `iap_enabled` and
`google_iap_web_cloud_run_service_iam_member`. Google sign-in, an allowlist of
one email, no password to store, no session table, and no global HTTPS load
balancer at ~€18/month.

Consequences:

- Cost stays at zero. Firestore's free tier is far above a single user, and
  Cloud Run still scales to zero. IAP adds no charge.
- `data/tracklists.sqlite`, `build-db.js`, `importer.js` and `normalize.js` are
  untouched. The re-scrape workflow described in the README still holds.
- The site stops being a public link. This is intended.

### Rejected alternatives

**Cloud SQL Postgres, with the archive migrated into it.** The tidiest end
state on paper: one database, real joins, no temp-table trick. Rejected on
operating cost and blast radius. The smallest instance is always-on at roughly
€9–25/month to hold a few hundred annotation rows, it needs a connector or
proxy, it ends scale-to-zero, and it would require rewriting `build-db.js` and
discarding the committed-archive workflow — a large, irreversible change to
working code in service of a feature that is a boolean and four fields.

**A writable SQLite file replicated to GCS by Litestream.** Keeps one mental
model and one query language. Rejected because it forces `min_instances = 1`
and `max_instances = 1`: scale-to-zero is lost (~€8–12/month of always-on CPU),
the service gains a hard concurrency ceiling, and a crash between a write and
its replication loses the tail. Paying in both money and durability to avoid
learning one client library is a bad trade.

**A SQLite file on a GCS volume mount (gcsfuse).** Rejected outright. gcsfuse
does not provide the file locking SQLite relies on; this is a corruption risk,
not a performance one.

**A single JSON blob in a GCS bucket.** Genuinely tempting at this scale — the
whole annotation set is a few hundred kilobytes, and it is about sixty lines
with an `if-generation-match` precondition to prevent lost updates. Rejected
because every write rewrites the entire document, and it has no answer for a
second user or a second device writing concurrently beyond "retry the whole
blob". Firestore is marginally more setup and strictly better behaved.

**Annotations inside `tracklists.sqlite`.** Recorded here only because it is the
first thing anyone will suggest: the next `npm run build:db` deletes them.

## Non-goals

- **Multi-user accounts.** The owner key is an email so that multi-user is a
  later change rather than a rewrite, but no registration, no roles, no sharing.
- **Annotations on tracks or artists.** Shows only.
- **Any change to the import pipeline** — `build-db.js`, `importer.js`,
  `normalize.js`, `schema.sql`, or the committed archive.
- **Full-text search over notes.** Notes are displayed and filtered on
  presence, not searched.

## Architecture

### Layout

```
server/src/
  db.js              unchanged: opens tracklists.sqlite readonly
  annotations/
    store.js         the interface + driver selection
    firestore.js     production driver
    sqlite.js        dev and test driver
    temp-table.js    load into / update the TEMP TABLE
  auth.js            IAP assertion verification -> req.user
  routes.js          extended, not replaced
```

### The store interface

Both drivers implement the same five methods. Nothing outside
`annotations/` knows which one is in use.

```js
list(owner)                    -> Map<content_id, Annotation>
get(owner, contentId)          -> Annotation | null
merge(owner, contentId, patch) -> Annotation   // upsert; see semantics below
remove(owner, contentId)       -> void
close()                        -> void
```

**`merge` semantics, stated explicitly because the alternative is a race.**
Only keys *present* in `patch` are written; absent keys are left alone, and an
explicit `null` clears a field. It is a partial update, not a replacement.

This is not fussiness. The editor saves the notes textarea on a debounce while
the star rating and the listened toggle save immediately. If a write replaced
the whole document, a notes save that was composed before a star click and
landed after it would silently revert the rating. Field-level merge makes the
two writes independent.

Driver selection is `ANNOTATIONS_DRIVER`, defaulting to `firestore` when
`K_SERVICE` is set (Cloud Run) and `sqlite` otherwise. The sqlite driver writes
`data/annotations.sqlite`, which is gitignored — it is scratch state for
`npm run dev`, never an artefact.

### Runtime flow

Boot:

1. `openDb()` — unchanged.
2. `store.list(owner)` — one Firestore query.
3. `createTempTable(db, annotations)` — `CREATE TEMP TABLE` then a prepared
   insert per row inside one transaction.

Request, read:

4. Routes `LEFT JOIN annotations a ON a.content_id = sh.content_id` and expose
   the columns. Filters become ordinary `WHERE` clauses.

Request, write:

5. `store.merge()` writes Firestore **first**. Only on success is the temp row
   updated. On failure the request returns 502 and neither copy has moved, so
   the two cannot diverge.

### Instance coherence

`max_instances` drops from 3 to **1** (`infra/variables.tf`).

The temp table is in-process state. With more than one instance, a write on
instance A leaves instance B serving a stale table. For one user behind IAP,
a single instance at Cloud Run's default concurrency of 80 is far more than
enough, and capping it removes the entire class of problem rather than managing
it. Scale-to-zero is unaffected, so this costs nothing.

If the site is ever opened to more than one person, the documented upgrade is a
`meta` document holding `updated_at`: each request reads that one document and
reloads the temp table only when it has changed. That is one extra Firestore
read per request, which is why it is not being built now.

### Dev flow

IAP does not exist on `localhost`. `auth.js` falls back to `DEV_USER_EMAIL`
(default `dev@localhost`) when `K_SERVICE` is unset, and the sqlite driver
backs the store. `npm run dev` and `npm test` therefore need no cloud project,
no credentials and no emulator — matching the current state, where the test
suite runs against a real database with no mocks.

## Schema

### Firestore

One document **per annotated show**, not per show. The collection starts empty
and grows only as episodes are actually marked.

```
annotations/{email}/shows/{content_id}
  listened        bool
  listened_at     timestamp | null
  rating          int 1..5 | null
  notes           string | null
  want_to_listen  bool
  tags            string[]
  updated_at      timestamp
```

This shape is chosen for read cost. A cold start reads one document per
annotation that exists, not one per show in the archive — a few hundred reads
against a free tier of tens of thousands per day. A document-per-show layout
would have made every cold start a 2,696-read event.

`tags` is an array on the document rather than a join collection, so the
Firestore and SQLite drivers store the same shape. "Every show tagged X" is a
scan of the temp table, which is a few hundred rows.

### The temp table

```sql
CREATE TEMP TABLE annotations (
  content_id     INTEGER PRIMARY KEY,
  listened       INTEGER NOT NULL DEFAULT 0,
  listened_at    TEXT,
  rating         INTEGER,
  notes          TEXT,
  want_to_listen INTEGER NOT NULL DEFAULT 0,
  tags           TEXT NOT NULL DEFAULT '[]',   -- JSON array
  updated_at     TEXT NOT NULL
);
```

Booleans are `INTEGER` and timestamps are ISO-8601 `TEXT` compared
lexicographically, matching how `shows.show_date` is already handled
(`server/src/schema.sql`). `tags` is JSON text; tag filtering uses
`json_each`, which is compiled into `better-sqlite3` by default.

No foreign key to `shows`: the temp table is transient, and an annotation whose
episode has vanished from a re-scraped archive should be preserved, not cascaded
away.

## Auth

`iap_enabled = true` on `google_cloud_run_v2_service`, plus:

- `roles/run.invoker` for the IAP service agent,
  `service-<PROJECT_NUMBER>@gcp-sa-iap.iam.gserviceaccount.com`
- `google_iap_web_cloud_run_service_iam_member` granting
  `roles/iap.httpsResourceAccessor` to the owner's email
- `allow_public_access` default flips `true` → `false` in `infra/variables.tf`

IAP terminates sign-in and injects `X-Goog-IAP-JWT-Assertion`. `auth.js`
verifies it against Google's public keys at
`https://www.gstatic.com/iap/verify/public_key-jwk` (cached): **ES256 only, no
algorithm negotiation**, `exp` and `iat` checked, and the audience pinned to
this service. The email claim becomes the annotation owner.

The audience string for direct Cloud Run IAP is project- and service-specific:

    /projects/PROJECT_NUMBER/locations/REGION/services/SERVICE_NAME

which is a different shape from the App Engine (`/projects/N/apps/ID`) and
backend-service (`/projects/N/global/backendServices/ID`) forms most sample
code uses. Terraform emits it as an `iap_audience` output and passes it to the
container as `IAP_AUDIENCE`, rather than the server assembling it from parts —
a hand-built audience is an auth check that passes for the wrong service.

Verifying the assertion is belt-and-braces given that all ingress goes through
IAP, and it is kept because the alternative — trusting
`X-Goog-Authenticated-User-Email` — is a header that becomes forgeable the day
someone changes `ingress` or puts something in front of the service.

## Code changes

**New**

| File | What |
| --- | --- |
| `server/src/annotations/store.js` | interface, driver selection, validation |
| `server/src/annotations/firestore.js` | `@google-cloud/firestore`, ADC |
| `server/src/annotations/sqlite.js` | `better-sqlite3`, `data/annotations.sqlite` |
| `server/src/annotations/temp-table.js` | create, populate, update one row |
| `server/src/auth.js` | IAP assertion verification, dev fallback |
| `client/src/pages/Mine.jsx` | queue and everything annotated |
| `client/src/components/Annotator.jsx` | the editor control |

**Changed**

| File | What |
| --- | --- |
| `server/src/index.js` | mount `auth`, build the temp table after `openDb()` |
| `server/src/routes.js` | joins, annotation fields, new filters, write routes |
| `server/package.json` | `+@google-cloud/firestore`, `+jose` |
| `client/src/api.js` | `me`, `patchAnnotation`, `deleteAnnotation`, `tags` |
| `client/src/App.jsx` | `/mine` route and nav item |
| `client/src/pages/Show.jsx` | mount the editor |
| `client/src/pages/SeriesShows.jsx` | state badges, four filters |
| `infra/cloud_run.tf` | `iap_enabled`, IAP service agent invoker |
| `infra/main.tf` | Firestore database, `roles/datastore.user`, IAP member |
| `infra/variables.tf` | `owner_email`; `max_instances` 3→1; `allow_public_access` default false |
| `infra/outputs.tf` | `iap_audience`, for verifying the assertion |
| `.github/workflows/ci.yml` | IAP-authenticated post-deploy healthcheck |
| `.gitignore` | `data/annotations.sqlite` |
| `README.md` | auth, the annotation store, the new env vars |

### API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/me` | `{ email }` |
| PATCH | `/api/shows/:contentId/annotation` | partial update, upserting; returns the merged annotation |
| DELETE | `/api/shows/:contentId/annotation` | clear |
| GET | `/api/tags` | distinct tags with counts |

Extended: `/api/series/:slug/shows` and `/api/shows/:id` return the annotation
(`null` when absent); `/api/series/:slug/shows` accepts `?listened=`, `?want=`,
`?tag=`, `?ratingMin=`. Both already select `content_id`
(`server/src/routes.js:48`, and `SELECT sh.*` at `:64`), so no payload key
changes.

Validation on write, rejected with 400: `rating` is an integer 1–5 or null;
`notes` is ≤ 4000 characters; `tags` is ≤ 20 entries, each ≤ 40 characters,
trimmed, deduplicated, empty strings dropped; `contentId` must exist in `shows`.

## Failure modes

**Firestore unreachable at boot.** Fail the request, not the process. The
archive is the product and is still fully readable; annotations degrade to
unavailable. `/healthz` continues to report only on the archive, so a Firestore
outage does not roll back a deploy or kill a healthy revision.

**Firestore unreachable on write.** 502, temp table untouched, and the client
keeps the user's input in the field rather than clearing it — except that
"unreachable" includes a call that only timed out, and an abandoned
`runTransaction` can still go on to commit. In that case the write did land in
Firestore even though the request was told 502 and the temp table was never
updated. The invariant this design actually holds is one-directional: the temp
table never moves ahead of Firestore, but Firestore can briefly be ahead of the
temp table. A cache that is behind is safe; a cache that is ahead is a lie, so
the asymmetry is the point, not a gap. The next boot reconciles by reloading
the temp table from Firestore. No reconcile is attempted mid-process — it would
cost a round trip on the failure branch of a case that already self-heals at
next boot, and would need its own retry loop for when the re-read also times
out. The driver logs a timed-out call that goes on to succeed distinctly from
one that is genuinely rejected, so this is visible in the logs rather than
merely inferred.

**A re-scrape removes an episode.** Its annotation stays in Firestore, orphaned
and invisible. This is deliberate — ERR occasionally reshuffles the archive, and
silently deleting a user's notes because a URL moved is worse than a stale
document. A cleanup script is a follow-up, not part of this.

**Two tabs open.** One instance, one temp table, so writes serialise. The second
tab shows stale data until it refetches; last write wins per field.

**The JWKS fetch fails.** Cache the keys with a long TTL and serve from the
cache; if there is no cache yet, fail closed with 503. Failing open would
disable the only access control the site has.

## Testing

In the style already established in `server/test/` — `node --test`, real
databases, no mocks.

| File | Covers |
| --- | --- |
| `annotations-store.test.js` | the driver contract against the sqlite driver |
| `annotations-temp-table.test.js` | population, single-row update, the join |
| `annotations-routes.test.js` | partial update, upsert, delete, every validation rejection, and that a key absent from the body does not clear its field |
| `auth.test.js` | assertion verification: good, expired, wrong audience, wrong algorithm, absent |
| `annotations-filters.test.js` | the four filters, combined and paginated |

The `alg` test matters more than its size suggests: it is the one that catches
an `alg: none` assertion being accepted.

The Firestore driver gets the same contract test, skipped unless credentials are
present, so CI stays hermetic and offline.

## Rollout

Two applies, deliberately separated — flipping IAP and shipping new code
together produces a 403 that could mean either.

1. `terraform apply` — Firestore database, `roles/datastore.user` on the runtime
   service account, `roles/iap.httpsResourceAccessor` for the owner and for the
   CI identity. The site is still public and still works.
2. Merge to `main`. CI builds, deploys, and health-checks the new revision.
3. `terraform apply` — `iap_enabled = true`, `allow_public_access = false`.
   Confirm the sign-in prompt, then that an unlisted account is refused.

Rollback for each step is the inverse apply; no data migration is involved, so
nothing is one-way.
