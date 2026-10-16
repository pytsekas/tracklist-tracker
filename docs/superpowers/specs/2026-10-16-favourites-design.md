# Favourites: one list of shows, songs, artists and albums to follow up on

Date: 2026-10-16
Status: approved design, pending implementation plan

## Problem

Listening to the radio produces a trail of things worth following up on
elsewhere: a song to find on a streaming service, an artist to look into, an
album someone mentioned, occasionally a whole episode. Today the app can only
hold one of those, and only partially: a show can be queued with
`want_to_listen`, which means "listen to this episode", not "go and find this
music". Songs, artists and albums have nowhere to go at all, and the archive
does not even know what an album is.

The annotation layer is the wrong shape for this. It is one document per show,
keyed on `content_id`, joined into the archive through a temp table so that
show listings can filter on it. Favourites are not a property of a show; they
are a list of heterogeneous things, most of which are not shows, and the list
is read on its own page rather than joined into listings.

## Decision

Add a **favourites list** as its own personal store next to annotations: one
entry per thing, four kinds, keyed on a stable natural identity rather than on
archive ids, with a note, a done state, and a reserved field for metadata that
a later job may fetch. Lookup links to Spotify, Discogs, Bandcamp and
MusicBrainz are computed on the client from the entry's artist and title and
never stored.

Four decisions, each load-bearing:

**1. Identity is a hash of the kind and a natural key, not an archive id.**
`shows.id`, `tracks.id` and `artists.id` are autoincrement values that a
rebuild renumbers. Only `content_id` is stable. So a show is keyed on
`content_id`, a song and an album on normalised artist and title, and an artist
on its normalised name. The same song played in five episodes is one entry. The
id is the first 24 hex characters of a SHA-256 over those parts, because
Firestore document ids cannot contain `/` and have a byte limit, and "AC/DC"
would hit both.

**2. Entries snapshot their display data.** Each entry stores the names it was
added with and, for a show or a song, the episode it came from. The list page
renders from the snapshot and survives a rebuild. Live archive ids for links
are resolved at read time and may be null.

**3. Show, song and artist are added by archive id; only album is free text.**
The archive is the authority on what exists. A POST names a `content_id`, a
`track_id` or an `artist_id` and the server resolves names from the archive,
so the client never sends names for things the archive knows. An album is the
one kind the archive has no record of, so it is typed in: artist and title.

**4. Same drivers, same cache discipline, no temp table.** The store has the
same two drivers as annotations (Firestore in production, SQLite locally), the
same owner keying and the same 5 s Firestore deadline. The list is loaded into
an in-process Map at boot and every write goes to the durable store first and
the Map second, the same one-directional invariant the temp table has. Nothing
is joined in SQL: the list page reads the Map, and archive routes mark rows
that are favourites by looking the Map up in JavaScript after the query.

### Rejected alternatives

- **Extending the annotation document.** Annotations are per show and joined
  into show listings. Songs, artists and albums do not fit that shape, and
  bolting a list onto a show document would make "favourite this artist" a
  write to some show.
- **A second temp table with SQL joins.** Would allow "tracks on my list"
  paginated in SQL. Nobody has asked for it, and joining tracks on a composite
  normalised key is the ugliest of the options. The Map does membership in
  JavaScript at no visible cost.
- **No cache, read the store on every page.** Simpler server, but the client
  would have to re-implement `norm()` to match rows against entries, and every
  page view would cost a Firestore read. The cache already exists as a pattern
  here and its invariants are documented.
- **Separate favourites and check-later lists.** Discussed and folded into one
  list named favourites. The done state covers "followed up".
- **Replacing `want_to_listen` with favourites.** Different job: the queue is
  "listen to this episode in the archive", favourites is "go find this
  elsewhere". A show can be in both. No migration, nothing removed.

## Non-goals

- Fetching metadata. `meta` is reserved and always `null` in this work. No
  job, no API client, no schedule.
- Multi-user. One owner per process, as today.
- Changes to the import pipeline, the archive schema or the committed
  `.sqlite`.
