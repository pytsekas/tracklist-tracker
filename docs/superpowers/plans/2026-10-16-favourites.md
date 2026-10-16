# Favourites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One personal list of shows, songs, artists and albums to follow up on elsewhere, with notes, a done state and lookup links, stored next to the annotations and marked on the archive pages.

**Architecture:** A `server/src/favourites/` module mirrors the annotation layer: a shape-and-validation file, a SQLite driver for dev and tests, a Firestore driver for production, and an in-process Map loaded at boot. Entries are keyed on a hash of their kind and a natural identity so they survive an archive rebuild. Every write goes to the durable store first and the Map second; nothing is joined in SQL. Four `/api/favourites` routes serve the list and the archive routes gain a `favourite_id` per row computed from the Map. The client gets a Favourites page, a toggle button on the show, artist and tracks pages, and a ★ badge on list rows.

**Tech Stack:** Node 22 (ES modules), Express 4, `better-sqlite3` 13, `@google-cloud/firestore` 9, React 18 + Vite, React Router 6, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-16-favourites-design.md` (committed as `97a48ac` on branch `favourites`). Read it first; this plan argues from it.

## Global Constraints

- Node 22+, ES modules. `import`, never `require`; Node built-ins with the `node:` prefix.
- Tests use `node:test` and `node:assert/strict`. No test framework. New tests go in `server/test/<area>.test.js`. Route tests start a real Express server on port 0 over a fixture archive built from `server/test/fixtures/csv/` into a temp dir.
- `better-sqlite3` is synchronous: no `await` on archive calls. A handler is `async` only when it touches a store.
- The archive connection stays read-only. Never write to `data/tracklists.sqlite`. No schema change.
- Entry ids are `sha256(kind + '\n' + parts.join('\n'))` hex, first 24 characters. Natural parts: show `[String(content_id)]`; song and album `[artist_norm, title_norm]`; artist `[artist_norm]`. `norm()` is `server/src/normalize.js`: lowercase, trim, collapse whitespace, diacritics preserved.
- Limits: album artist and title 1 to 200 characters after trimming; notes at most 4000 characters, blank stored as null. Do not loosen without updating README and AGENTS.md.
- Store write order: durable store first, cache second. `add` is create-only. `merge` and `remove` consult the store, never the cache, for existence.
- Firestore path `annotations/{owner}/favourites/{id}`; every call races the shared 5 s deadline. SQLite table `favourites` in `data/annotations.sqlite`, primary key `(owner, id)`.
- Driver failures wrap with `unavailable()` from `server/src/annotations/store.js`, so the error handler already answers 502. Its code is `ANNOTATION_STORE_UNAVAILABLE`; reuse it, do not add a second code.
- Every error body is `{ error: message }` and nothing more. Bad input answers 400, archive misses 404, unknown routes 404 as JSON.
- Style as found: 2-space indent, single quotes, semicolons, lines near 100 columns, small `const` arrow helpers, comments explain why. UI text English, sentence-case headings, dates through `fmtDate`, numbers through `fmtNum`. Every interactive control has an accessible name. Styling uses the custom properties on `:root` in `client/src/styles.css`; no new colours.
- The client has no test framework: `npm run build` must pass after every client task.
- File writes go through the Write and Edit tools, not Bash heredocs (a project hook blocks Bash commands containing certain words, `env` among them). Bash is for `npm test`, `npm run build`, git and docker.
- Work on branch `favourites` (already exists, one commit: the spec). Commit after every task with a short imperative subject in sentence case, a body that says why, and the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Stage only files you touched; never `git add -A`. Do not push until the whole plan is done and verified.
- Do not edit `data/tracklists.sqlite`, anything under `src/generated/`, `.omc/` or `.superpowers/`.

## Review Focus

1. Album names differing only in case or whitespace are one entry: POST `{kind:'album', artist:'  The  Beatles ', title:'abbey road'}` after `{artist:'The Beatles', title:'Abbey Road'}` answers 200 with the same id, not a duplicate. Test in Task 7.
2. Ticking done twice keeps the first `done_at`: a PATCH `{done:true}` on an entry already done leaves `done_at` unchanged. Test in Task 2.
3. A song with no artist round-trips: added from the fixture track whose artist is empty, it gets `artist = null`, `artist_norm = ''`, and the same track on `/api/shows/:id` carries its id as `favourite_id`. Tests in Tasks 3 and 8.
4. `?kind=` with an empty value is ignored, not a 400, because `api.js` drops empty params and a hand-typed empty value should mean "all kinds". Test in Task 7.
5. A removed entry's id in a later PATCH answers 404 and in a later DELETE 204; the cache no longer lists it. Test in Task 7.

---

## File structure

| File | Responsibility |
| --- | --- |
| `server/src/firestore-timeout.js` | `withTimeout()` and `FIRESTORE_TIMEOUT_MS`, shared by both Firestore drivers (moved out of `annotations/firestore.js`) |
| `server/src/favourites/store.js` | constants, `entryId`, `isEntryId`, `validateAdd`, `validatePatch`, `applyPatch`, `newEntry`, `resolveAdd` |
| `server/src/favourites/sqlite.js` | `createSqliteFavourites(file)` |
| `server/src/favourites/firestore.js` | `createFirestoreFavourites({ projectId, client, timeoutMs })` |
| `server/src/favourites/index.js` | `createFavouritesStore`, `setFavouritesStore`, `getFavouritesStore`, the cache: `loadFavourites`, `setFavourite`, `deleteFavourite`, `listFavourites`, `favouriteIdOf` |
| `server/src/routes.js` | four `/api/favourites` routes; `favourite_id` on five archive routes |
| `server/src/index.js` | boot wiring |
| `client/src/api.js` | four wrappers |
| `client/src/lookup.js` | `lookupLinks(entry)` |
| `client/src/components/FavouriteButton.jsx` | add-or-remove toggle |
| `client/src/components/AddAlbum.jsx` | album form, used on the Favourites and Artist pages |
| `client/src/pages/Favourites.jsx` | the list page |
| `client/src/App.jsx`, `pages/Show.jsx`, `pages/Artist.jsx`, `pages/Tracks.jsx`, `pages/SeriesShows.jsx`, `pages/Mine.jsx`, `pages/Artists.jsx`, `styles.css` | wiring, buttons, badges |
| `README.md`, `docs/database.md`, `AGENTS.md` | docs |

Fixture facts used by tests (from `server/test/fixtures/csv/`, built by `buildDatabase`): series slug `testshow`; shows with content ids `1610000001` ("Testsaade. Esimene", 2024-02-01, three tracks), `1610000002` ("Testsaade. Teine", 2024-03-15, one track), `1610000003` ("Testsaade. Kolmas", no tracks). Tracks: "Õhtu jõuab" by Mägi, "Teine lugu" by MÄGI (same artist row, name "Mägi"), "Nimeta lugu" with no artist, "Sada protsenti" by "Ansambel 50%". Look ids up by title or name in tests rather than hardcoding them.

---

### Task 1: Share the Firestore deadline helper

**Files:**
- Create: `server/src/firestore-timeout.js`
- Modify: `server/src/annotations/firestore.js` (delete the local `FIRESTORE_TIMEOUT_MS` and `withTimeout`, import them)
- Test: existing `server/test/annotations-firestore.test.js` (no new test; this is a pure move)

**Interfaces:**
- Produces: `export const FIRESTORE_TIMEOUT_MS = 5000` and `export function withTimeout(promise, ms, label)`, identical behaviour to today, consumed by Task 5.

- [ ] **Step 1: Run the existing Firestore tests to record the baseline**

Run: `npm test -- server/test/annotations-firestore.test.js` (or `node --test server/test/annotations-firestore.test.js`)
Expected: all pass except the live contract test, which is skipped.

- [ ] **Step 2: Create the shared helper**

Write `server/src/firestore-timeout.js`. Move the long comment that starts "The SDK retries a downed backend on its own" from `annotations/firestore.js` above the constant, verbatim.

```js
// (the moved comment about the SDK's ~42s internal retry budget goes here, verbatim)
export const FIRESTORE_TIMEOUT_MS = 5000;

/**
 * Race a Firestore call against a driver-owned deadline. Shared by the
 * annotation and favourites drivers so there is one copy of the reasoning
 * above and one copy of the late-success warning below.
 */