- Search or pagination over favourites. The list is small by nature.
- Favourites on series or broadcasters.
- Exporting the list.

## Architecture

### Layout

```
server/src/
  firestore-timeout.js      withTimeout() and FIRESTORE_TIMEOUT_MS, moved out of
                            annotations/firestore.js and shared by both drivers
  favourites/
    store.js                entry shape, entryId(), validateAdd(), validatePatch(),
                            applyPatch(), resolveAdd() from archive rows
    index.js                driver selection, getFavouritesStore()/setFavouritesStore(),
                            the cache, favouriteIdOf() for membership
    sqlite.js               dev and test driver: table `favourites` in data/annotations.sqlite
    firestore.js            production driver: annotations/{owner}/favourites/{id}
  routes.js                 four /api/favourites routes; favourite_id on five archive routes
  index.js                  boot: create the store, load the cache (non-fatal)
client/src/
  pages/Favourites.jsx      the list page at /favourites
  components/FavouriteButton.jsx
  lookup.js                 lookupLinks(entry) -> [{ label, href }]
```

The annotation layer is not restructured. `annotations/firestore.js` imports
the timeout helper from the shared file instead of defining it; nothing else
there changes.

### The entry

```
id          string   24 hex chars, see Identity
kind        string   'show' | 'song' | 'artist' | 'album'
artist      string   display name; null for a show or a track with no artist
title       string   show title, song title or album title; null for an artist
artist_norm string   norm(artist); '' for a show or a track with no artist
title_norm  string   norm(title); '' for an artist
show        object   { content_id, title, show_date, series_name, series_slug }
                     the episode itself for a show, the episode a song was added
                     from, null for an artist or an album
notes       string   or null; at most 4000 characters; blank is stored as null
done        boolean
done_at     string   ISO timestamp, set when done flips to true, null when false
added_at    string   ISO timestamp
updated_at  string   ISO timestamp
meta        null     reserved for a later metadata fetch
```

The API returns this object plus, on reads, three live fields resolved from
the archive: `show_id` and `show_url` from `show.content_id`, and `artist_id`
from `artist_norm`. Each is null when the archive has no match.

### Identity

| kind | parts |
| --- | --- |
| show | `String(content_id)` |
| song | `artist_norm`, `title_norm` |
| artist | `artist_norm` |
| album | `artist_norm`, `title_norm` |

`entryId(kind, parts)` is `sha256(kind + '\n' + parts.join('\n'))` as lowercase
hex, truncated to 24 characters. `norm()` is the one in `normalize.js`:
lowercase, trim, collapse whitespace, diacritics preserved. A song and an album
with the same artist and title are different entries because the kind is in
the hash.

### Adding

`validateAdd(body)` accepts exactly one of these shapes and rejects everything
else with a message:

```
{ kind: 'show',   content_id: integer }
{ kind: 'song',   track_id:   integer }
{ kind: 'artist', artist_id:  integer }
{ kind: 'album',  artist: string, title: string }
```

Album strings are trimmed and must be 1 to 200 characters each. Unknown keys
are rejected. `resolveAdd()` then builds the entry from archive rows:

- show: `shows` joined to `series` on `content_id`. 404 if absent.
- song: `tracks` by `id`, left-joined to `artists`, joined to `shows` and
  `series`. A track with no artist gives `artist = null, artist_norm = ''`.
  404 if absent.
- artist: `artists` by `id`. 404 if absent.
- album: `artist_norm = norm(artist)`, `title_norm = norm(title)`, no show.

The new entry has `notes = null`, `done = false`, `done_at = null`,
`added_at = updated_at = now`, `meta = null`.

### Patching

`validatePatch(body)` accepts `notes` (string or null, at most 4000
characters, blank stored as null) and `done` (boolean). Unknown keys and an
empty patch are rejected. `applyPatch(current, patch, now)` merges field by
field, sets `done_at` to `now` when `done` flips to true and to null when it
flips to false, and bumps `updated_at`.

### The store interface

Both drivers implement exactly this. `owner` is the email, as for annotations.

```
list(owner)              -> Map<id, entry>
get(owner, id)           -> entry | null
add(owner, entry)        -> { created: boolean, entry }   create only if absent
merge(owner, id, patch)  -> entry | null                  null when absent
remove(owner, id)        -> void                          idempotent
close()
```

`add` is create-only on purpose. The cache can briefly lag the store after a
timed-out-but-committed write, and a POST that trusted the cache would then
overwrite an existing entry's notes and done state with a fresh one. Firestore
does this in a transaction (read, return the existing document if present,
else set). SQLite does `INSERT ... ON CONFLICT DO NOTHING` and then selects.
`merge` likewise reads the store, not the cache, so a PATCH on an id the cache
has not seen yet still works and a PATCH on a deleted id answers 404.

Every method wraps failures with `unavailable()` from `annotations/store.js`,
so the existing error handler answers 502 with no change.

### Firestore

```
annotations/{email}/favourites/{id}
  kind, artist, title, artist_norm, title_norm, show, notes, done, done_at,
  added_at, updated_at, meta
```

Under the same owner document as `shows`, so all personal data sits in one
place. Auth and the project id come from the runtime service account as
today. No index is needed: the only query is the whole subcollection by path.

### SQLite

```sql
CREATE TABLE IF NOT EXISTS favourites (
  owner       TEXT    NOT NULL,
  id          TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  artist      TEXT,
  title       TEXT,
  artist_norm TEXT    NOT NULL DEFAULT '',
  title_norm  TEXT    NOT NULL DEFAULT '',
  show        TEXT,                        -- JSON object or NULL
  notes       TEXT,
  done        INTEGER NOT NULL DEFAULT 0,
  done_at     TEXT,
  added_at    TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  meta        TEXT,                        -- JSON object or NULL
  PRIMARY KEY (owner, id)
);
```

In the same file as annotations, `data/annotations.sqlite`, on its own
connection. Two `better-sqlite3` connections to one WAL file in one process is
fine. The driver is selected by the same `ANNOTATIONS_DRIVER` and
`ANNOTATIONS_DB` variables; no new variables.

### The cache

`favourites/index.js` holds a `Map<id, entry>`:

```
loadFavourites(map)          replace wholesale; used at boot
setFavourite(entry)          after a successful add or merge
deleteFavourite(id)          after a successful remove
listFavourites()             entries, newest added_at first, then id
favouriteIdOf(kind, parts)   entryId(kind, parts) if the Map has it, else null
```

Boot creates the favourites store and loads the Map right after annotations
load, inside the same non-fatal try block. If either store fails at boot the
archive stays readable; favourites reads answer an empty list and null
membership, writes answer 502 through `getFavouritesStore()`, which throws the
unavailable error when nothing was set, exactly like the annotation handle.

Write order is store first, cache second. The cache never leads the store; the
store may briefly lead the cache; a boot reconciles. The reasoning is the PATCH
handler comment in `routes.js` and is referenced, not repeated. `max_instances`
stays 1 for the reason it already is.

## API

All under `/api`, owner-gated by `requireOwner` like everything else.

| Method | Path | Behaviour |
| --- | --- | --- |
| GET | `/api/favourites` | Array of entries from the cache, newest first, each with `show_id`, `show_url` and `artist_id` resolved live. `?done=true` or `?done=false` filters; any other value is ignored, like `listened`. `?kind=` must be one of the four kinds or answers 400. |
| POST | `/api/favourites` | Body per Adding. 400 on a bad body, 404 when the archive lacks the id. Otherwise `store.add`, then cache. 201 with the entry when created, 200 with the existing entry when it already existed. |
| PATCH | `/api/favourites/:id` | Body per Patching. 400 on a bad id or body. `store.merge`; null answers 404; otherwise cache, then the entry. |
| DELETE | `/api/favourites/:id` | 400 on a bad id. `store.remove`, then cache. 204 whether or not it existed. |