export function withTimeout(promise, ms, label) {
  let timer;
  let firedLate = false;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      firedLate = true;
      reject(new Error(`Firestore call timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timedOut]).finally(() => {
    clearTimeout(timer);
    // (the existing comment about the loser being a real call goes here, verbatim)
    promise.then(
      () => { if (firedLate) console.warn(`Firestore ${label} completed after its ${ms}ms deadline had already fired`); },
      () => {});
  });
}
```

- [ ] **Step 3: Point the annotation driver at it**

In `server/src/annotations/firestore.js`: add `import { withTimeout, FIRESTORE_TIMEOUT_MS } from '../firestore-timeout.js';` after the existing imports, delete the moved comment, the `const FIRESTORE_TIMEOUT_MS = 5000;` line and the whole `function withTimeout` definition. Nothing else changes; the `createFirestoreStore` default parameter still reads `timeoutMs = FIRESTORE_TIMEOUT_MS`.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: 149 tests, 148 pass, 1 skipped, same as before the move.

- [ ] **Step 5: Commit**

```bash
git add server/src/firestore-timeout.js server/src/annotations/firestore.js
git commit -m "Share the Firestore deadline helper between drivers" -m "The favourites driver needs the same 5 s race and the same late-success warning; one copy keeps the reasoning in one place." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Entry shape, identity and validation

**Files:**
- Create: `server/src/favourites/store.js`
- Test: `server/test/favourites-store.test.js`

**Interfaces:**
- Produces:
  - `KINDS: readonly ['show','song','artist','album']`, `MAX_NAME = 200`
  - `entryId(kind: string, parts: string[]): string` (24 lowercase hex)
  - `isEntryId(id: unknown): boolean`
  - `validateAdd(body) -> { ok: true, add } | { ok: false, error }` where `add` is one of `{kind:'show', content_id}`, `{kind:'song', track_id}`, `{kind:'artist', artist_id}`, `{kind:'album', artist, title}` (strings trimmed)
  - `validatePatch(body) -> { ok: true, patch: { notes?, done? } } | { ok: false, error }`
  - `applyPatch(current, patch, now = new Date()) -> entry`
  - `newEntry({ kind, artist, title, show }, now = new Date()) -> entry` with the full shape from the spec

- [ ] **Step 1: Write the failing tests**

Create `server/test/favourites-store.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KINDS, MAX_NAME, entryId, isEntryId, validateAdd, validatePatch, applyPatch, newEntry,
} from '../src/favourites/store.js';

/* -------------------------------- identity -------------------------------- */

test('entryId is deterministic, 24 lowercase hex characters', () => {
  const a = entryId('song', ['mägi', 'õhtu jõuab']);
  assert.equal(a, entryId('song', ['mägi', 'õhtu jõuab']));
  assert.match(a, /^[0-9a-f]{24}$/);
});

test('entryId separates kinds for the same parts', () => {
  assert.notEqual(entryId('song', ['x', 'y']), entryId('album', ['x', 'y']));
});

test('entryId is safe for a slash in a name', () => {
  assert.match(entryId('artist', ['ac/dc']), /^[0-9a-f]{24}$/);
});

test('isEntryId accepts only 24 lowercase hex characters', () => {
  assert.equal(isEntryId('0123456789abcdef01234567'), true);
  assert.equal(isEntryId('0123456789ABCDEF01234567'), false);
  assert.equal(isEntryId('0123456789abcdef0123456'), false);
  assert.equal(isEntryId(42), false);
});

/* ------------------------------- validateAdd ------------------------------ */

test('validateAdd accepts each kind', () => {
  assert.deepEqual(validateAdd({ kind: 'show', content_id: 1610000001 }),
    { ok: true, add: { kind: 'show', content_id: 1610000001 } });
  assert.deepEqual(validateAdd({ kind: 'song', track_id: 3 }),
    { ok: true, add: { kind: 'song', track_id: 3 } });
  assert.deepEqual(validateAdd({ kind: 'artist', artist_id: 2 }),
    { ok: true, add: { kind: 'artist', artist_id: 2 } });
  assert.deepEqual(validateAdd({ kind: 'album', artist: ' Mägi ', title: ' Esimene ' }),
    { ok: true, add: { kind: 'album', artist: 'Mägi', title: 'Esimene' } });
});

test('validateAdd rejects a missing or unknown kind', () => {
  assert.equal(validateAdd({ content_id: 1 }).ok, false);
  assert.equal(validateAdd({ kind: 'series', content_id: 1 }).ok, false);
  assert.equal(validateAdd(null).ok, false);
  assert.equal(validateAdd([]).ok, false);
});

test('validateAdd rejects a non-integer id, including a numeric string', () => {
  assert.equal(validateAdd({ kind: 'show', content_id: '1610000001' }).ok, false);
  assert.equal(validateAdd({ kind: 'song', track_id: 1.5 }).ok, false);
  assert.equal(validateAdd({ kind: 'artist' }).ok, false);
});

test('validateAdd rejects blank or over-long album fields', () => {
  assert.equal(validateAdd({ kind: 'album', artist: '  ', title: 'x' }).ok, false);
  assert.equal(validateAdd({ kind: 'album', artist: 'x', title: 'y'.repeat(MAX_NAME + 1) }).ok, false);
  assert.equal(validateAdd({ kind: 'album', artist: 'x', title: 'y'.repeat(MAX_NAME) }).ok, true);
  assert.equal(validateAdd({ kind: 'album', artist: 'x' }).ok, false);
});

test('validateAdd rejects unknown keys', () => {
  const r = validateAdd({ kind: 'show', content_id: 1, title: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown field: title/);
});

/* ------------------------------ validatePatch ----------------------------- */

test('validatePatch accepts notes and done', () => {
  assert.deepEqual(validatePatch({ notes: 'leia üles', done: true }),
    { ok: true, patch: { notes: 'leia üles', done: true } });
});

test('validatePatch stores blank notes as null', () => {
  assert.deepEqual(validatePatch({ notes: '   ' }).patch, { notes: null });
  assert.deepEqual(validatePatch({ notes: null }).patch, { notes: null });
});

test('validatePatch rejects notes over 4000 characters', () => {
  assert.equal(validatePatch({ notes: 'x'.repeat(4001) }).ok, false);
  assert.equal(validatePatch({ notes: 'x'.repeat(4000) }).ok, true);
});

test('validatePatch rejects a non-boolean done, unknown keys and an empty patch', () => {
  assert.equal(validatePatch({ done: 'yes' }).ok, false);
  assert.equal(validatePatch({ title: 'x' }).ok, false);
  assert.equal(validatePatch({}).ok, false);
  assert.equal(validatePatch(null).ok, false);
});

/* ------------------------------- applyPatch ------------------------------- */

const base = () => newEntry(
  { kind: 'artist', artist: 'Mägi', title: null, show: null },
  new Date('2026-10-16T10:00:00.000Z'));

test('applyPatch sets done_at when done flips to true and clears it on false', () => {
  const t1 = new Date('2026-10-16T11:00:00.000Z');
  const done = applyPatch(base(), { done: true }, t1);
  assert.equal(done.done, true);
  assert.equal(done.done_at, t1.toISOString());
  assert.equal(done.updated_at, t1.toISOString());

  const undone = applyPatch(done, { done: false }, new Date('2026-10-16T12:00:00.000Z'));
  assert.equal(undone.done, false);
  assert.equal(undone.done_at, null);
});

test('applyPatch keeps the first done_at when done is set true again', () => {
  const t1 = new Date('2026-10-16T11:00:00.000Z');
  const done = applyPatch(base(), { done: true }, t1);
  const again = applyPatch(done, { done: true }, new Date('2026-10-16T12:00:00.000Z'));
  assert.equal(again.done_at, t1.toISOString());
});

test('applyPatch moves only the keys in the patch', () => {
  const e = applyPatch(base(), { notes: 'x' });
  assert.equal(e.notes, 'x');
  assert.equal(e.done, false);
  assert.equal(e.artist, 'Mägi');
  assert.equal(e.added_at, '2026-10-16T10:00:00.000Z');
});

/* -------------------------------- newEntry -------------------------------- */

test('newEntry builds the full shape with normalised parts', () => {
  const now = new Date('2026-10-16T10:00:00.000Z');
  const show = { content_id: 1610000001, title: 'Testsaade. Esimene', show_date: '2024-02-01',
                 series_name: 'Testshow', series_slug: 'testshow' };
  const e = newEntry({ kind: 'song', artist: 'MÄGI', title: 'Õhtu  jõuab', show }, now);
  assert.deepEqual(e, {
    id: entryId('song', ['mägi', 'õhtu jõuab']),
    kind: 'song', artist: 'MÄGI', title: 'Õhtu  jõuab',
    artist_norm: 'mägi', title_norm: 'õhtu jõuab', show,
    notes: null, done: false, done_at: null,
    added_at: now.toISOString(), updated_at: now.toISOString(), meta: null,
  });
});

test('newEntry keys a show on its content_id and an artist on its name', () => {
  const show = { content_id: 1610000002, title: 'T', show_date: '2024-03-15',
                 series_name: 'S', series_slug: 's' };
  assert.equal(newEntry({ kind: 'show', artist: null, title: 'T', show }).id,
    entryId('show', ['1610000002']));
  const a = newEntry({ kind: 'artist', artist: 'Ansambel 50%', title: null, show: null });
  assert.equal(a.id, entryId('artist', ['ansambel 50%']));
  assert.equal(a.title, null);
  assert.equal(a.title_norm, '');
});

test('newEntry treats a missing artist as the empty norm', () => {
  const e = newEntry({ kind: 'song', artist: null, title: 'Nimeta lugu', show: null });
  assert.equal(e.artist, null);
  assert.equal(e.artist_norm, '');
  assert.equal(e.id, entryId('song', ['', 'nimeta lugu']));
});

test('KINDS lists the four kinds', () => {
  assert.deepEqual([...KINDS], ['show', 'song', 'artist', 'album']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/test/favourites-store.test.js`
Expected: FAIL at import time with "Cannot find module .../favourites/store.js".

- [ ] **Step 3: Write the implementation**

Create `server/src/favourites/store.js`:

```js
/**
 * The favourites entry: its identity, its validation and its merge rule. Both
 * drivers (sqlite.js, firestore.js) store exactly this object and nothing more.
 * resolveAdd() lives here too (Task 3) because the entry's natural key comes
 * from archive rows, and this is the one place that knows the key.
 */
import { createHash } from 'node:crypto';
import { norm } from '../normalize.js';

export const KINDS = Object.freeze(['show', 'song', 'artist', 'album']);
export const MAX_NAME = 200;
const MAX_NOTES = 4000;
const ID_RE = /^[0-9a-f]{24}$/;

// Which body keys each kind accepts, besides `kind`. Show, song and artist
// name an archive row; album is the one free-text kind.
const ADD_KEYS = {
  show: ['content_id'],
  song: ['track_id'],
  artist: ['artist_id'],
  album: ['artist', 'title'],
};

const bad = error => ({ ok: false, error });

/**
 * A stable id from the kind and the natural key. Hashed because Firestore
 * document ids cannot contain "/" and have a byte limit; "AC/DC" would hit
 * both. The parts are already normalised, so no separator can appear in them.
 */
export function entryId(kind, parts) {
  return createHash('sha256').update([kind, ...parts].join('\n')).digest('hex').slice(0, 24);
}

export const isEntryId = id => typeof id === 'string' && ID_RE.test(id);

/** Validate a POST body. Returns the cleaned `add` object or an error. */
export function validateAdd(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return bad('body must be an object');
  }
  const { kind } = body;
  if (!KINDS.includes(kind)) return bad(`kind must be one of ${KINDS.join(', ')}`);

  const keys = ADD_KEYS[kind];
  const unknown = Object.keys(body).filter(k => k !== 'kind' && !keys.includes(k));
  if (unknown.length) return bad(`unknown field: ${unknown.join(', ')}`);

  if (kind === 'album') {
    const add = { kind };
    for (const key of keys) {
      const value = typeof body[key] === 'string' ? body[key].trim() : '';
      if (value === '') return bad(`${key} must be a non-empty string`);
      if (value.length > MAX_NAME) return bad(`${key} must be at most ${MAX_NAME} characters`);
      add[key] = value;
    }
    return { ok: true, add };
  }

  const [idKey] = keys;
  if (!Number.isInteger(body[idKey])) return bad(`${idKey} must be an integer`);
  return { ok: true, add: { kind, [idKey]: body[idKey] } };
}

/**
 * Validate a PATCH body. Only keys actually present are returned, so a
 * debounced notes save cannot revert a done tick made a moment earlier.
 */
export function validatePatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return bad('body must be an object');
  }
  const unknown = Object.keys(body).filter(k => !['notes', 'done'].includes(k));
  if (unknown.length) return bad(`unknown field: ${unknown.join(', ')}`);

  const patch = {};
  if ('done' in body) {
    if (typeof body.done !== 'boolean') return bad('done must be a boolean');
    patch.done = body.done;
  }
  if ('notes' in body) {
    const n = body.notes;
    if (n !== null && typeof n !== 'string') return bad('notes must be a string or null');
    if (typeof n === 'string' && n.length > MAX_NOTES) {
      return bad(`notes must be at most ${MAX_NOTES} characters`);
    }
    // An empty textarea means "no note", not an empty note.
    patch.notes = n === null || n.trim() === '' ? null : n;
  }
  if (Object.keys(patch).length === 0) return bad('no recognised fields to update');
  return { ok: true, patch };
}

/** Field-level merge. done_at records the first flip to true and clears on false. */
export function applyPatch(current, patch, now = new Date()) {
  const next = { ...current, ...patch };
  if ('done' in patch && patch.done !== current.done) {
    next.done_at = patch.done ? now.toISOString() : null;
  }
  next.updated_at = now.toISOString();
  return next;
}

/** A fresh entry. `artist` and `title` may be null; `show` is the snapshot or null. */
export function newEntry({ kind, artist, title, show }, now = new Date()) {
  const artist_norm = artist ? norm(artist) : '';
  const title_norm = title ? norm(title) : '';
  const parts = kind === 'show' ? [String(show.content_id)]
    : kind === 'artist' ? [artist_norm]
    : [artist_norm, title_norm];
  const stamp = now.toISOString();
  return {
    id: entryId(kind, parts),
    kind,
    artist: artist ?? null,
    title: title ?? null,
    artist_norm,
    title_norm,
    show: show ?? null,
    notes: null,
    done: false,
    done_at: null,
    added_at: stamp,
    updated_at: stamp,
    meta: null,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/test/favourites-store.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/favourites/store.js server/test/favourites-store.test.js
git commit -m "Add the favourites entry shape, identity and validation" -m "Entries key on a hash of the kind and a natural identity so they survive an archive rebuild; the add and patch bodies are validated here, once, for both drivers." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Resolve an add body against the archive

**Files:**
- Modify: `server/src/favourites/store.js` (append `resolveAdd`)
- Test: `server/test/favourites-store.test.js` (append a section)

**Interfaces:**
- Consumes: `newEntry` from Task 2; the archive handle from `openDb()` in `server/src/db.js`.
- Produces: `resolveAdd(handle, add, now = new Date()) -> entry | null` where `add` is the cleaned object from `validateAdd` and `null` means the archive has no such row.

- [ ] **Step 1: Write the failing tests**

Append to `server/test/favourites-store.test.js`. Add these imports at the top of the file alongside the existing ones:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDatabase } from '../src/build-db.js';
import { openDb } from '../src/db.js';
import { resolveAdd } from '../src/favourites/store.js';
```

Then append:

```js
/* ------------------------------- resolveAdd ------------------------------- */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CSV = path.join(__dirname, 'fixtures/csv');

function fixtureDb() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-fav-')), 'test.sqlite');
  buildDatabase({ csvDir: FIXTURE_CSV, outPath: out });
  return openDb(out);
}
const trackId = (h, title) => h.prepare('SELECT id FROM tracks WHERE title = ?').get(title).id;
const artistId = (h, name) => h.prepare('SELECT id FROM artists WHERE name = ?').get(name).id;

test('resolveAdd builds a show entry from its content_id', () => {
  const h = fixtureDb();
  const e = resolveAdd(h, { kind: 'show', content_id: 1610000001 });
  assert.equal(e.kind, 'show');
  assert.equal(e.artist, null);
  assert.equal(e.title, 'Testsaade. Esimene');
  assert.deepEqual(e.show, {
    content_id: 1610000001, title: 'Testsaade. Esimene', show_date: '2024-02-01',
    series_name: e.show.series_name, series_slug: 'testshow',
  });
  assert.equal(e.id, entryId('show', ['1610000001']));
  h.close();
});

test('resolveAdd builds a song entry with the show it was heard in', () => {
  const h = fixtureDb();
  const e = resolveAdd(h, { kind: 'song', track_id: trackId(h, 'Teine lugu') });
  assert.equal(e.kind, 'song');
  assert.equal(e.artist, 'Mägi', 'the artist row name, not the spelling on this track');
  assert.equal(e.title, 'Teine lugu');
  assert.equal(e.show.content_id, 1610000001);
  assert.equal(e.id, entryId('song', ['mägi', 'teine lugu']));
  h.close();
});

test('resolveAdd handles a track with no artist', () => {
  const h = fixtureDb();
  const e = resolveAdd(h, { kind: 'song', track_id: trackId(h, 'Nimeta lugu') });
  assert.equal(e.artist, null);
  assert.equal(e.artist_norm, '');
  assert.equal(e.id, entryId('song', ['', 'nimeta lugu']));
  h.close();
});

test('resolveAdd builds an artist entry and an album entry', () => {
  const h = fixtureDb();
  const a = resolveAdd(h, { kind: 'artist', artist_id: artistId(h, 'Ansambel 50%') });
  assert.equal(a.artist, 'Ansambel 50%');
  assert.equal(a.show, null);
  const b = resolveAdd(h, { kind: 'album', artist: 'Mägi', title: 'Esimene plaat' });
  assert.equal(b.kind, 'album');
  assert.equal(b.show, null);
  assert.equal(b.id, entryId('album', ['mägi', 'esimene plaat']));
  h.close();
});

test('resolveAdd returns null when the archive has no such row', () => {
  const h = fixtureDb();
  assert.equal(resolveAdd(h, { kind: 'show', content_id: 1 }), null);
  assert.equal(resolveAdd(h, { kind: 'song', track_id: 999 }), null);
  assert.equal(resolveAdd(h, { kind: 'artist', artist_id: 999 }), null);
  h.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/test/favourites-store.test.js`
Expected: FAIL with "resolveAdd" not exported (a SyntaxError on the named import).

- [ ] **Step 3: Write the implementation**

Append to `server/src/favourites/store.js`:

```js
const SHOW_SQL = `
  SELECT sh.content_id, sh.title AS show_title, sh.show_date,
         s.name AS series_name, s.slug AS series_slug
  FROM shows sh JOIN series s ON s.id = sh.series_id
  WHERE sh.content_id = ?`;

const TRACK_SQL = `
  SELECT t.title, a.name AS artist,
         sh.content_id, sh.title AS show_title, sh.show_date,
         s.name AS series_name, s.slug AS series_slug
  FROM tracks t
  LEFT JOIN artists a ON a.id = t.artist_id
  JOIN shows sh ON sh.id = t.show_id
  JOIN series s ON s.id = sh.series_id
  WHERE t.id = ?`;

const snapshot = row => ({
  content_id: row.content_id,
  title: row.show_title,
  show_date: row.show_date,
  series_name: row.series_name,
  series_slug: row.series_slug,
});

/**
 * Build the entry a cleaned add body describes, from the archive. The archive
 * is the authority on what exists: null means "no such row", which the route
 * turns into 404. Synchronous, like every archive call.
 */
export function resolveAdd(handle, add, now = new Date()) {
  switch (add.kind) {
    case 'show': {
      const row = handle.prepare(SHOW_SQL).get(add.content_id);
      if (!row) return null;
      return newEntry({ kind: 'show', artist: null, title: row.show_title, show: snapshot(row) }, now);
    }
    case 'song': {
      const row = handle.prepare(TRACK_SQL).get(add.track_id);
      if (!row) return null;
      return newEntry({ kind: 'song', artist: row.artist, title: row.title, show: snapshot(row) }, now);
    }
    case 'artist': {
      const row = handle.prepare('SELECT name FROM artists WHERE id = ?').get(add.artist_id);
      if (!row) return null;
      return newEntry({ kind: 'artist', artist: row.name, title: null, show: null }, now);
    }
    case 'album':
      return newEntry({ kind: 'album', artist: add.artist, title: add.title, show: null }, now);
    default:
      return null;
  }
}
```

`get()` returns `undefined` for no row; the explicit `return null` keeps the contract strict, and the tests assert `null` with strict equality.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/test/favourites-store.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/favourites/store.js server/test/favourites-store.test.js
git commit -m "Resolve a favourites add body against the archive" -m "Show, song and artist are added by archive id and the server fills in the names and the episode snapshot, so the client never sends names for things the archive knows." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The SQLite driver

**Files:**
- Create: `server/src/favourites/sqlite.js`
- Test: `server/test/favourites-sqlite.test.js`

**Interfaces:**
- Consumes: `applyPatch`, `newEntry` from Task 2; `unavailable` from `server/src/annotations/store.js`.
- Produces: `createSqliteFavourites(file) -> { list, get, add, merge, remove, close }` per the spec's store interface.

- [ ] **Step 1: Write the failing tests**

Create `server/test/favourites-sqlite.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqliteFavourites } from '../src/favourites/sqlite.js';
import { newEntry } from '../src/favourites/store.js';

const tmpFile = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-fav-sqlite-')), 'annotations.sqlite');

const OWNER = 'marko@example.com';
const show = { content_id: 1610000001, title: 'Testsaade. Esimene', show_date: '2024-02-01',
               series_name: 'Testshow', series_slug: 'testshow' };
const song = () => newEntry({ kind: 'song', artist: 'Mägi', title: 'Õhtu jõuab', show },
  new Date('2026-10-16T10:00:00.000Z'));
const artist = () => newEntry({ kind: 'artist', artist: 'Ansambel 50%', title: null, show: null },
  new Date('2026-10-16T11:00:00.000Z'));

test('add creates once and then reports the existing entry', async () => {
  const store = createSqliteFavourites(tmpFile());
  const first = await store.add(OWNER, song());
  assert.equal(first.created, true);
  assert.deepEqual(first.entry, song());

  await store.merge(OWNER, song().id, { notes: 'leia' });
  const second = await store.add(OWNER, song());
  assert.equal(second.created, false);
  assert.equal(second.entry.notes, 'leia', 'the existing entry is returned, not overwritten');
  store.close();
});

test('get returns the entry or null', async () => {
  const store = createSqliteFavourites(tmpFile());
  assert.equal(await store.get(OWNER, song().id), null);
  await store.add(OWNER, song());
  const got = await store.get(OWNER, song().id);
  assert.deepEqual(got.show, show, 'the snapshot round-trips through JSON');
  assert.equal(got.done, false);
  assert.equal(got.meta, null);
  store.close();
});

test('merge applies a patch and returns null for an absent id', async () => {
  const store = createSqliteFavourites(tmpFile());
  await store.add(OWNER, song());
  const done = await store.merge(OWNER, song().id, { done: true });
  assert.equal(done.done, true);
  assert.ok(done.done_at);
  const again = await store.get(OWNER, song().id);
  assert.equal(again.done, true, 'the write is durable');
  assert.equal(await store.merge(OWNER, '0'.repeat(24), { done: true }), null);
  store.close();
});

test('list keys by id and keeps owners apart', async () => {
  const store = createSqliteFavourites(tmpFile());
  await store.add(OWNER, song());
  await store.add(OWNER, artist());
  await store.add('other@example.com', song());
  const all = await store.list(OWNER);
  assert.equal(all.size, 2);
  assert.equal(all.get(artist().id).artist, 'Ansambel 50%');
  assert.equal((await store.list('other@example.com')).size, 1);
  store.close();
});

test('remove is idempotent', async () => {
  const store = createSqliteFavourites(tmpFile());
  await store.add(OWNER, song());
  await store.remove(OWNER, song().id);
  await store.remove(OWNER, song().id);
  assert.equal(await store.get(OWNER, song().id), null);
  store.close();
});

test('a broken handle surfaces as ANNOTATION_STORE_UNAVAILABLE', async () => {
  const store = createSqliteFavourites(tmpFile());
  store.close();
  for (const call of [
    () => store.list(OWNER),
    () => store.get(OWNER, song().id),
    () => store.add(OWNER, song()),
    () => store.merge(OWNER, song().id, { done: true }),
    () => store.remove(OWNER, song().id),
  ]) {
    await assert.rejects(call, err => err.code === 'ANNOTATION_STORE_UNAVAILABLE');
  }
});

test('the file is created with its directory', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-fav-dir-')), 'deep', 'a.sqlite');
  const store = createSqliteFavourites(file);
  assert.ok(fs.existsSync(file));
  store.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/test/favourites-sqlite.test.js`
Expected: FAIL with "Cannot find module .../favourites/sqlite.js".

- [ ] **Step 3: Write the implementation**

Create `server/src/favourites/sqlite.js`:

```js
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { unavailable } from '../annotations/store.js';
import { applyPatch } from './store.js';

const DDL = `
CREATE TABLE IF NOT EXISTS favourites (
  owner       TEXT    NOT NULL,
  id          TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  artist      TEXT,
  title       TEXT,
  artist_norm TEXT    NOT NULL DEFAULT '',
  title_norm  TEXT    NOT NULL DEFAULT '',
  show        TEXT,
  notes       TEXT,
  done        INTEGER NOT NULL DEFAULT 0,
  done_at     TEXT,
  added_at    TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  meta        TEXT,
  PRIMARY KEY (owner, id)
);`;

/** DB row -> entry. Booleans are 0/1 and the two objects are JSON text at rest. */
const toEntry = row => ({
  id: row.id,
  kind: row.kind,
  artist: row.artist,
  title: row.title,
  artist_norm: row.artist_norm,
  title_norm: row.title_norm,
  show: row.show === null ? null : JSON.parse(row.show),
  notes: row.notes,
  done: !!row.done,
  done_at: row.done_at,
  added_at: row.added_at,
  updated_at: row.updated_at,
  meta: row.meta === null ? null : JSON.parse(row.meta),
});

const toRow = (owner, e) => ({
  owner,
  id: e.id,
  kind: e.kind,
  artist: e.artist,
  title: e.title,
  artist_norm: e.artist_norm,
  title_norm: e.title_norm,
  show: e.show === null ? null : JSON.stringify(e.show),
  notes: e.notes,
  done: e.done ? 1 : 0,
  done_at: e.done_at,
  added_at: e.added_at,
  updated_at: e.updated_at,
  meta: e.meta === null ? null : JSON.stringify(e.meta),
});

/**
 * The dev and test driver. Same file as the annotation store
 * (data/annotations.sqlite, gitignored), its own table and its own
 * connection: two better-sqlite3 handles on one WAL file in one process are
 * fine, and it keeps this module independent of the annotation driver.
 */
export function createSqliteFavourites(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const handle = new Database(file);
  handle.pragma('journal_mode = WAL');
  handle.exec(DDL);

  const selectOne = handle.prepare('SELECT * FROM favourites WHERE owner = ? AND id = ?');
  const selectAll = handle.prepare(
    'SELECT * FROM favourites WHERE owner = ? ORDER BY added_at DESC, id');
  // DO NOTHING, not an upsert: add() is create-only so that a cache that lags
  // the store can never make a repeat add overwrite notes or the done state.
  const insert = handle.prepare(`
    INSERT INTO favourites
      (owner, id, kind, artist, title, artist_norm, title_norm, show,
       notes, done, done_at, added_at, updated_at, meta)
    VALUES
      (@owner, @id, @kind, @artist, @title, @artist_norm, @title_norm, @show,
       @notes, @done, @done_at, @added_at, @updated_at, @meta)
    ON CONFLICT (owner, id) DO NOTHING`);
  const update = handle.prepare(`
    UPDATE favourites
    SET notes = @notes, done = @done, done_at = @done_at, updated_at = @updated_at
    WHERE owner = @owner AND id = @id`);
  const del = handle.prepare('DELETE FROM favourites WHERE owner = ? AND id = ?');

  // Every method wraps its failure in unavailable(), so a broken store reaches
  // the client as a 502 rather than an opaque 500, as the annotation drivers do.
  return {
    async list(owner) {
      try {
        return new Map(selectAll.all(owner).map(r => [r.id, toEntry(r)]));
      } catch (err) { throw unavailable(err); }
    },

    async get(owner, id) {
      try {
        const row = selectOne.get(owner, id);
        return row ? toEntry(row) : null;
      } catch (err) { throw unavailable(err); }
    },

    async add(owner, entry) {
      try {
        const { changes } = insert.run(toRow(owner, entry));
        return { created: changes === 1, entry: toEntry(selectOne.get(owner, entry.id)) };
      } catch (err) { throw unavailable(err); }
    },

    async merge(owner, id, patch) {
      try {
        const row = selectOne.get(owner, id);
        if (!row) return null;
        const next = applyPatch(toEntry(row), patch);
        update.run({
          owner, id, notes: next.notes, done: next.done ? 1 : 0,
          done_at: next.done_at, updated_at: next.updated_at,
        });
        return next;
      } catch (err) { throw unavailable(err); }
    },

    async remove(owner, id) {
      try {
        del.run(owner, id);
      } catch (err) { throw unavailable(err); }
    },

    close() { handle.close(); },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/test/favourites-sqlite.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/favourites/sqlite.js server/test/favourites-sqlite.test.js
git commit -m "Add the SQLite favourites driver" -m "Same file as annotations, own table and connection. add() inserts with DO NOTHING so a repeat add can never overwrite notes or the done state." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The Firestore driver

**Files:**
- Create: `server/src/favourites/firestore.js`
- Test: `server/test/favourites-firestore.test.js`

**Interfaces:**
- Consumes: `withTimeout`, `FIRESTORE_TIMEOUT_MS` from Task 1; `applyPatch`, `newEntry` from Task 2; `unavailable`.
- Produces: `createFirestoreFavourites({ projectId, client = null, timeoutMs = FIRESTORE_TIMEOUT_MS }) -> { list, get, add, merge, remove, close }`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/favourites-firestore.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreFavourites } from '../src/favourites/firestore.js';
import { newEntry } from '../src/favourites/store.js';

// Hermetic: no network, no cloud project, no emulator in CI. The live
// contract test runs only when someone has deliberately pointed it at a project.
const PROJECT = process.env.FIRESTORE_TEST_PROJECT;
const skip = PROJECT ? false : 'set FIRESTORE_TEST_PROJECT to run';

const OWNER = `test-${process.pid}@example.com`;

test('the Firestore favourites driver satisfies the store contract', { skip }, async () => {
  const store = createFirestoreFavourites({ projectId: PROJECT });
  const id = SONG.id;
  try {
    assert.equal(await store.get(OWNER, id), null);
    const first = await store.add(OWNER, SONG);
    assert.equal(first.created, true);
    const merged = await store.merge(OWNER, id, { notes: 'hea' });
    assert.equal(merged.notes, 'hea');
    const second = await store.add(OWNER, SONG);
    assert.equal(second.created, false);
    assert.equal(second.entry.notes, 'hea');
    const all = await store.list(OWNER);
    assert.equal(all.size, 1);
    assert.equal(all.get(id).notes, 'hea');
    await store.remove(OWNER, id);
    assert.equal(await store.get(OWNER, id), null);
    assert.equal(await store.merge(OWNER, id, { done: true }), null);
  } finally {
    await store.remove(OWNER, id).catch(() => {});
    store.close();
  }
});

// The stub tests exercise the same catch blocks a real network failure would.
// SONG has a fixed timestamp so deepEqual comparisons are stable.

const SONG = newEntry({ kind: 'song', artist: 'Mägi', title: 'Õhtu jõuab', show: null },
  new Date('2026-10-16T10:00:00.000Z'));
/** A stub client whose annotations/{owner}/favourites subcollection is `sub`. */
const clientWith = sub => ({ collection: () => ({ doc: () => ({ collection: () => sub }) }) });
const withoutId = entry => { const { id, ...fields } = entry; return fields; };

test('a failing client surfaces as ANNOTATION_STORE_UNAVAILABLE', async () => {
  const listFails = { collection() { throw new Error('offline'); } };
  await assert.rejects(
    () => createFirestoreFavourites({ projectId: 'p', client: listFails }).list(OWNER),
    err => err.code === 'ANNOTATION_STORE_UNAVAILABLE', 'list()');

  // add() and merge() build a doc ref and then hand the work to
  // runTransaction(); make that call throw.
  const txFails = {
    ...clientWith({ doc: () => ({}) }),
    runTransaction() { throw new Error('offline'); },
  };
  const store = createFirestoreFavourites({ projectId: 'p', client: txFails });
  await assert.rejects(() => store.add(OWNER, SONG),
    err => err.code === 'ANNOTATION_STORE_UNAVAILABLE', 'add()');
  await assert.rejects(() => store.merge(OWNER, SONG.id, { done: true }),
    err => err.code === 'ANNOTATION_STORE_UNAVAILABLE', 'merge()');
});

test('a hung call times out as ANNOTATION_STORE_UNAVAILABLE', async () => {
  // get() never resolves; only the driver's own deadline can end this.
  const client = clientWith({ get: () => new Promise(() => {}) });
  const store = createFirestoreFavourites({ projectId: 'p', client, timeoutMs: 50 });
  await assert.rejects(() => store.list(OWNER),
    err => err.code === 'ANNOTATION_STORE_UNAVAILABLE');
});

test('add reports created false and returns the stored document when it exists', async () => {
  const existing = { ...withoutId(SONG), notes: 'olemas' };
  const client = {
    ...clientWith({ doc: () => ({}) }),
    runTransaction: async fn => fn({
      get: async () => ({ exists: true, id: SONG.id, data: () => existing }),
      set: () => { throw new Error('must not write over an existing entry'); },
    }),
  };
  const store = createFirestoreFavourites({ projectId: 'p', client });
  const r = await store.add(OWNER, SONG);
  assert.equal(r.created, false);
  assert.equal(r.entry.notes, 'olemas');
  assert.equal(r.entry.id, SONG.id);
});

test('add writes the document without an id field when it is new', async () => {
  let written = null;
  const client = {
    ...clientWith({ doc: () => ({}) }),
    runTransaction: async fn => fn({
      get: async () => ({ exists: false }),
      set: (_ref, fields) => { written = fields; },
    }),
  };
  const r = await createFirestoreFavourites({ projectId: 'p', client }).add(OWNER, SONG);
  assert.equal(r.created, true);
  assert.deepEqual(r.entry, SONG);
  assert.deepEqual(written, withoutId(SONG), 'the id lives in the path, not the document');
});

test('list maps document ids back onto entries', async () => {
  const data = withoutId(SONG);
  const client = clientWith({ get: async () => ({ docs: [{ id: SONG.id, data: () => data }] }) });
  const all = await createFirestoreFavourites({ projectId: 'p', client }).list(OWNER);
  assert.deepEqual(all.get(SONG.id), SONG);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/test/favourites-firestore.test.js`
Expected: FAIL with "Cannot find module .../favourites/firestore.js".

- [ ] **Step 3: Write the implementation**

Create `server/src/favourites/firestore.js`:

```js
import { Firestore } from '@google-cloud/firestore';
import { unavailable } from '../annotations/store.js';
import { withTimeout, FIRESTORE_TIMEOUT_MS } from '../firestore-timeout.js';
import { applyPatch } from './store.js';

/** Firestore doc -> entry. The id is the document id, not a field. */
const toEntry = (id, data) => ({
  id,
  kind: data.kind,
  artist: data.artist ?? null,
  title: data.title ?? null,
  artist_norm: data.artist_norm ?? '',
  title_norm: data.title_norm ?? '',
  show: data.show ?? null,
  notes: data.notes ?? null,
  done: data.done ?? false,
  done_at: data.done_at ?? null,
  added_at: data.added_at,
  updated_at: data.updated_at ?? data.added_at,
  meta: data.meta ?? null,
});

/** entry -> document fields. The id lives in the path, so it is not written twice. */
const toDoc = ({ id, ...fields }) => fields;

/**
 * Production driver. Auth comes from the runtime service account, as for the
 * annotation driver; nothing is configured here. Documents live under the
 * same owner document as annotated shows:
 *
 *   annotations/{owner}/favourites/{id}
 *
 * `client` and `timeoutMs` exist for tests, as in annotations/firestore.js.
 */
export function createFirestoreFavourites({
  projectId,
  client = null,
  timeoutMs = FIRESTORE_TIMEOUT_MS,
} = {}) {
  const db = client ?? new Firestore({ projectId });
  const col = owner => db.collection('annotations').doc(owner).collection('favourites');

  return {
    async list(owner) {
      try {
        const snap = await withTimeout(col(owner).get(), timeoutMs, 'favourites list');
        return new Map(snap.docs.map(d => [d.id, toEntry(d.id, d.data())]));
      } catch (err) { throw unavailable(err); }
    },

    async get(owner, id) {
      try {
        const doc = await withTimeout(col(owner).doc(id).get(), timeoutMs, 'favourites get');
        return doc.exists ? toEntry(doc.id, doc.data()) : null;
      } catch (err) { throw unavailable(err); }
    },

    // Create-only, in a transaction: a repeat add returns what is there and
    // never overwrites notes or the done state, even when this process's
    // cache has not seen the entry yet.
    async add(owner, entry) {
      try {
        const ref = col(owner).doc(entry.id);
        const run = db.runTransaction(async tx => {
          const doc = await tx.get(ref);
          if (doc.exists) return { created: false, entry: toEntry(doc.id, doc.data()) };
          tx.set(ref, toDoc(entry));
          return { created: true, entry };
        });
        return await withTimeout(run, timeoutMs, 'favourites add');
      } catch (err) { throw unavailable(err); }
    },

    async merge(owner, id, patch) {
      try {
        const ref = col(owner).doc(id);
        const run = db.runTransaction(async tx => {
          const doc = await tx.get(ref);
          if (!doc.exists) return null;
          const next = applyPatch(toEntry(doc.id, doc.data()), patch);
          tx.set(ref, toDoc(next));
          return next;
        });
        return await withTimeout(run, timeoutMs, 'favourites merge');
      } catch (err) { throw unavailable(err); }
    },

    async remove(owner, id) {
      try {
        await withTimeout(col(owner).doc(id).delete(), timeoutMs, 'favourites remove');
      } catch (err) { throw unavailable(err); }
    },

    close() { return db.terminate(); },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/test/favourites-firestore.test.js`
Expected: all pass, one skipped (the live contract test).

- [ ] **Step 5: Commit**

```bash
git add server/src/favourites/firestore.js server/test/favourites-firestore.test.js
git commit -m "Add the Firestore favourites driver" -m "Documents sit under the same owner document as annotated shows. add() and merge() run in transactions so a repeat add returns what is there rather than overwriting it." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Driver selection, the store handle and the cache

**Files:**
- Create: `server/src/favourites/index.js`
- Test: `server/test/favourites-cache.test.js`

**Interfaces:**
- Consumes: `createSqliteFavourites` (Task 4), `createFirestoreFavourites` (Task 5, lazily imported), `entryId` (Task 2), `unavailable`.
- Produces:
  - `createFavouritesStore(vars = process.env) -> Promise<store>`; same driver choice and variables as `createStore` in `server/src/annotations/index.js`
  - `setFavouritesStore(store)`, `getFavouritesStore() -> store` (throws the unavailable error when never set)
  - cache: `loadFavourites(map: Map<id, entry>)`, `setFavourite(entry)`, `deleteFavourite(id)`, `listFavourites() -> entry[]` (newest `added_at` first, then id), `favouriteIdOf(kind, parts) -> id | null`

- [ ] **Step 1: Write the failing tests**

Create `server/test/favourites-cache.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadFavourites, setFavourite, deleteFavourite, listFavourites, favouriteIdOf,
  createFavouritesStore,
} from '../src/favourites/index.js';
import { newEntry, entryId } from '../src/favourites/store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const at = iso => new Date(iso);
const older = newEntry({ kind: 'artist', artist: 'Mägi', title: null, show: null },
  at('2026-10-16T10:00:00.000Z'));
const newer = newEntry({ kind: 'album', artist: 'Mägi', title: 'Plaat', show: null },
  at('2026-10-16T11:00:00.000Z'));

test('loadFavourites replaces the cache and listFavourites orders newest first', () => {
  loadFavourites(new Map([[older.id, older], [newer.id, newer]]));
  assert.deepEqual(listFavourites().map(e => e.id), [newer.id, older.id]);
  loadFavourites(new Map());
  assert.deepEqual(listFavourites(), []);
});

test('setFavourite and deleteFavourite keep the cache in step', () => {
  loadFavourites(new Map());
  setFavourite(older);
  assert.equal(listFavourites().length, 1);
  setFavourite({ ...older, notes: 'x' });
  assert.equal(listFavourites()[0].notes, 'x', 'set replaces by id');
  deleteFavourite(older.id);
  assert.deepEqual(listFavourites(), []);
});

test('favouriteIdOf answers the id only for cached entries', () => {
  loadFavourites(new Map([[older.id, older]]));
  assert.equal(favouriteIdOf('artist', ['mägi']), entryId('artist', ['mägi']));
  assert.equal(favouriteIdOf('artist', ['keegi teine']), null);
  assert.equal(favouriteIdOf('album', ['mägi']), null, 'the kind is part of the key');
});

test('createFavouritesStore picks SQLite by default and honours ANNOTATIONS_DB', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-fav-idx-')), 'a.sqlite');
  const store = await createFavouritesStore({ ANNOTATIONS_DB: file });
  assert.ok(fs.existsSync(file));
  assert.equal((await store.list('x@example.com')).size, 0);
  store.close();
});

test('createFavouritesStore rejects an unknown driver', async () => {
  await assert.rejects(() => createFavouritesStore({ ANNOTATIONS_DRIVER: 'redis' }), /unknown ANNOTATIONS_DRIVER/);
});
```

Do not test `getFavouritesStore()` unset here: Task 7's uninitialised route test covers it in its own process, and any file that calls `setFavouritesStore` would flip the module state for the rest of its process.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/test/favourites-cache.test.js`
Expected: FAIL with "Cannot find module .../favourites/index.js".

- [ ] **Step 3: Write the implementation**

Create `server/src/favourites/index.js`:

```js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqliteFavourites } from './sqlite.js';
import { unavailable } from '../annotations/store.js';
import { entryId } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The process-wide store, a module-level handle for the same reason the
 * annotation store has one (see annotations/index.js).
 */
let store = null;

export function setFavouritesStore(s) { store = s; }

export function getFavouritesStore() {
  // Same client-visible situation as a driver failing mid-call: the archive
  // works, the favourites layer does not. unavailable() gives it the
  // ANNOTATION_STORE_UNAVAILABLE code the error handler turns into 502.
  if (!store) throw unavailable(new Error('favourites store not initialised at boot'));
  return store;
}

/**
 * Same driver choice and the same variables as the annotation store:
 * Firestore on Cloud Run (K_SERVICE is set by the platform), a local SQLite
 * file everywhere else, so `npm run dev` and `npm test` need no cloud project.
 */
export async function createFavouritesStore(vars = process.env) {
  const driver = vars.ANNOTATIONS_DRIVER || (vars.K_SERVICE ? 'firestore' : 'sqlite');

  if (driver === 'sqlite') {
    return createSqliteFavourites(
      vars.ANNOTATIONS_DB || path.resolve(__dirname, '../../../data/annotations.sqlite'));
  }
  if (driver === 'firestore') {
    const { createFirestoreFavourites } = await import('./firestore.js');
    return createFirestoreFavourites({ projectId: vars.GOOGLE_CLOUD_PROJECT });
  }
  throw new Error(`unknown ANNOTATIONS_DRIVER: ${driver}`);
}

/* ---------------------------------- cache --------------------------------- */

// The owner's whole list, in process. Loaded at boot, kept in step after every
// successful store write, and the only thing reads and membership lookups
// touch. It can lag the store (a timed-out write that still commits) but
// never lead it; a boot reconciles. Same invariant as the annotation temp
// table, documented on the PATCH handler in routes.js.
const cache = new Map();

/** Replace the cache wholesale. Used at boot, from store.list(). */
export function loadFavourites(map) {
  cache.clear();
  for (const [id, entry] of map) cache.set(id, entry);
}

export function setFavourite(entry) { cache.set(entry.id, entry); }

export function deleteFavourite(id) { cache.delete(id); }

/** Every cached entry, newest first; id breaks ties so the order is stable. */
export function listFavourites() {
  return [...cache.values()].sort(
    (a, b) => b.added_at.localeCompare(a.added_at) || a.id.localeCompare(b.id));
}

/** The entry id for a kind and its natural parts, or null when not a favourite. */
export function favouriteIdOf(kind, parts) {
  const id = entryId(kind, parts);
  return cache.has(id) ? id : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/test/favourites-cache.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/favourites/index.js server/test/favourites-cache.test.js
git commit -m "Add the favourites store handle and in-process cache" -m "Reads and membership lookups come from a Map loaded at boot and kept in step after each store write, the same one-directional invariant the annotation temp table has." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The four /api/favourites routes

**Files:**
- Modify: `server/src/routes.js` (imports at the top; a new section before the 404 catch-all)
- Test: `server/test/favourites-routes.test.js`, `server/test/favourites-routes-uninitialised.test.js`

**Interfaces:**
- Consumes: everything from Tasks 2, 3 and 6.
- Produces: `GET /api/favourites`, `POST /api/favourites`, `PATCH /api/favourites/:id`, `DELETE /api/favourites/:id` per the spec's API table. Response entries carry `show_id`, `show_url` and `artist_id`, added by a local helper `withArchiveIds(entry)`.

- [ ] **Step 1: Write the failing route tests**

Create `server/test/favourites-routes.test.js`:

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
import { requireUser } from '../src/auth.js';
import { createSqliteStore } from '../src/annotations/sqlite.js';
import { setStore } from '../src/annotations/index.js';
import { createAnnotationTable } from '../src/annotations/temp-table.js';
import { createSqliteFavourites } from '../src/favourites/sqlite.js';
import { setFavouritesStore, loadFavourites } from '../src/favourites/index.js';
import { entryId } from '../src/favourites/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CSV = path.join(__dirname, 'fixtures/csv');
const DEV_USER = 'dev@localhost';

let server, base, store, favourites, handle;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-favroutes-'));
  const out = path.join(dir, 'test.sqlite');
  buildDatabase({ csvDir: FIXTURE_CSV, outPath: out });
  handle = openDb(out);
  createAnnotationTable(handle);

  store = createSqliteStore(path.join(dir, 'annotations.sqlite'));
  setStore(store);
  favourites = createSqliteFavourites(path.join(dir, 'annotations.sqlite'));
  setFavouritesStore(favourites);
  loadFavourites(new Map());

  const app = express();
  app.use(express.json());
  app.use('/api', requireUser({ devEmail: DEV_USER }), routes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.code === 'ANNOTATION_STORE_UNAVAILABLE' ? 502 : 500;
    res.status(status).json({ error: err.message });
  });
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); store?.close(); favourites?.close(); handle?.close(); });

const send = async (method, p, body) => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const post = b => send('POST', '/api/favourites', b);
const trackId = title => handle.prepare('SELECT id FROM tracks WHERE title = ?').get(title).id;
const artistId = name => handle.prepare('SELECT id FROM artists WHERE name = ?').get(name).id;
const showId = cid => handle.prepare('SELECT id FROM shows WHERE content_id = ?').get(cid).id;

/* ---------------------------------- POST ---------------------------------- */

test('POST creates a show entry with live archive ids, then answers 200 for a repeat', async () => {
  const first = await post({ kind: 'show', content_id: 1610000001 });
  assert.equal(first.status, 201);
  assert.equal(first.body.id, entryId('show', ['1610000001']));
  assert.equal(first.body.title, 'Testsaade. Esimene');
  assert.equal(first.body.show_id, showId(1610000001));
  assert.equal(first.body.show_url, 'https://r2.err.ee/1610000001/testsaade');
  assert.equal(first.body.artist_id, null);

  const again = await post({ kind: 'show', content_id: 1610000001 });
  assert.equal(again.status, 200);
  assert.equal(again.body.id, first.body.id);
});

test('POST creates a song entry from a track id', async () => {
  const r = await post({ kind: 'song', track_id: trackId('Õhtu jõuab') });
  assert.equal(r.status, 201);
  assert.equal(r.body.artist, 'Mägi');
  assert.equal(r.body.artist_id, artistId('Mägi'));
  assert.equal(r.body.show.content_id, 1610000001);
  assert.equal(r.body.show_id, showId(1610000001));
});

test('POST creates an artist entry and an album entry', async () => {
  const a = await post({ kind: 'artist', artist_id: artistId('Ansambel 50%') });
  assert.equal(a.status, 201);
  assert.equal(a.body.artist_id, artistId('Ansambel 50%'));
  assert.equal(a.body.show_id, null);

  const b = await post({ kind: 'album', artist: 'Mägi', title: 'Esimene plaat' });
  assert.equal(b.status, 201);
  assert.equal(b.body.kind, 'album');
  assert.equal(b.body.artist_id, artistId('Mägi'), 'a typed artist resolves when the archive knows it');
});

test('POST folds album case and whitespace into one entry', async () => {
  const first = await post({ kind: 'album', artist: 'The Beatles', title: 'Abbey Road' });
  assert.equal(first.status, 201);
  const second = await post({ kind: 'album', artist: '  the  beatles ', title: 'ABBEY ROAD' });
  assert.equal(second.status, 200);
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.body.artist, 'The Beatles', 'the first spelling is kept');
});

test('POST answers 404 for an archive id that does not exist', async () => {
  assert.equal((await post({ kind: 'show', content_id: 1 })).status, 404);
  assert.equal((await post({ kind: 'song', track_id: 999 })).status, 404);
  assert.equal((await post({ kind: 'artist', artist_id: 999 })).status, 404);
});

test('POST answers 400 for a bad body', async () => {
  for (const body of [
    { kind: 'series', content_id: 1 },
    { kind: 'show', content_id: '1610000001' },
    { kind: 'album', artist: '', title: 'x' },
    { kind: 'show', content_id: 1610000001, notes: 'x' },
    [],
  ]) {
    const { status, body: b } = await post(body);
    assert.equal(status, 400, JSON.stringify(body));
    assert.ok(b.error);
  }
});

/* ----------------------------------- GET ---------------------------------- */

test('GET lists newest first, with done and kind filters', async () => {
  const all = await send('GET', '/api/favourites');
  assert.equal(all.status, 200);
  assert.ok(Array.isArray(all.body));
  assert.ok(all.body.length >= 5);
  const dates = all.body.map(e => e.added_at);
  assert.deepEqual(dates, [...dates].sort().reverse());

  const songs = await send('GET', '/api/favourites?kind=song');
  assert.ok(songs.body.every(e => e.kind === 'song'));
  assert.equal(songs.body.length, 1);

  const open = await send('GET', '/api/favourites?done=false');
  assert.equal(open.body.length, all.body.length, 'nothing is done yet');
  const done = await send('GET', '/api/favourites?done=true');
  assert.deepEqual(done.body, []);
});

test('GET ignores an empty kind and rejects an unknown one', async () => {
  const empty = await send('GET', '/api/favourites?kind=');
  assert.equal(empty.status, 200);
  const bad = await send('GET', '/api/favourites?kind=series');
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /kind must be one of/);
});

/* ---------------------------------- PATCH --------------------------------- */

test('PATCH saves notes and done, and done_at follows done', async () => {
  const id = entryId('show', ['1610000001']);
  const notes = await send('PATCH', `/api/favourites/${id}`, { notes: 'leia üles' });
  assert.equal(notes.status, 200);
  assert.equal(notes.body.notes, 'leia üles');
  assert.equal(notes.body.show_id, showId(1610000001), 'live ids come back on a patch too');

  const done = await send('PATCH', `/api/favourites/${id}`, { done: true });
  assert.equal(done.body.done, true);
  assert.ok(done.body.done_at);
  assert.equal(done.body.notes, 'leia üles', 'a done patch keeps the notes');

  const listed = await send('GET', '/api/favourites?done=true');
  assert.deepEqual(listed.body.map(e => e.id), [id]);

  const undone = await send('PATCH', `/api/favourites/${id}`, { done: false });
  assert.equal(undone.body.done_at, null);
});

test('PATCH answers 400 for a bad id or body and 404 for an unknown id', async () => {
  assert.equal((await send('PATCH', '/api/favourites/nope', { done: true })).status, 400);
  const id = entryId('show', ['1610000001']);
  assert.equal((await send('PATCH', `/api/favourites/${id}`, { title: 'x' })).status, 400);
  assert.equal((await send('PATCH', `/api/favourites/${id}`, {})).status, 400);
  assert.equal((await send('PATCH', `/api/favourites/${'0'.repeat(24)}`, { done: true })).status, 404);
});

/* --------------------------------- DELETE --------------------------------- */

test('DELETE removes the entry, is idempotent, and a later PATCH answers 404', async () => {
  const id = entryId('album', ['mägi', 'esimene plaat']);
  assert.equal((await send('DELETE', `/api/favourites/${id}`)).status, 204);
  assert.equal((await send('DELETE', `/api/favourites/${id}`)).status, 204);
  const list = await send('GET', '/api/favourites');
  assert.ok(!list.body.some(e => e.id === id));
  assert.equal((await send('PATCH', `/api/favourites/${id}`, { done: true })).status, 404);
  assert.equal((await send('DELETE', '/api/favourites/nope')).status, 400);
});
```

Create `server/test/favourites-routes-uninitialised.test.js`:

```js
// Its own file for the same reason annotations-routes-uninitialised.test.js
// is: node --test isolates files in their own process, and this is the only
// way to see getFavouritesStore() in its never-set state.
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
import { requireUser } from '../src/auth.js';
import { createAnnotationTable } from '../src/annotations/temp-table.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CSV = path.join(__dirname, 'fixtures/csv');

let server, base, handle;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-favroutes-uninit-'));
  const out = path.join(dir, 'test.sqlite');
  buildDatabase({ csvDir: FIXTURE_CSV, outPath: out });
  handle = openDb(out);
  createAnnotationTable(handle);
  // setFavouritesStore() is deliberately never called.

  const app = express();
  app.use(express.json());
  app.use('/api', requireUser({ devEmail: 'dev@localhost' }), routes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.code === 'ANNOTATION_STORE_UNAVAILABLE' ? 502 : 500;
    res.status(status).json({ error: err.message });
  });
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); handle?.close(); });

const send = async (method, p, body) => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('GET with the store never initialised answers an empty list', async () => {
  const { status, body } = await send('GET', '/api/favourites');
  assert.equal(status, 200);
  assert.deepEqual(body, []);
});

test('POST with the store never initialised is 502, not 500', async () => {
  const { status, body } = await send('POST', '/api/favourites', { kind: 'show', content_id: 1610000001 });
  assert.equal(status, 502);
  assert.match(body.error, /favourites store not initialised/);
});

test('archive reads still work and carry a null favourite_id', async () => {
  const { status, body } = await send('GET', '/api/series/testshow/shows');
  assert.equal(status, 200);
  assert.equal(body.rows[0].favourite_id, null);
});
```

The last test in the uninitialised file passes only after Task 8; that is expected. Run it after Task 8 and note it in Task 8's verification.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/test/favourites-routes.test.js server/test/favourites-routes-uninitialised.test.js`
Expected: the POST, PATCH and DELETE tests fail with 404 bodies `{ error: 'not found' }` from the catch-all, the GET test fails on status 404, the uninitialised GET fails with 404 and the POST with 404 instead of 502.

- [ ] **Step 3: Write the routes**

In `server/src/routes.js`, add after the existing imports:

```js
import {
  getFavouritesStore, listFavourites, setFavourite, deleteFavourite, favouriteIdOf,
} from './favourites/index.js';
import {
  KINDS, isEntryId, validateAdd, resolveAdd, validatePatch as validateFavouritePatch,
} from './favourites/store.js';
```

Then insert this section after the annotation DELETE handler and before the `router.use((_req, res) => res.status(404)...)` catch-all:

```js
/* ------------------------------- favourites -------------------------------- */

/**
 * Entries snapshot their names so they survive a rebuild; the archive ids the
 * client needs for links are looked up fresh on every read and may be null
 * when the archive no longer has the row.
 */
function withArchiveIds(entry) {
  const show = entry.show
    ? db().prepare('SELECT id, url FROM shows WHERE content_id = ?').get(entry.show.content_id)
    : null;
  const artist = entry.artist_norm
    ? db().prepare('SELECT id FROM artists WHERE name_norm = ?').get(entry.artist_norm)
    : null;
  return {
    ...entry,
    show_id: show?.id ?? null,
    show_url: show?.url ?? null,
    artist_id: artist?.id ?? null,
  };
}

router.get('/favourites', (req, res, next) => {
  try {
    const { done, kind } = req.query;
    // An empty kind means "all": api.js drops empty params, and a hand-typed
    // `?kind=` should not be an error.
    if (kind && !KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
    }
    let rows = listFavourites();
    if (done === 'true') rows = rows.filter(e => e.done);
    if (done === 'false') rows = rows.filter(e => !e.done);
    if (kind) rows = rows.filter(e => e.kind === kind);
    res.json(rows.map(withArchiveIds));
  } catch (e) { next(e); }
});

router.post('/favourites', async (req, res, next) => {
  try {
    const check = validateAdd(req.body);
    if (!check.ok) return res.status(400).json({ error: check.error });
    const candidate = resolveAdd(db(), check.add);
    if (!candidate) return res.status(404).json({ error: 'not found' });

    // Store first, cache second, with the same accepted gap as the annotation
    // PATCH handler above. add() is create-only, so a cache that lags the
    // store cannot make a repeat add overwrite notes or the done state.
    const { created, entry } = await getFavouritesStore().add(req.user.email, candidate);
    setFavourite(entry);
    res.status(created ? 201 : 200).json(withArchiveIds(entry));
  } catch (e) { next(e); }
});

function requireEntryId(req, res) {
  if (!isEntryId(req.params.id)) {
    res.status(400).json({ error: 'id must be 24 lowercase hex characters' });
    return null;
  }
  return req.params.id;
}

router.patch('/favourites/:id', async (req, res, next) => {
  try {
    const id = requireEntryId(req, res);
    if (id === null) return;
    const check = validateFavouritePatch(req.body);
    if (!check.ok) return res.status(400).json({ error: check.error });

    // merge() asks the store, not the cache, whether the id exists: the
    // store is the authority, and the cache may lag it.
    const merged = await getFavouritesStore().merge(req.user.email, id, check.patch);
    if (!merged) return res.status(404).json({ error: 'not found' });
    setFavourite(merged);
    res.json(withArchiveIds(merged));
  } catch (e) { next(e); }
});

router.delete('/favourites/:id', async (req, res, next) => {
  try {
    const id = requireEntryId(req, res);
    if (id === null) return;
    await getFavouritesStore().remove(req.user.email, id);
    deleteFavourite(id);
    res.status(204).end();
  } catch (e) { next(e); }
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/test/favourites-routes.test.js server/test/favourites-routes-uninitialised.test.js`
Expected: every test in the routes file passes; in the uninitialised file the GET and POST tests pass and only "archive reads still work and carry a null favourite_id" fails (it needs Task 8).

Then run `npm test` and confirm nothing else broke.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes.js server/test/favourites-routes.test.js server/test/favourites-routes-uninitialised.test.js
git commit -m "Add the /api/favourites routes" -m "List from the cache with done and kind filters, add by archive id or free-text album, patch notes and done, delete idempotently. Reads decorate entries with live archive ids for links." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: favourite_id on the archive routes

**Files:**
- Modify: `server/src/routes.js` (the series shows, show, tracks, artists and artist handlers)
- Test: `server/test/favourites-routes.test.js` (append)

**Interfaces:**
- Consumes: `favouriteIdOf` (Task 6), `norm` (already imported in routes.js).
- Produces: `favourite_id: string | null` on each row of `GET /api/series/:slug/shows`, on `show` and each track of `GET /api/shows/:id`, on each row of `GET /api/tracks` and `GET /api/artists`, and on `artist` of `GET /api/artists/:id`.

- [ ] **Step 1: Write the failing tests**

Append to `server/test/favourites-routes.test.js`:

```js
/* ------------------------- membership on archive routes ------------------------- */

test('favourite_id marks a show on the series listing and the show page', async () => {
  const id = entryId('show', ['1610000001']);
  const listing = await send('GET', '/api/series/testshow/shows');
  const row = listing.body.rows.find(r => r.content_id === 1610000001);
  assert.equal(row.favourite_id, id);
  const other = listing.body.rows.find(r => r.content_id === 1610000003);
  assert.equal(other.favourite_id, null);

  const page = await send('GET', `/api/shows/${showId(1610000001)}`);
  assert.equal(page.body.show.favourite_id, id);
  assert.equal(page.body.show.title, 'Testsaade. Esimene', 'the show fields are untouched');
});

test('favourite_id marks a song on the show page and the tracks search', async () => {
  const id = entryId('song', ['mägi', 'õhtu jõuab']);
  const page = await send('GET', `/api/shows/${showId(1610000001)}`);
  const byTitle = Object.fromEntries(page.body.tracks.map(t => [t.title, t.favourite_id]));
  assert.equal(byTitle['Õhtu jõuab'], id);
  assert.equal(byTitle['Teine lugu'], null);

  const search = await send('GET', '/api/tracks?q=jõuab');
  assert.equal(search.body.rows[0].favourite_id, id);
});

test('favourite_id marks a song whose track has no artist', async () => {
  const r = await post({ kind: 'song', track_id: trackId('Nimeta lugu') });
  assert.equal(r.status, 201);
  const page = await send('GET', `/api/shows/${showId(1610000001)}`);
  const t = page.body.tracks.find(t => t.title === 'Nimeta lugu');
  assert.equal(t.favourite_id, r.body.id);
});

test('favourite_id marks an artist on the list and the artist page', async () => {
  const id = entryId('artist', ['ansambel 50%']);
  const list = await send('GET', '/api/artists');
  const byName = Object.fromEntries(list.body.rows.map(a => [a.name, a.favourite_id]));
  assert.equal(byName['Ansambel 50%'], id);
  assert.equal(byName['Mägi'], null);

  const page = await send('GET', `/api/artists/${artistId('Ansambel 50%')}`);
  assert.equal(page.body.artist.favourite_id, id);
});

test('favourite_id goes back to null after a delete', async () => {
  const id = entryId('artist', ['ansambel 50%']);
  assert.equal((await send('DELETE', `/api/favourites/${id}`)).status, 204);
  const page = await send('GET', `/api/artists/${artistId('Ansambel 50%')}`);
  assert.equal(page.body.artist.favourite_id, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/test/favourites-routes.test.js`
Expected: the five new tests fail with `undefined` where an id or null was expected.

- [ ] **Step 3: Mark the rows**

In `server/src/routes.js`, add these helpers near the top, after the `needle` helper:

```js
// Membership in the favourites cache, computed from the row's display fields.
// norm() here gives the same strings the importer put in the *_norm columns,
// so recomputing is equivalent to selecting them and leaves the SQL alone.
const markShow = row => ({ ...row, favourite_id: favouriteIdOf('show', [String(row.content_id)]) });
const markSong = row =>
  ({ ...row, favourite_id: favouriteIdOf('song', [norm(row.artist), norm(row.title)]) });
const markArtist = row => ({ ...row, favourite_id: favouriteIdOf('artist', [norm(row.name)]) });
```

`norm(null)` is `''` (see normalize.js: `(s || '')`), which is exactly what `newEntry` stores for a track with no artist.

Then apply them:

- `GET /series/:slug/shows`: change `rows: rows.map(withAnnotation)` to `rows: rows.map(withAnnotation).map(markShow)`.
- `GET /shows/:id`: change `res.json({ show: rest, tracks, annotation })` to `res.json({ show: markShow(rest), tracks: tracks.map(markSong), annotation })`.
- `GET /tracks`: change `res.json({ rows, total, page: p, pageSize: ps })` to `res.json({ rows: rows.map(markSong), total, page: p, pageSize: ps })`.
- `GET /artists`: same change with `markArtist`.
- `GET /artists/:id`: change `res.json({ artist, tracks })` to `res.json({ artist: markArtist(artist), tracks })`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/test/favourites-routes.test.js server/test/favourites-routes-uninitialised.test.js`
Expected: all pass, including the uninitialised file's "archive reads still work and carry a null favourite_id".

Run `npm test`: the existing `routes.test.js` and annotation suites must still pass; they do not assert the absence of extra fields.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes.js server/test/favourites-routes.test.js
git commit -m "Mark favourites on the archive routes" -m "Rows carry favourite_id computed from the in-process cache after the query, so the pages can show the current state without a join or a second request." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Boot wiring

**Files:**
- Modify: `server/src/index.js` (imports; the non-fatal store block near the bottom)

**Interfaces:**
- Consumes: `createFavouritesStore`, `setFavouritesStore`, `loadFavourites` (Task 6).

- [ ] **Step 1: Wire the store into boot**

Add to the imports in `server/src/index.js`:

```js
import { createFavouritesStore, setFavouritesStore, loadFavourites } from './favourites/index.js';
```

Replace the existing non-fatal block:

```js
try {
  const store = await createStore();
  setStore(store);

  if (owner) {
    loadAnnotations(handle, await store.list(owner));
  }
} catch (err) {
  console.error(`annotation store unavailable at boot: ${err.message}`);
}
```

with:

```js
// Non-fatal: both personal stores are a layer on top of the archive, not the
// archive itself. If either fails here the archive stays readable; annotation
// and favourites writes answer 502 through their getStore() paths, and the
// favourites cache stays empty until the next boot.
try {
  const store = await createStore();
  setStore(store);
  const favourites = await createFavouritesStore();
  setFavouritesStore(favourites);

  if (owner) {
    loadAnnotations(handle, await store.list(owner));
    loadFavourites(await favourites.list(owner));
  }
} catch (err) {
  console.error(`personal store unavailable at boot: ${err.message}`);
}
```

Keep the existing explanatory comment above the block (the one starting "Non-fatal: annotations are a personal layer") merged with the new one; one comment, not two saying the same thing.

- [ ] **Step 2: Smoke the boot**

Run from the repo root. The server is started directly with node, not through npm, so the final `kill` reaches the process that holds the port:

```bash
PORT=3999 ANNOTATIONS_DB=/tmp/tlb-smoke/annotations.sqlite node server/src/index.js & PID=$!
sleep 3
curl -s http://localhost:3999/healthz
curl -s http://localhost:3999/api/favourites
curl -s -X POST -H 'content-type: application/json' -d '{"kind":"show","content_id":1610002554}' http://localhost:3999/api/favourites
curl -s http://localhost:3999/api/shows/6 | head -c 300
kill $PID
```

Expected: `{"ok":true,...}`, `[]`, a 201 body with `"kind":"show"`, and the show payload containing `"favourite_id":"<24 hex>"`. The content id 1610002554 is show 6 in the committed archive; if it has changed, pick any `content_id` from `/api/series/eesti_pops/shows`.

- [ ] **Step 3: Run the suite and commit**

Run: `npm test`
Expected: green.

```bash
git add server/src/index.js
git commit -m "Load favourites at boot next to annotations" -m "Same non-fatal block: a failing store leaves the archive readable and the favourites cache empty." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Client foundation: api, lookup links, button, album form, the page

**Files:**
- Modify: `client/src/api.js`, `client/src/App.jsx`, `client/src/styles.css`
- Create: `client/src/lookup.js`, `client/src/components/FavouriteButton.jsx`, `client/src/components/AddAlbum.jsx`, `client/src/pages/Favourites.jsx`

**Interfaces:**
- Consumes: the four routes from Task 7, entry fields from the spec, `show_id`, `show_url`, `artist_id`.
- Produces:
  - `api.favourites(params)`, `api.addFavourite(body)`, `api.patchFavourite(id, patch)`, `api.deleteFavourite(id)`
  - `lookupLinks(entry) -> [{ label, href }]`
  - `<FavouriteButton favouriteId add name />`
  - `<AddAlbum artist? onAdded? />`

- [ ] **Step 1: api.js**

Add four lines to the `api` object in `client/src/api.js`, after `deleteAnnotation`:

```js
  favourites:       (p)            => get('/favourites', p),
  addFavourite:     (body)         => send('POST', '/favourites', body),
  patchFavourite:   (id, patch)    => send('PATCH', `/favourites/${id}`, patch),
  deleteFavourite:  (id)           => send('DELETE', `/favourites/${id}`),
```

- [ ] **Step 2: lookup.js**

Create `client/src/lookup.js`:

```js
const MB_TYPE = { song: 'recording', artist: 'artist', album: 'release' };

/**
 * Where to go looking for an entry elsewhere. Computed from the names, never
 * stored: the URLs are search pages, and a later metadata fetch may replace
 * them with real release links.
 */
export function lookupLinks(entry) {
  if (entry.kind === 'show') {
    return entry.show_url ? [{ label: 'ERR', href: entry.show_url }] : [];
  }
  const q = encodeURIComponent([entry.artist, entry.title].filter(Boolean).join(' '));
  return [
    { label: 'Spotify', href: `https://open.spotify.com/search/${q}` },
    { label: 'Discogs', href: `https://www.discogs.com/search/?q=${q}&type=all` },
    { label: 'Bandcamp', href: `https://bandcamp.com/search?q=${q}` },
    { label: 'MusicBrainz',
      href: `https://musicbrainz.org/search?query=${q}&type=${MB_TYPE[entry.kind]}&method=indexed` },
  ];
}
```

- [ ] **Step 3: FavouriteButton.jsx**

Create `client/src/components/FavouriteButton.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Add-or-remove toggle for one show, song, artist or album. Keeps the entry
 * id locally after a save, so the page it sits on never has to refetch.
 *
 * `add` is the POST body for this thing; `name` is what to call it in the
 * accessible label.
 */
export default function FavouriteButton({ favouriteId, add, name }) {
  const [id, setId] = useState(favouriteId ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // A page reload hands in a fresh prop; a save does not, so local state wins
  // between reloads.
  useEffect(() => { setId(favouriteId ?? null); }, [favouriteId]);

  async function toggle() {
    setSaving(true);
    setError(null);
    try {
      if (id) {
        await api.deleteFavourite(id);
        setId(null);
      } else {
        const entry = await api.addFavourite(add);
        setId(entry.id);
      }
    } catch (err) {
      // Keep the current state; the error says why nothing changed.
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const on = Boolean(id);
  return (
    <span className="fav-wrap">
      <button type="button" className={on ? 'fav on' : 'fav'} disabled={saving}
              aria-pressed={on}
              aria-label={on ? `Remove ${name} from favourites` : `Add ${name} to favourites`}
              onClick={toggle}>
        {on ? '★ Favourited' : '☆ Favourite'}
      </button>
      {error && <span className="err fav-err">{error}</span>}
    </span>
  );
}
```

- [ ] **Step 4: AddAlbum.jsx**

Create `client/src/components/AddAlbum.jsx`:

```jsx
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * The one free-text way into favourites: an album the archive knows nothing
 * about. With `artist` given (the Artist page) only the title is typed;
 * without it (the Favourites page) both fields are.
 */
export default function AddAlbum({ artist: fixedArtist = null, onAdded }) {
  const [artist, setArtist] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [added, setAdded] = useState(false);
  const timer = useRef(null);
  const artistValue = fixedArtist ?? artist;

  useEffect(() => () => clearTimeout(timer.current), []);

  async function submit(ev) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    setAdded(false);
    try {
      const entry = await api.addFavourite({ kind: 'album', artist: artistValue, title });
      setTitle('');
      if (!fixedArtist) setArtist('');
      setAdded(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setAdded(false), 2000);
      onAdded?.(entry);
    } catch (err) {
      // Keep the typed text; clearing it would lose the user's input.
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="controls" onSubmit={submit}
          aria-label={fixedArtist ? `Add an album by ${fixedArtist}` : 'Add an album'}>
      {!fixedArtist && (
        <input type="text" value={artist} placeholder="Artist" aria-label="Artist"
               onChange={e => setArtist(e.target.value)} />
      )}
      <input type="text" value={title}
             placeholder={fixedArtist ? `Album by ${fixedArtist}` : 'Album'}
             aria-label={fixedArtist ? 'Album title' : 'Album'}
             onChange={e => setTitle(e.target.value)} />
      <button type="submit" disabled={busy || !artistValue.trim() || !title.trim()}>
        {fixedArtist ? 'Add' : 'Add album'}
      </button>
      <span className="annotator-state">
        {added ? 'Added' : error ? <span className="err">{error}</span> : null}
      </span>
    </form>
  );
}
```

- [ ] **Step 5: Favourites.jsx**

Create `client/src/pages/Favourites.jsx`:

```jsx
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, fmtNum } from '../api.js';
import { useAsync } from '../components/useAsync.js';
import AddAlbum from '../components/AddAlbum.jsx';
import { lookupLinks } from '../lookup.js';

const VIEWS = [
  { key: 'open', label: 'Open', params: { done: 'false' } },
  { key: 'done', label: 'Done', params: { done: 'true' } },
  { key: 'all',  label: 'All',  params: {} },
];

const KINDS = [
  { value: '',       label: 'All kinds' },
  { value: 'show',   label: 'Shows' },
  { value: 'song',   label: 'Songs' },
  { value: 'artist', label: 'Artists' },
  { value: 'album',  label: 'Albums' },
];

const KIND_LABEL = { show: 'Show', song: 'Song', artist: 'Artist', album: 'Album' };

/** What to call an entry in labels: its title, or the artist for an artist entry. */
const nameOf = e => e.title ?? e.artist ?? e.kind;

export default function Favourites() {
  const [view, setView] = useState('open');
  const [kind, setKind] = useState('');
  const params = { ...VIEWS.find(v => v.key === view).params, ...(kind ? { kind } : {}) };
  const list = useAsync(() => api.favourites(params), [view, kind]);

  // A local copy of the rows, so a save or a remove updates one row in place
  // and a done tick under the Open view stays visible until the next fetch.
  const [rows, setRows] = useState([]);
  useEffect(() => { if (list.data) setRows(list.data); }, [list.data]);

  const replace = entry => setRows(rs => rs.map(r => (r.id === entry.id ? entry : r)));
  const drop = id => setRows(rs => rs.filter(r => r.id !== id));
  // A new album is open, so show the Open view and let the server list it.
  const onAdded = () => { setView('open'); setKind(''); list.reload(); };

  if (list.error) return <p className="err">{list.error.message}</p>;
  if (list.loading && rows.length === 0) return <p className="empty">Loading…</p>;

  return (
    <>
      <h1>Favourites</h1>
      <p className="sub">{fmtNum(rows.length)} entries</p>

      <AddAlbum onAdded={onAdded} />

      <div className="filters">
        <span className="group" role="group" aria-label="View">
          {VIEWS.map(v => (
            <button key={v.key} type="button"
                    className={v.key === view ? 'chip on' : 'chip'}
                    aria-pressed={v.key === view}
                    onClick={() => setView(v.key)}>{v.label}</button>
          ))}
        </span>
        <select value={kind} onChange={e => setKind(e.target.value)} aria-label="Kind">
          {KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
      </div>

      {rows.length === 0 ? (
        <p className="empty">
          Nothing here yet. Use the star on a show, a song or an artist to start this list.
        </p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Kind</th><th>What</th><th>Find on</th><th>Notes</th><th>Done</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map(r => <Row key={r.id} entry={r} onChange={replace} onRemove={drop} />)}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function What({ entry: e }) {
  const artist = e.artist_id
    ? <Link to={`/artists/${e.artist_id}`}>{e.artist}</Link>
    : (e.artist ?? <span style={{ color: 'var(--muted)' }}>unknown</span>);
  const showLink = e.show && (e.show_id
    ? <Link to={`/shows/${e.show_id}`}>{e.show.title}</Link>
    : e.show.title);

  if (e.kind === 'show') {
    return (
      <>
        {showLink}
        <span className="sub-line">{fmtDate(e.show.show_date)} · {e.show.series_name}</span>
      </>
    );
  }
  if (e.kind === 'artist') return artist;
  return (
    <>
      {artist} – {e.title}
      {e.kind === 'song' && e.show && (
        <span className="sub-line">
          heard in {showLink} · {fmtDate(e.show.show_date)} · {e.show.series_name}
        </span>
      )}
    </>
  );
}

function Row({ entry: e, onChange, onRemove }) {
  const [notes, setNotes] = useState(e.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const timer = useRef(null);
  // The debounced notes text not yet sent, flushed on unmount (see below).
  const pending = useRef(null);
  // Guards against out-of-order PATCH responses, as the Annotator does.
  const seq = useRef(0);

  async function save(patch) {
    const mine = ++seq.current;
    setSaving(true);
    setError(null);
    try {
      const next = await api.patchFavourite(e.id, patch);
      if (mine !== seq.current) return;
      onChange(next);
    } catch (err) {
      if (mine !== seq.current) return;
      // Leave the field as typed; the error says why it did not save.
      setError(err.message);
    } finally {
      if (mine === seq.current) setSaving(false);
    }
  }

  function onNotes(text) {
    setNotes(text);
    pending.current = text;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      pending.current = null;
      save({ notes: text });
    }, 600);
  }

  useEffect(() => () => {
    clearTimeout(timer.current);
    // Navigating away mid-debounce must not drop the note: call the API
    // directly, never touch state on an unmounted row.
    if (pending.current !== null) {
      api.patchFavourite(e.id, { notes: pending.current }).catch(() => {});
    }
  }, []);

  async function remove() {
    setSaving(true);
    setError(null);
    try {
      await api.deleteFavourite(e.id);
      onRemove(e.id);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  const name = nameOf(e);
  return (
    <tr>
      <td>{KIND_LABEL[e.kind]}</td>
      <td><What entry={e} /></td>
      <td>
        <span className="links">
          {lookupLinks(e).map(l => (
            <a key={l.label} href={l.href} target="_blank" rel="noreferrer">{l.label}</a>
          ))}
        </span>
      </td>
      <td>
        <textarea className="notes notes-small" rows={2} value={notes} placeholder="Notes…"
                  aria-label={`Notes for ${name}`}
                  onChange={ev => onNotes(ev.target.value)} />
        <span className="annotator-state">
          {saving ? 'Saving…' : error ? <span className="err">{error}</span> : null}
        </span>
      </td>
      <td>
        <input type="checkbox" checked={e.done} aria-label={`Done: ${name}`}
               onChange={ev => save({ done: ev.target.checked })} />
      </td>
      <td>
        <button type="button" className="chip" disabled={saving}
                aria-label={`Remove ${name} from favourites`}
                onClick={remove}>Remove</button>
      </td>
    </tr>
  );
}
```

- [ ] **Step 6: Route and nav**

In `client/src/App.jsx`: add `import Favourites from './pages/Favourites.jsx';`, a `<NavLink to="/favourites">Favourites</NavLink>` after the Mine link, and `<Route path="/favourites" element={<Favourites />} />` after the Mine route.

- [ ] **Step 7: Styles**

Append to `client/src/styles.css`:

```css
.fav { font: inherit; font-size: .85rem; padding: .25rem .7rem; cursor: pointer;
       border: 1px solid var(--line); border-radius: 6px; background: transparent;
       color: inherit; white-space: nowrap; }
.fav.on { color: var(--accent); border-color: var(--accent); }
.fav:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.fav-wrap { display: inline-flex; align-items: center; gap: .5rem; }
.fav-err { font-size: .85rem; }
.links { display: inline-flex; gap: .6rem; font-size: .85rem; white-space: nowrap; }
.notes-small { min-width: 220px; font-size: .9rem; }
.sub-line { display: block; color: var(--muted); font-size: .85rem; }
.group { display: inline-flex; gap: .4rem; flex-wrap: wrap; }
```

- [ ] **Step 8: Build**

Run: `npm run build`
Expected: Vite reports the modules transformed and "built in"; no errors or warnings about unused imports.

- [ ] **Step 9: Commit**

```bash
git add client/src/api.js client/src/lookup.js client/src/components/FavouriteButton.jsx client/src/components/AddAlbum.jsx client/src/pages/Favourites.jsx client/src/App.jsx client/src/styles.css
git commit -m "Add the Favourites page, button and album form" -m "The list page renders from the entry snapshots with live links, saves notes on a debounce and keeps a ticked row visible until the next fetch. The button keeps its id locally so no page refetches." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Buttons on the show, artist and tracks pages; badges on list rows

**Files:**
- Modify: `client/src/pages/Show.jsx`, `client/src/pages/Artist.jsx`, `client/src/pages/Tracks.jsx`, `client/src/pages/SeriesShows.jsx`, `client/src/pages/Mine.jsx`, `client/src/pages/Artists.jsx`

**Interfaces:**
- Consumes: `FavouriteButton`, `AddAlbum` (Task 10); `favourite_id` on rows (Task 8).

- [ ] **Step 1: Show page**

In `client/src/pages/Show.jsx`: import `FavouriteButton from '../components/FavouriteButton.jsx'`. Between the `<p className="sub">` block and `<Annotator ...>`, add:

```jsx
      <div className="annotator-row">
        <FavouriteButton favouriteId={show.favourite_id}
                         add={{ kind: 'show', content_id: show.content_id }}
                         name={show.title} />
      </div>
```

In the tracks table add an empty last header `<th></th>` and, per row, after the title cell:

```jsx
                  <td>
                    <FavouriteButton favouriteId={t.favourite_id}
                                     add={{ kind: 'song', track_id: t.id }}
                                     name={`${t.artist ?? 'unknown'} – ${t.title}`} />
                  </td>
```

- [ ] **Step 2: Artist page**

In `client/src/pages/Artist.jsx`: import `FavouriteButton` and `AddAlbum`. After the `<p className="sub">` line add:

```jsx
      <div className="annotator-row">
        <FavouriteButton favouriteId={artist.favourite_id}
                         add={{ kind: 'artist', artist_id: artist.id }}
                         name={artist.name} />
        <AddAlbum artist={artist.name} />
      </div>
```

- [ ] **Step 3: Tracks page**

In `client/src/pages/Tracks.jsx`: import `FavouriteButton`. Add an empty last `<th></th>` and, per row, after the date cell:

```jsx
                    <td>
                      <FavouriteButton favouriteId={r.favourite_id}
                                       add={{ kind: 'song', track_id: r.id }}
                                       name={`${r.artist ?? 'unknown'} – ${r.title}`} />
                    </td>
```

- [ ] **Step 4: Badges**

In `client/src/pages/SeriesShows.jsx`, change `StateBadge` to take the favourite id too:

```jsx
export function StateBadge({ annotation: a, favouriteId = null }) {
  // (keep the existing comment)
  const hasState = favouriteId || (a && (a.listened || a.want_to_listen || a.notes));
  if (!hasState) return null;
  return (
    <span className="badges">
      {a?.listened && <span className="badge" title="Listened" aria-label="Listened">✓</span>}
      {a?.want_to_listen && (
        <span className="badge" title="Want to listen" aria-label="Want to listen">☆</span>
      )}
      {a?.notes && <span className="badge" title="Has notes" aria-label="Has notes">✎</span>}
      {favouriteId && (
        <span className="badge" title="In favourites" aria-label="In favourites">★</span>
      )}
    </span>
  );
}
```

and pass it: `<StateBadge annotation={r.annotation} favouriteId={r.favourite_id} />` in `SeriesShows.jsx` and in `Mine.jsx`.

In `client/src/pages/Artists.jsx`, after the artist link in each row:

```jsx
                    {r.favourite_id && (
                      <span className="badges">
                        <span className="badge" title="In favourites" aria-label="In favourites">★</span>
                      </span>
                    )}
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/Show.jsx client/src/pages/Artist.jsx client/src/pages/Tracks.jsx client/src/pages/SeriesShows.jsx client/src/pages/Mine.jsx client/src/pages/Artists.jsx
git commit -m "Put the favourite button on the show, artist and tracks pages" -m "Each track row on a show page gets its own button, which is the control that started this work. List pages get a star badge instead of a button to stay lean." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Documentation

**Files:**
- Modify: `README.md`, `docs/database.md`, `AGENTS.md`

- [ ] **Step 1: README**

In the Annotations section of `README.md`, after the paragraph that ends "see the comment on `max_instances` in `infra/variables.tf` for the full reasoning." and before the environment variable table, add:

```markdown
### Favourites

A second personal list sits next to annotations: shows, songs, artists and
albums to follow up on elsewhere, each with a note, a done state and lookup
links to Spotify, Discogs, Bandcamp and MusicBrainz computed from its artist
and title. It is a different job from the queue: the queue is "listen to this
episode in the archive", favourites is "go find this music".

```
annotations/{email}/favourites/{id}
  kind, artist, title, artist_norm, title_norm, show, notes, done, done_at,
  added_at, updated_at, meta
```

Entries are keyed on a hash of their kind and a natural identity, not on an
archive id: `content_id` for a show, normalised artist and title for a song or
an album, normalised name for an artist. The same song played in five episodes
is one entry, and a rebuild of the archive orphans nothing because each entry
snapshots the names and the episode it was added from. Only albums are typed
in; everything else is added from an archive row and the server fills in the
names.

Favourites are not joined in SQL. At boot the server loads the list into an
in-process Map, writes go to the durable store first and the Map second (the
same rule as the temp table), and archive routes mark rows with `favourite_id`
by looking the Map up after the query. `meta` is reserved for a later metadata
fetch and is always `null` today. The design is in
`docs/superpowers/specs/2026-10-16-favourites-design.md`.
```

In the API table add, after the `/api/artists/:id` row:

```markdown
| GET | `/api/favourites` | the owner's list, newest first; `?done=true|false&kind=` |
| POST | `/api/favourites` | `{kind:'show',content_id}`, `{kind:'song',track_id}`, `{kind:'artist',artist_id}` or `{kind:'album',artist,title}`; 201 new, 200 existing |
| PATCH | `/api/favourites/:id` | `{notes?, done?}` |
| DELETE | `/api/favourites/:id` | 204, idempotent |
```

In the feature list near the top, directly after the line

```markdown
* **Annotations** — Firestore; listened / notes / want to listen, keyed on `content_id`
```

add the sibling bullet:

```markdown
* **Favourites** — Firestore; shows, songs, artists and albums to follow up on, keyed on a hash of their natural identity
```

- [ ] **Step 2: docs/database.md**

- In the intro table, add a row: `| **The favourites store** | one person's list of shows, songs, artists and albums to follow up on | Firestore in production, the same \`data/annotations.sqlite\` locally | the API, on every favourites write |` and a row for the cache: `| **The favourites cache** | a copy of the owner's favourites for reads and membership | a \`Map\` in process | loaded at boot, updated after each successful store write |`.
- Add a new section `## 5. The favourites store` before `## 5. Changing the schema`, and renumber that one to `## 6.`. The section holds: the entry shape (copy the block from the spec's "The entry"), the identity table, the Firestore path, the SQLite DDL (copy from `server/src/favourites/sqlite.js`), the store interface, and a subsection "The cache" that states the invariants: loaded at boot from `store.list(owner)`, store first then cache on every write, never leads the store, a boot reconciles, `max_instances` stays 1, `add` is create-only and `merge` consults the store so a lagging cache cannot cause an overwrite or a false 404.
- In section 3 (Runtime access), the "Route | Reads | Order" table: add these rows after the `PATCH` and `DELETE /api/shows/:contentId/annotation` row:

```markdown
| `GET /api/favourites` | the favourites cache; then `shows` and `artists` for the live `show_id`, `show_url` and `artist_id` | `added_at` desc, then id |
| `POST /api/favourites` | `shows`, `tracks` or `artists`, to build the entry; then the store and the cache | |
| `PATCH` and `DELETE /api/favourites/:id` | the store, then the cache | |
```

  and after the table add one sentence: "`GET /api/series/:slug/shows`, `/api/shows/:id`, `/api/tracks`, `/api/artists` and `/api/artists/:id` also carry a `favourite_id` per row, computed from the favourites cache after the query (section 5)."

- [ ] **Step 3: AGENTS.md**

- Layout block: add `firestore-timeout.js` under `server/src/`, a `favourites/` subtree with `store.js`, `index.js`, `sqlite.js`, `firestore.js` and one-line descriptions, and under `client/src/` add `lookup.js` and `pages/Favourites.jsx`, and extend the components line with `FavouriteButton`, `AddAlbum`.
- "What this is": extend the annotation sentence with "and a favourites list of shows, songs, artists and albums".
- Invariants: add after invariant 6:

```markdown
11. **Favourites live in an in-process Map, not a temp table.** Loaded at boot
    from the store, kept in step store-first on every write, never joined in
    SQL. Archive routes compute `favourite_id` from the Map after the query.
    Entries key on a hash of kind plus natural identity (content_id, or
    normalised artist and title, or normalised name), never on shows.id,
    tracks.id or artists.id. `add` is create-only and `merge` consults the
    store, so a lagging cache cannot overwrite or falsely 404.
```

(Number it as the next free number if the list has changed.)

- "Do not": extend the "Loosen the validatePatch limits" bullet: `(notes 4000 characters; favourites album artist and title 200 characters each)`.
- Update the test count sentence to the new totals from `npm test`.
- Commands table: unchanged.

- [ ] **Step 4: Verify and commit**

Run: `npm test` and note the totals for AGENTS.md.

```bash
git add README.md docs/database.md AGENTS.md
git commit -m "Document the favourites list" -m "README gets the user-facing description and API rows, docs/database.md the store and cache reference, AGENTS.md the layout, the invariant and the limits." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Manual check on localhost and finish

**Files:** none.

- [ ] **Step 1: Rebuild the local container**

First confirm the running container holds nothing worth keeping (it has no volume):

```bash
docker exec tracklist-browser-app-1 node -e 'const D=require("better-sqlite3");const d=new D("/app/data/annotations.sqlite",{readonly:true});console.log(d.prepare("SELECT COUNT(*) AS n FROM annotations").get())'
```

If the count is not 0, stop and ask before rebuilding. Otherwise:

```bash
docker compose up -d --build
sleep 3
curl -s http://localhost:3000/healthz
curl -s http://localhost:3000/api/favourites
```

- [ ] **Step 2: Walk the pages**

Open in a browser and check each; a screenshot is not required but the behaviour is:

1. `http://localhost:3000/shows/6`: a "☆ Favourite" button under the subtitle and one per track row. Click one track's button: it turns into "★ Favourited" without the page reloading. Click it again: back to "☆ Favourite".
2. Favourite two tracks and the show. Open `http://localhost:3000/favourites`: three rows, newest first, kinds Show and Song, lookup links on the songs, an ERR link on the show, "heard in" lines on the songs linking back to the show.
3. Type a note on one row and wait a second: "Saving…" then nothing, reload the page, the note is still there. Tick Done on another row: it stays visible; switch to Done: it is listed; switch to Open: it is gone.
4. Add an album at the top: it appears under Open. Remove it with its Remove button.
5. Open an artist from a song row: "☆ Favourite" and the "Add an album by …" form in the header. Favourite the artist, add an album by title only, see "Added".
6. `http://localhost:3000/artists`: the favourited artist carries a ★ badge. `http://localhost:3000/series/eesti_pops`: the favourited show carries a ★ badge next to its other badges. `http://localhost:3000/tracks?` search for one of the favourited songs: its row shows "★ Favourited".
7. Keyboard: tab to a favourite button, press Space, it toggles; the screen-reader label reads "Add … to favourites" or "Remove … from favourites".

- [ ] **Step 3: Finish**

Run `npm test` and `npm run build` one last time on the final tree. Then invoke the superpowers:finishing-a-development-branch skill: the agreed integration is a merge into main with a merge commit in the style of the earlier ones (`Merge favourites: …`), a test run on the merged result, a push, and deletion of the branch locally and on origin.