A bad id is anything that is not exactly 24 lowercase hex characters.

### Membership on archive routes

These rows gain `favourite_id`, a string or null, computed in JavaScript after
the query with `favouriteIdOf()` on the row's display fields run through
`norm()`. Recomputing is equivalent to selecting the `*_norm` columns, because
the importer computed those columns with the same function, and it leaves the
SQL and the rest of the payload untouched.

| Route | Rows marked | kind |
| --- | --- | --- |
| `GET /api/shows/:id` | the show, and each track | show, song |
| `GET /api/tracks` | each row | song |
| `GET /api/artists` | each row | artist |
| `GET /api/artists/:id` | the artist | artist |
| `GET /api/series/:slug/shows` | each row | show |

## Client

### Routes and nav

`/favourites` renders `Favourites.jsx`. The nav gains a Favourites link after
Mine. `api.js` gains `favourites(params)`, `addFavourite(body)`,
`patchFavourite(id, patch)` and `deleteFavourite(id)`.

### The Favourites page

- Heading "Favourites", subtitle with the count of rows shown.
- Chips Open, Done, All in a group labelled "View", defaulting to Open. A
  dropdown labelled "Kind" with All kinds, Shows, Songs, Artists, Albums.
- An add-album form at the top: inputs labelled "Artist" and "Album", a button
  "Add album". On success the row appears, or is already listed when the
  server answered 200, and the inputs clear; on failure the inputs keep their
  text and the error shows inline.
- A table, one row per entry: kind; the thing itself; lookup links; notes;
  done; remove.
  - A show links to `/shows/{show_id}` and shows its date and series.
  - A song shows artist and title, with the artist linked to
    `/artists/{artist_id}` and "heard in" linking the episode to
    `/shows/{show_id}`.
  - An artist links to `/artists/{artist_id}`.
  - An album shows artist and title, with the artist linked when `artist_id`
    is known.
  - Links are plain text when the live id is null.
- Lookup links from `lookup.js`, a row of small links: Spotify, Discogs,
  Bandcamp, MusicBrainz. The query is `[artist, title].filter(Boolean).join(' ')`
  URL-encoded. A show entry gets its ERR link instead, from `show_url`.
  ```
  Spotify      https://open.spotify.com/search/{q}
  Discogs      https://www.discogs.com/search/?q={q}&type=all
  Bandcamp     https://bandcamp.com/search?q={q}
  MusicBrainz  https://musicbrainz.org/search?query={q}&type={recording|artist|release}&method=indexed
  ```
  MusicBrainz's type is `recording` for a song, `artist` for an artist,
  `release` for an album.
- Notes: a textarea labelled "Notes for {title}" saved on a 600 ms debounce
  with the same unmount flush and out-of-order guard the Annotator uses. On
  failure the text stays and the error shows inline.
- Done: a checkbox labelled "Done: {title}". Toggling PATCHes immediately.
  Under the Open view a row ticked done stays on screen until the view or
  kind changes or the page reloads, so a mis-click can be undone in place.
- Remove: a button labelled "Remove {title} from favourites". DELETE, then the
  row goes.
- Empty state: "Nothing here yet. Use the star on a show, a song or an artist
  to start this list."

### FavouriteButton

Props: `favouriteId` (string or null from the row), `add` (the POST body), and
`name` (what the thing is called, for the label). Renders a chip button:
"☆ Favourite" with `aria-label="Add {name} to favourites"` when absent,
"★ Favourited" with `aria-label="Remove {name} from favourites"` and
`aria-pressed` when present. Clicking adds or removes. The id lives in local
state seeded from the prop and updated from the response, so the page never
refetches. While saving the button is disabled; on failure it keeps its state
and shows the error inline next to it.

Placement:

- Show page: one in the header row for the show; one per track row in a new
  last column for the song, with `add = { kind: 'song', track_id }`.
- Artist page: one in the header for the artist, and below it a one-line form
  "Add an album by {artist}": an input labelled "Album title" and a button
  "Add". Success shows "Added" briefly and clears the input.
- Tracks page: one per row in a new last column.
- Series rows, Mine rows and the Artists list: no button. A small ★ badge with
  `aria-label="In favourites"` next to the existing badges when `favourite_id`
  is set.

### Styling

Additions to `styles.css` using the existing custom properties only: `.fav`
is a chip like `.chip`, `.fav.on` uses the accent colour; `.links` is a row of
small muted links; the notes textarea in the list reuses `.notes` at a smaller
width. Headings and labels are sentence case; UI text is English; dates
render through `fmtDate`.

## Failure modes

| Situation | Behaviour |
| --- | --- |
| Bad body or id | 400 `{ error }` |
| Archive has no such show, track or artist | 404 `{ error: 'not found' }` |
| Store call fails or times out | 502 via `unavailable()`; cache untouched |
| Store never initialised at boot | reads: empty list, null membership; writes: 502 |
| Timed-out write that later commits | store leads the cache until the next boot; `add` and `merge` consult the store, so a later POST or PATCH still behaves correctly |
| Archive rebuilt, ids renumbered | entries unaffected; live `show_id` and `artist_id` re-resolve on read |
| Show or artist gone from the archive | entry kept; links render as plain text |

## Testing

`node:test`, hermetic, fixtures from `server/test/fixtures/csv/` (one series,
three shows, four tracks of which one has no artist, two artists).

- `favourites-store.test.js`: `entryId` is deterministic, 24 lowercase hex
  characters, differs between song and album for the same parts, and is safe
  for "AC/DC". `validateAdd` accepts each of the four shapes and rejects a
  missing kind, an unknown kind, a non-integer id, a blank or 201-character
  album field and unknown keys. `validatePatch` accepts notes and done,
  stores blank notes as null, rejects a 4001-character note, a non-boolean
  done, unknown keys and an empty patch. `applyPatch` sets and clears
  `done_at` and bumps `updated_at`. `resolveAdd` builds the right entry for
  each kind from the fixture archive, including the track with no artist.
- `favourites-sqlite.test.js`: the contract above against a temp file. `add`
  reports `created: true` then `false` and preserves notes set in between;
  `merge` on an absent id returns null; `remove` twice is fine; `list` keys
  by id. A closed handle surfaces as the unavailable error.
- `favourites-firestore.test.js`: an injected stub client that throws, and one
  that never resolves, both answer the unavailable error, for `list`, `add`
  and `merge`. A live contract test runs only with `FIRESTORE_TEST_PROJECT`.
- `favourites-routes.test.js`: a real Express server on port 0 over the fixture
  archive and a temp SQLite store. POST each kind: 201 then 200 with the same
  id; 404 for unknown archive ids; 400 for bad bodies. GET: order, `done` and
  `kind` filters, `show_id`, `show_url` and `artist_id` decoration, 400 on a bad
  kind. PATCH: notes, done and `done_at`, 404 on an unknown id, 400 on a bad
  id. DELETE: 204 twice, 400 on a bad id. `favourite_id` on the five archive
  routes, null before and set after an add.
- `favourites-routes-uninitialised.test.js`: with no store set, GET answers an
  empty list and POST answers 502 with the unavailable code.
- `annotations-firestore.test.js` keeps covering the moved timeout helper.

The client has no test framework. `npm run build` must pass, and the show,
artist, tracks and favourites pages get a manual check on localhost before the
branch is merged.

## Docs and rollout

- README: a Favourites subsection under Annotations describing the list, the
  identity rule and the cache; four rows in the API table.
- docs/database.md: a section for the favourites store with both DDL
  listings, the Firestore path, the entry shape and the cache invariants.
- AGENTS.md: the new files in the layout; the cache under the invariants next
  to the temp table; the 200-character album limits in "do not loosen".
- Work happens on branch `favourites`, one commit per task, tests green at
  each commit, merged into main with a merge commit and pushed when the whole
  thing is done and verified.
