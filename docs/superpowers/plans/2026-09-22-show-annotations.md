# Show Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner record listened / rating / notes / tags / want-to-listen against any show, stored durably in Firestore, with the whole site behind Cloud Run direct IAP.

**Architecture:** A store module with two interchangeable drivers (Firestore in production, a local SQLite file for dev and tests) holds the annotations. At boot the server loads them into a `TEMP TABLE` on the existing read-only archive connection, so every route filters, sorts and paginates in SQL via a `LEFT JOIN` instead of merging in JavaScript. Writes go to the durable store first and update the temp row only on success. Identity comes from IAP's signed assertion header; there is no session, password or user table.

**Tech Stack:** Node 22 (ES modules), Express 4, `better-sqlite3` 13, `@google-cloud/firestore`, `jose` (ES256 JWT verification), React 18 + Vite, React Router, `node:test`, Terraform (`google` provider 8.3.0), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-22-show-annotations-design.md` (committed as `6b493ed`)

## Global Constraints

- Node 22+, ES modules throughout (`"type": "module"`). Use `import`, never `require`.
- Tests use Node's built-in `node:test` and `node:assert/strict`. **Do not add a test framework dependency.**
- `better-sqlite3` is **synchronous**. No `await` on any database call. The store and auth layers *are* async; the temp-table layer is not.
- The archive connection stays `{ readonly: true, fileMustExist: true }` (`server/src/db.js:20`). Never open it writable. Never write to `data/tracklists.sqlite`.
- Annotations key on **`content_id`** (ERR's episode id), never `shows.id`. `shows.id` is not stable across a rebuild.
- Booleans are stored as `INTEGER` 0/1 in SQLite and real booleans in Firestore. Timestamps are ISO-8601 `TEXT` in SQLite, compared lexicographically — matching `shows.show_date`.
- Auth fails **closed**. A missing, expired, wrong-audience, wrong-issuer or non-ES256 assertion is a rejection, never a fallback to an anonymous or default user.
- Diacritics are preserved, never stripped: `õ`, `ä`, `ö`, `ü` are distinct Estonian letters.
- Tests must be hermetic: no network, no cloud project, no emulator. The Firestore driver's tests skip themselves when credentials are absent.
- Work happens on branch `show-annotations`. Commit after every task.
- UI copy is in English, matching the existing client (`Loading…`, `open`, `listen on ERR`).

## Constants (exact values — do not re-derive)

```
IAP issuer         https://cloud.google.com/iap
IAP JWKS           https://www.gstatic.com/iap/verify/public_key-jwk
IAP algorithm      ES256                      (allowlist of exactly one)
IAP audience       /projects/PROJECT_NUMBER/locations/REGION/services/SERVICE_NAME
IAP header         x-goog-iap-jwt-assertion
Cloud Run marker   K_SERVICE                  (set by the platform, not by us)
```

The audience shape is **Cloud Run's**, and differs from the App Engine
(`/projects/N/apps/ID`) and backend-service
(`/projects/N/global/backendServices/ID`) forms that most published IAP sample
code uses. Copying a sample without changing this yields a check that passes
for the wrong service.

## Verified facts (already tested against the real archive — do not re-litigate)

| Fact | Result |
| --- | --- |
| `CREATE TEMP TABLE` on a readonly connection | works |
| `db.transaction()` wrapping temp-table writes on a readonly connection | works |
| `UPDATE` / `DELETE` on a temp row, readonly connection | works |
| `json_each()` over a temp-table JSON column, joined to `shows` | works (SQLite 3.53.4) |
| `ATTACH ':memory:'` on a readonly connection | **fails** — `attempt to write a readonly database` |
| `LEFT JOIN` unlistened filter across 2,696 shows | works |

Archive size: 7 series, 2,696 shows, 38,146 tracks, 19,563 artists.

## Out of scope — do not "fix" these

- **The `/api/artists` count mismatch.** The rows query joins through `tracks` so it returns only artists with plays; the `total` counts every matching artist. Pre-existing, unrelated, and noted in the previous plan as deliberate. Leave it.
- **Multi-user support.** The owner key is an email so that multi-user is a later change rather than a rewrite, but build no registration, roles or sharing.
- **Annotations on tracks or artists.** Shows only.
- **`build-db.js`, `importer.js`, `normalize.js`, `schema.sql`, `data/tracklists.sqlite`.** Untouched by this work.
- **Orphan cleanup** when a re-scrape drops an episode. Deliberately retained; a cleanup script is a later piece of work.

---

### Task 1: The annotation store — shape, validation, SQLite driver

The durable-storage seam. Everything later in the plan talks to this interface and never to a database client directly.

**Files:**
- Create: `server/src/annotations/store.js`
- Create: `server/src/annotations/sqlite.js`
- Create: `server/test/annotations-store.test.js`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `EMPTY` — the default annotation object, frozen
  - `validatePatch(body) => { ok: true, patch } | { ok: false, error: string }`
  - `applyPatch(current, patch) => Annotation` — field-level merge
  - `createSqliteStore(file) => Store`
  - `Store` = `{ list(owner), get(owner, contentId), merge(owner, contentId, patch), remove(owner, contentId), close() }`, all async except `close()`
  - `Annotation` = `{ listened: boolean, listened_at: string|null, rating: number|null, notes: string|null, want_to_listen: boolean, tags: string[], updated_at: string }`

- [ ] **Step 1: Write the failing tests**

Create `server/test/annotations-store.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePatch, applyPatch, EMPTY } from '../src/annotations/store.js';
import { createSqliteStore } from '../src/annotations/sqlite.js';

const tmpFile = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-ann-')), 'annotations.sqlite');

const OWNER = 'marko@example.com';

/* ------------------------------- validation ------------------------------- */

test('validatePatch accepts a full body', () => {
  const r = validatePatch({
    listened: true, rating: 4, notes: 'hea saade',
    want_to_listen: false, tags: ['suvi', 'intervjuu'],
  });
  assert.equal(r.ok, true);
  assert.equal(r.patch.rating, 4);
  assert.deepEqual(r.patch.tags, ['suvi', 'intervjuu']);
});

test('validatePatch keeps absent keys absent', () => {
  const r = validatePatch({ listened: true });
  assert.deepEqual(Object.keys(r.patch), ['listened']);
});

test('validatePatch rejects an empty body', () => {
  assert.equal(validatePatch({}).ok, false);
});

test('validatePatch rejects a rating outside 1..5', () => {
  for (const rating of [0, 6, -1, 2.5, '4']) {
    assert.equal(validatePatch({ rating }).ok, false, `rating ${rating}`);
  }
});

test('validatePatch accepts a null rating as "clear it"', () => {
  const r = validatePatch({ rating: null });
  assert.equal(r.ok, true);
  assert.equal(r.patch.rating, null);
});

test('validatePatch rejects notes over 4000 characters', () => {
  assert.equal(validatePatch({ notes: 'x'.repeat(4001) }).ok, false);
  assert.equal(validatePatch({ notes: 'x'.repeat(4000) }).ok, true);
});

test('validatePatch trims, dedupes and drops empty tags', () => {
  const r = validatePatch({ tags: ['  suvi ', 'suvi', '', '   ', 'talv'] });
  assert.deepEqual(r.patch.tags, ['suvi', 'talv']);
});

test('validatePatch preserves Estonian diacritics in tags', () => {
  const r = validatePatch({ tags: ['Mägi', 'õhtu'] });
  assert.deepEqual(r.patch.tags, ['Mägi', 'õhtu']);
});

test('validatePatch rejects too many or too long tags', () => {
  assert.equal(validatePatch({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }).ok, false);
  assert.equal(validatePatch({ tags: ['x'.repeat(41)] }).ok, false);
  assert.equal(validatePatch({ tags: 'suvi' }).ok, false);
});

test('validatePatch rejects unknown keys', () => {
  assert.equal(validatePatch({ listened: true, colour: 'red' }).ok, false);
});

/* --------------------------------- merge ---------------------------------- */

test('applyPatch changes only the keys present', () => {
  const current = { ...EMPTY, rating: 5, notes: 'keep me' };
  const next = applyPatch(current, { listened: true });
  assert.equal(next.listened, true);
  assert.equal(next.rating, 5, 'rating survives a listened-only patch');
  assert.equal(next.notes, 'keep me');
});

test('applyPatch treats explicit null as a clear', () => {
  const next = applyPatch({ ...EMPTY, rating: 5 }, { rating: null });
  assert.equal(next.rating, null);
});

test('applyPatch stamps listened_at when listened becomes true', () => {
  const next = applyPatch(EMPTY, { listened: true });
  assert.match(next.listened_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('applyPatch clears listened_at when listened becomes false', () => {
  const on = applyPatch(EMPTY, { listened: true });
  const off = applyPatch(on, { listened: false });
  assert.equal(off.listened_at, null);
});

test('applyPatch always moves updated_at', () => {
  const next = applyPatch({ ...EMPTY, updated_at: '2020-01-01T00:00:00.000Z' }, { rating: 3 });
  assert.notEqual(next.updated_at, '2020-01-01T00:00:00.000Z');
});

/* -------------------------------- the store -------------------------------- */

test('a fresh store lists nothing', async () => {
  const store = createSqliteStore(tmpFile());
  assert.equal((await store.list(OWNER)).size, 0);
  store.close();
});

test('merge upserts, then patches field by field', async () => {
  const store = createSqliteStore(tmpFile());

  const first = await store.merge(OWNER, 1610000001, { listened: true, rating: 5 });
  assert.equal(first.listened, true);
  assert.equal(first.rating, 5);

  const second = await store.merge(OWNER, 1610000001, { notes: 'hea' });
  assert.equal(second.notes, 'hea');
  assert.equal(second.rating, 5, 'earlier rating survives');
  assert.equal(second.listened, true);

  store.close();
});

test('list returns a Map keyed by numeric content_id', async () => {
  const store = createSqliteStore(tmpFile());
  await store.merge(OWNER, 1610000001, { listened: true });
  await store.merge(OWNER, 1610000002, { tags: ['suvi'] });

  const all = await store.list(OWNER);
  assert.equal(all.size, 2);
  assert.equal(all.get(1610000001).listened, true);
  assert.deepEqual(all.get(1610000002).tags, ['suvi']);

  store.close();
});

test('owners are isolated from each other', async () => {
  const store = createSqliteStore(tmpFile());
  await store.merge('a@example.com', 1610000001, { rating: 5 });
  await store.merge('b@example.com', 1610000001, { rating: 1 });

  assert.equal((await store.get('a@example.com', 1610000001)).rating, 5);
  assert.equal((await store.get('b@example.com', 1610000001)).rating, 1);

  store.close();
});

test('get returns null for an unannotated show', async () => {
  const store = createSqliteStore(tmpFile());
  assert.equal(await store.get(OWNER, 1610000009), null);
  store.close();
});

test('remove deletes the row', async () => {
  const store = createSqliteStore(tmpFile());
  await store.merge(OWNER, 1610000001, { listened: true });
  await store.remove(OWNER, 1610000001);
  assert.equal(await store.get(OWNER, 1610000001), null);
  store.close();
});

test('remove on a missing row is not an error', async () => {
  const store = createSqliteStore(tmpFile());
  await store.remove(OWNER, 1610000009);
  store.close();
});

test('the store survives being reopened', async () => {
  const file = tmpFile();
  const first = createSqliteStore(file);
  await first.merge(OWNER, 1610000001, { rating: 3, tags: ['suvi'] });
  first.close();

  const second = createSqliteStore(file);
  const row = await second.get(OWNER, 1610000001);
  assert.equal(row.rating, 3);
  assert.deepEqual(row.tags, ['suvi']);
  second.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern='validatePatch|applyPatch|store'`
Expected: FAIL — `Cannot find module '../src/annotations/store.js'`

- [ ] **Step 3: Write `store.js`**

Create `server/src/annotations/store.js`:

```js
/**
 * The annotation shape, its validation, and its merge rule. Both drivers
 * (sqlite.js, firestore.js) store exactly this object and nothing more.
 */

/** Every field at rest. Frozen: callers must copy before mutating. */
export const EMPTY = Object.freeze({
  listened: false,
  listened_at: null,
  rating: null,
  notes: null,
  want_to_listen: false,
  tags: [],
  updated_at: null,
});

const FIELDS = ['listened', 'rating', 'notes', 'want_to_listen', 'tags'];
const MAX_NOTES = 4000;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;

const bad = error => ({ ok: false, error });

/**
 * Validate a PATCH body. Only keys actually present are returned, which is what
 * makes a partial update partial: an absent key must not be confused with an
 * explicit null, which clears the field.
 */
export function validatePatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return bad('body must be an object');
  }

  const unknown = Object.keys(body).filter(k => !FIELDS.includes(k));
  if (unknown.length) return bad(`unknown field: ${unknown.join(', ')}`);

  const patch = {};

  for (const key of ['listened', 'want_to_listen']) {
    if (!(key in body)) continue;
    if (typeof body[key] !== 'boolean') return bad(`${key} must be a boolean`);
    patch[key] = body[key];
  }

  if ('rating' in body) {
    const r = body.rating;
    if (r !== null && (!Number.isInteger(r) || r < 1 || r > 5)) {
      return bad('rating must be an integer 1-5, or null');
    }
    patch.rating = r;
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

  if ('tags' in body) {
    if (!Array.isArray(body.tags)) return bad('tags must be an array');
    if (body.tags.some(t => typeof t !== 'string')) return bad('tags must be strings');

    // Trim, drop blanks, dedupe — order-preserving. Diacritics are left alone:
    // Mägi and Magi are different tags on purpose.
    const cleaned = [...new Set(body.tags.map(t => t.trim()).filter(Boolean))];
    if (cleaned.length > MAX_TAGS) return bad(`at most ${MAX_TAGS} tags`);
    if (cleaned.some(t => t.length > MAX_TAG_LEN)) {
      return bad(`each tag must be at most ${MAX_TAG_LEN} characters`);
    }
    patch.tags = cleaned;
  }

  if (Object.keys(patch).length === 0) return bad('no recognised fields to update');
  return { ok: true, patch };
}

/**
 * Field-level merge. Only keys present in `patch` move; everything else is
 * carried over untouched. This is what stops a debounced notes save from
 * reverting a rating set a moment earlier.
 */
export function applyPatch(current, patch, now = new Date()) {
  const next = { ...EMPTY, ...current, ...patch };
  next.tags = [...(patch.tags ?? current?.tags ?? [])];

  if ('listened' in patch) {
    next.listened_at = patch.listened ? now.toISOString() : null;
  }
  next.updated_at = now.toISOString();
  return next;
}

```

- [ ] **Step 4: Write `sqlite.js`**

Create `server/src/annotations/sqlite.js`:

```js
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { EMPTY, applyPatch } from './store.js';

const DDL = `
CREATE TABLE IF NOT EXISTS annotations (
  owner          TEXT    NOT NULL,
  content_id     INTEGER NOT NULL,
  listened       INTEGER NOT NULL DEFAULT 0,
  listened_at    TEXT,
  rating         INTEGER,
  notes          TEXT,
  want_to_listen INTEGER NOT NULL DEFAULT 0,
  tags           TEXT    NOT NULL DEFAULT '[]',
  updated_at     TEXT    NOT NULL,
  PRIMARY KEY (owner, content_id)
);`;

/** DB row -> Annotation. Booleans are 0/1 and tags are JSON text at rest. */
const toAnnotation = row => ({
  listened: !!row.listened,
  listened_at: row.listened_at,
  rating: row.rating,
  notes: row.notes,
  want_to_listen: !!row.want_to_listen,
  tags: JSON.parse(row.tags),
  updated_at: row.updated_at,
});

/**
 * The dev and test driver: a plain writable SQLite file, entirely separate from
 * the read-only archive. Scratch state — `data/annotations.sqlite` is gitignored.
 */
export function createSqliteStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const handle = new Database(file);
  handle.pragma('journal_mode = WAL');
  handle.exec(DDL);

  const selectOne = handle.prepare(
    'SELECT * FROM annotations WHERE owner = ? AND content_id = ?');
  const selectAll = handle.prepare(
    'SELECT * FROM annotations WHERE owner = ? ORDER BY content_id');
  const upsert = handle.prepare(`
    INSERT INTO annotations
      (owner, content_id, listened, listened_at, rating, notes, want_to_listen, tags, updated_at)
    VALUES
      (@owner, @content_id, @listened, @listened_at, @rating, @notes, @want_to_listen, @tags, @updated_at)
    ON CONFLICT (owner, content_id) DO UPDATE SET
      listened = excluded.listened, listened_at = excluded.listened_at,
      rating = excluded.rating, notes = excluded.notes,
      want_to_listen = excluded.want_to_listen, tags = excluded.tags,
      updated_at = excluded.updated_at`);
  const del = handle.prepare(
    'DELETE FROM annotations WHERE owner = ? AND content_id = ?');

  return {
    async list(owner) {
      return new Map(
        selectAll.all(owner).map(r => [Number(r.content_id), toAnnotation(r)]));
    },

    async get(owner, contentId) {
      const row = selectOne.get(owner, Number(contentId));
      return row ? toAnnotation(row) : null;
    },

    async merge(owner, contentId, patch) {
      const id = Number(contentId);
      const current = selectOne.get(owner, id);
      const next = applyPatch(current ? toAnnotation(current) : { ...EMPTY }, patch);
      upsert.run({
        owner,
        content_id: id,
        listened: next.listened ? 1 : 0,
        listened_at: next.listened_at,
        rating: next.rating,
        notes: next.notes,
        want_to_listen: next.want_to_listen ? 1 : 0,
        tags: JSON.stringify(next.tags),
        updated_at: next.updated_at,
      });
      return next;
    },

    async remove(owner, contentId) {
      del.run(owner, Number(contentId));
    },

    close() { handle.close(); },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all existing tests plus the new ones.

- [ ] **Step 6: Ignore the dev store**

Add to `.gitignore`, directly under the existing `data/*.sqlite` lines:

```
# Local annotation store for `npm run dev`. Production uses Firestore.
data/annotations.sqlite
data/annotations.sqlite-wal
data/annotations.sqlite-shm
```

The existing `!data/tracklists.sqlite` negation must stay **after** `data/*.sqlite` and is unaffected; verify with `git check-ignore -v data/annotations.sqlite` (ignored) and `git check-ignore -v data/tracklists.sqlite` (exit 1, not ignored).

- [ ] **Step 7: Commit**

```bash
git add server/src/annotations server/test/annotations-store.test.js .gitignore
git commit -m "feat: annotation store interface, validation and SQLite driver"
```

---

### Task 2: The temp table

Puts annotations inside the read-only archive connection so routes can join them in SQL. Verified to work; see "Verified facts" above.

**Files:**
- Create: `server/src/annotations/temp-table.js`
- Create: `server/test/annotations-temp-table.test.js`

**Interfaces:**
- Consumes: `Annotation` from Task 1
- Produces:
  - `createAnnotationTable(handle) => void`
  - `loadAnnotations(handle, map) => void` — replaces the whole table
  - `upsertAnnotationRow(handle, contentId, annotation) => void`
  - `removeAnnotationRow(handle, contentId) => void`
  - `ANNOTATION_COLUMNS` — the `SELECT` fragment routes reuse
  - `ANNOTATION_JOIN` — the `LEFT JOIN` fragment routes reuse

- [ ] **Step 1: Write the failing tests**

Create `server/test/annotations-temp-table.test.js`:

```js
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDatabase } from '../src/build-db.js';
import { openDb } from '../src/db.js';
import {
  createAnnotationTable, loadAnnotations,
  upsertAnnotationRow, removeAnnotationRow,
  ANNOTATION_COLUMNS, ANNOTATION_JOIN,
} from '../src/annotations/temp-table.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CSV = path.join(__dirname, 'fixtures/csv');

let handle;

const ann = over => ({
  listened: false, listened_at: null, rating: null, notes: null,
  want_to_listen: false, tags: [], updated_at: '2026-09-22T10:00:00.000Z', ...over,
});

before(() => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-tmp-')), 'test.sqlite');
  buildDatabase({ csvDir: FIXTURE_CSV, outPath: out });
  handle = openDb(out);
  createAnnotationTable(handle);
});

after(() => handle?.close());

test('the archive connection is still read-only', () => {
  assert.throws(
    () => handle.prepare('DELETE FROM shows').run(),
    /readonly/,
    'the temp table must not have made the archive writable');
});

test('loadAnnotations replaces the whole table', () => {
  loadAnnotations(handle, new Map([[1610000001, ann({ listened: true, rating: 5 })]]));
  assert.equal(handle.prepare('SELECT COUNT(*) n FROM annotations').get().n, 1);

  loadAnnotations(handle, new Map([[1610000002, ann({ rating: 2 })]]));
  const rows = handle.prepare('SELECT content_id FROM annotations').all();
  assert.deepEqual(rows.map(r => r.content_id), [1610000002], 'the earlier row is gone');
});

test('booleans round-trip as 0/1', () => {
  loadAnnotations(handle, new Map([[1610000001, ann({ listened: true, want_to_listen: false })]]));
  const row = handle.prepare('SELECT listened, want_to_listen FROM annotations').get();
  assert.equal(row.listened, 1);
  assert.equal(row.want_to_listen, 0);
});

test('upsertAnnotationRow inserts then updates one row', () => {
  loadAnnotations(handle, new Map());
  upsertAnnotationRow(handle, 1610000001, ann({ rating: 3 }));
  assert.equal(handle.prepare('SELECT rating FROM annotations WHERE content_id = 1610000001').get().rating, 3);

  upsertAnnotationRow(handle, 1610000001, ann({ rating: 5, notes: 'hea' }));
  const row = handle.prepare('SELECT rating, notes FROM annotations WHERE content_id = 1610000001').get();
  assert.equal(row.rating, 5);
  assert.equal(row.notes, 'hea');
  assert.equal(handle.prepare('SELECT COUNT(*) n FROM annotations').get().n, 1);
});

test('removeAnnotationRow deletes one row', () => {
  loadAnnotations(handle, new Map([[1610000001, ann({ listened: true })]]));
  removeAnnotationRow(handle, 1610000001);
  assert.equal(handle.prepare('SELECT COUNT(*) n FROM annotations').get().n, 0);
});

test('the join exposes annotation columns and nulls for unannotated shows', () => {
  loadAnnotations(handle, new Map([[1610000001, ann({ listened: true, rating: 4, tags: ['suvi'] })]]));
  const rows = handle.prepare(`
    SELECT sh.content_id, ${ANNOTATION_COLUMNS}
    FROM shows sh ${ANNOTATION_JOIN}
    ORDER BY sh.content_id`).all();

  const annotated = rows.find(r => r.content_id === 1610000001);
  assert.equal(annotated.listened, 1);
  assert.equal(annotated.rating, 4);
  assert.equal(annotated.tags, '["suvi"]');

  const untouched = rows.find(r => r.content_id !== 1610000001);
  assert.equal(untouched.listened, null, 'unannotated shows join to NULL');
});

test('unlistened filtering works in SQL', () => {
  loadAnnotations(handle, new Map([[1610000001, ann({ listened: true })]]));
  const n = handle.prepare(`
    SELECT COUNT(*) n FROM shows sh ${ANNOTATION_JOIN}
    WHERE COALESCE(a.listened, 0) = 0`).get().n;
  const total = handle.prepare('SELECT COUNT(*) n FROM shows').get().n;
  assert.equal(n, total - 1);
});

test('tag filtering works via json_each', () => {
  loadAnnotations(handle, new Map([
    [1610000001, ann({ tags: ['suvi', 'intervjuu'] })],
    [1610000002, ann({ tags: ['talv'] })],
  ]));
  const rows = handle.prepare(`
    SELECT sh.content_id FROM shows sh ${ANNOTATION_JOIN}, json_each(a.tags) j
    WHERE j.value = ?`).all('suvi');
  assert.deepEqual(rows.map(r => r.content_id), [1610000001]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern='temp table|join|annotation'`
Expected: FAIL — `Cannot find module '../src/annotations/temp-table.js'`

- [ ] **Step 3: Write `temp-table.js`**

Create `server/src/annotations/temp-table.js`:

```js
/**
 * Annotations live in a TEMP TABLE on the archive's read-only connection.
 *
 * SQLite keeps the temp database in a separate file from the main one, so
 * SQLITE_OPEN_READONLY does not forbid writing to it. (ATTACH ':memory:' *is*
 * forbidden — it fails with "attempt to write a readonly database".) The point
 * is that routes can LEFT JOIN annotations and keep WHERE, ORDER BY and
 * LIMIT/OFFSET in SQL. Merging annotations onto rows in JavaScript would
 * paginate the unfiltered set and hand back short pages.
 *
 * This table is per-connection and per-process. It is rebuilt at boot and kept
 * in step with the durable store on every write.
 */

const DDL = `
CREATE TEMP TABLE IF NOT EXISTS annotations (
  content_id     INTEGER PRIMARY KEY,
  listened       INTEGER NOT NULL DEFAULT 0,
  listened_at    TEXT,
  rating         INTEGER,
  notes          TEXT,
  want_to_listen INTEGER NOT NULL DEFAULT 0,
  tags           TEXT    NOT NULL DEFAULT '[]',
  updated_at     TEXT    NOT NULL
);`;

/** What routes select. `a` is the alias ANNOTATION_JOIN binds. */
export const ANNOTATION_COLUMNS = `
  a.listened, a.listened_at, a.rating, a.notes,
  a.want_to_listen, a.tags, a.updated_at`;

/** What routes join. Expects the shows table to be aliased `sh`. */
export const ANNOTATION_JOIN = 'LEFT JOIN annotations a ON a.content_id = sh.content_id';

export function createAnnotationTable(handle) {
  handle.exec(DDL);
}

const params = (contentId, a) => ({
  content_id: Number(contentId),
  listened: a.listened ? 1 : 0,
  listened_at: a.listened_at,
  rating: a.rating,
  notes: a.notes,
  want_to_listen: a.want_to_listen ? 1 : 0,
  tags: JSON.stringify(a.tags ?? []),
  updated_at: a.updated_at,
});

const UPSERT = `
INSERT INTO annotations
  (content_id, listened, listened_at, rating, notes, want_to_listen, tags, updated_at)
VALUES
  (@content_id, @listened, @listened_at, @rating, @notes, @want_to_listen, @tags, @updated_at)
ON CONFLICT (content_id) DO UPDATE SET
  listened = excluded.listened, listened_at = excluded.listened_at,
  rating = excluded.rating, notes = excluded.notes,
  want_to_listen = excluded.want_to_listen, tags = excluded.tags,
  updated_at = excluded.updated_at`;

/** Replace the table wholesale. Used at boot, from store.list(). */
export function loadAnnotations(handle, map) {
  const insert = handle.prepare(UPSERT);
  handle.transaction(entries => {
    handle.prepare('DELETE FROM annotations').run();
    for (const [contentId, a] of entries) insert.run(params(contentId, a));
  })([...map]);
}

export function upsertAnnotationRow(handle, contentId, a) {
  handle.prepare(UPSERT).run(params(contentId, a));
}

export function removeAnnotationRow(handle, contentId) {
  handle.prepare('DELETE FROM annotations WHERE content_id = ?').run(Number(contentId));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/annotations/temp-table.js server/test/annotations-temp-table.test.js
git commit -m "feat: annotations TEMP TABLE on the read-only archive connection"
```

---

### Task 3: IAP assertion verification

The only access control the site has. It fails closed.

**Files:**
- Create: `server/src/auth.js`
- Create: `server/test/auth.test.js`
- Modify: `server/package.json`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `IAP_ISSUER`, `IAP_JWKS_URL`, `IAP_HEADER` — constants
  - `verifyAssertion(token, { audience, keys }) => Promise<{ email, sub }>` — throws on any failure
  - `requireUser({ audience, devEmail, keys }) => express middleware` setting `req.user = { email }`

- [ ] **Step 1: Add the dependency**

```bash
npm install --workspace server jose
```

`jose` is chosen over `jsonwebtoken` because it verifies ES256 against a remote JWK Set natively, caches the keys, and takes an explicit `algorithms` allowlist — the parameter that makes an `alg: none` assertion impossible to accept.

- [ ] **Step 2: Write the failing tests**

Create `server/test/auth.test.js`:

```js
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose';
import { verifyAssertion, requireUser, IAP_ISSUER, IAP_HEADER } from '../src/auth.js';

const AUDIENCE = '/projects/123456789/locations/europe-north1/services/tracklist-browser';
const EMAIL = 'marko@example.com';

let keys, signer, wrongSigner;

/** Sign an assertion the way IAP would, with overridable claims. */
const assertion = async (over = {}, key = signer) =>
  new SignJWT({ email: EMAIL, ...over.claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuer(over.issuer ?? IAP_ISSUER)
    .setAudience(over.audience ?? AUDIENCE)
    .setSubject('accounts.google.com:1234')
    .setIssuedAt(over.iat ?? Math.floor(Date.now() / 1000))
    .setExpirationTime(over.exp ?? '5m')
    .sign(key);

before(async () => {
  const pair = await generateKeyPair('ES256');
  const other = await generateKeyPair('ES256');
  signer = pair.privateKey;
  wrongSigner = other.privateKey;
  keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'ES256' }],
  });
});

test('a well-formed assertion yields the email', async () => {
  const user = await verifyAssertion(await assertion(), { audience: AUDIENCE, keys });
  assert.equal(user.email, EMAIL);
});

test('an expired assertion is rejected', async () => {
  const token = await assertion({ iat: 1600000000, exp: 1600000060 });
  await assert.rejects(() => verifyAssertion(token, { audience: AUDIENCE, keys }));
});

test('a wrong audience is rejected', async () => {
  const token = await assertion({ audience: '/projects/123456789/apps/some-other-app' });
  await assert.rejects(() => verifyAssertion(token, { audience: AUDIENCE, keys }));
});

test('a wrong issuer is rejected', async () => {
  const token = await assertion({ issuer: 'https://evil.example.com' });
  await assert.rejects(() => verifyAssertion(token, { audience: AUDIENCE, keys }));
});

test('an assertion signed by an unknown key is rejected', async () => {
  const token = await assertion({}, wrongSigner);
  await assert.rejects(() => verifyAssertion(token, { audience: AUDIENCE, keys }));
});

test('an alg:none assertion is rejected', async () => {
  // Hand-built, because no signing library will produce this for us.
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = [
    b64({ alg: 'none', typ: 'JWT' }),
    b64({ iss: IAP_ISSUER, aud: AUDIENCE, email: EMAIL, exp: Math.floor(Date.now() / 1000) + 300 }),
    '',
  ].join('.');
  await assert.rejects(() => verifyAssertion(token, { audience: AUDIENCE, keys }));
});

test('an assertion with no email claim is rejected', async () => {
  const token = await assertion({ claims: { email: undefined } });
  await assert.rejects(
    () => verifyAssertion(token, { audience: AUDIENCE, keys }),
    /email/);
});

/* ------------------------------- middleware -------------------------------- */

async function serve(middleware) {
  const app = express();
  app.use(middleware);
  app.get('/whoami', (req, res) => res.json({ email: req.user.email }));
  const server = app.listen(0);
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('requireUser rejects a request with no assertion', async () => {
  const { server, base } = await serve(requireUser({ audience: AUDIENCE, keys }));
  const res = await fetch(`${base}/whoami`);
  assert.equal(res.status, 401);
  server.close();
});

test('requireUser rejects a forged assertion with 403', async () => {
  const { server, base } = await serve(requireUser({ audience: AUDIENCE, keys }));
  const res = await fetch(`${base}/whoami`, {
    headers: { [IAP_HEADER]: await assertion({}, wrongSigner) },
  });
  assert.equal(res.status, 403);
  server.close();
});

test('requireUser accepts a good assertion', async () => {
  const { server, base } = await serve(requireUser({ audience: AUDIENCE, keys }));
  const res = await fetch(`${base}/whoami`, { headers: { [IAP_HEADER]: await assertion() } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { email: EMAIL });
  server.close();
});

test('an unreachable JWKS is 503, not 403', async () => {
  // The keys resolver is what jose calls to fetch a signing key; a network
  // failure surfaces here. It must not look like a rejected user.
  const unreachable = () => { throw Object.assign(new Error('fetch failed'), { code: 'ERR_JWKS_TIMEOUT' }); };
  const { server, base } = await serve(requireUser({ audience: AUDIENCE, keys: unreachable }));
  const res = await fetch(`${base}/whoami`, { headers: { [IAP_HEADER]: await assertion() } });
  assert.equal(res.status, 503);
  server.close();
});

test('an unreachable JWKS still refuses the request', async () => {
  const unreachable = () => { throw Object.assign(new Error('fetch failed'), { code: 'ERR_JWKS_TIMEOUT' }); };
  const { server, base } = await serve(requireUser({ audience: AUDIENCE, keys: unreachable }));
  const res = await fetch(`${base}/whoami`, { headers: { [IAP_HEADER]: await assertion() } });
  assert.notEqual(res.status, 200, 'failing open would disable the only access control the site has');
  server.close();
});

test('devEmail bypasses verification entirely', async () => {
  const { server, base } = await serve(requireUser({ devEmail: 'dev@localhost' }));
  const res = await fetch(`${base}/whoami`);
  assert.deepEqual(await res.json(), { email: 'dev@localhost' });
  server.close();
});

test('requireUser refuses to be constructed with neither audience nor devEmail', () => {
  assert.throws(() => requireUser({}), /audience/);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern='assertion|requireUser|devEmail'`
Expected: FAIL — `Cannot find module '../src/auth.js'`

- [ ] **Step 4: Write `auth.js`**

Create `server/src/auth.js`:

```js
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const IAP_ISSUER = 'https://cloud.google.com/iap';
export const IAP_JWKS_URL = 'https://www.gstatic.com/iap/verify/public_key-jwk';
export const IAP_HEADER = 'x-goog-iap-jwt-assertion';

let remote = null;

/** Google's IAP signing keys, fetched once and cached for six hours. */
export function iapKeys(url = IAP_JWKS_URL) {
  remote ??= createRemoteJWKSet(new URL(url), { cacheMaxAge: 6 * 60 * 60 * 1000 });
  return remote;
}

/**
 * Verify an IAP assertion. Throws on anything short of a valid one — there is
 * no partial success and no anonymous fallback.
 *
 * `audience` is Cloud Run's form,
 *   /projects/PROJECT_NUMBER/locations/REGION/services/SERVICE_NAME
 * which is NOT the App Engine or backend-service form used by most IAP sample
 * code. It arrives as IAP_AUDIENCE from Terraform rather than being assembled
 * here: a hand-built audience is a check that passes for the wrong service.
 */
export async function verifyAssertion(token, { audience, keys = iapKeys() }) {
  const { payload } = await jwtVerify(token, keys, {
    issuer: IAP_ISSUER,
    audience,
    algorithms: ['ES256'], // an allowlist of one; this is what rejects alg:none
  });
  if (!payload.email) throw new Error('IAP assertion carries no email claim');
  return { email: payload.email, sub: payload.sub };
}

/**
 * Express middleware putting `{ email }` on `req.user`.
 *
 * `devEmail` is for localhost, where IAP does not exist. It is only ever passed
 * when K_SERVICE is unset (see index.js) — on Cloud Run a missing audience is a
 * fatal boot error, never a silent downgrade to an unauthenticated user.
 */
export function requireUser({ audience, devEmail = null, keys = undefined }) {
  if (!devEmail && !audience) {
    throw new Error('requireUser needs an IAP audience, or a devEmail for local use');
  }

  return async (req, res, next) => {
    if (devEmail) {
      req.user = { email: devEmail };
      return next();
    }

    const token = req.get(IAP_HEADER);
    if (!token) return res.status(401).json({ error: 'missing IAP assertion' });

    try {
      req.user = await verifyAssertion(token, { audience, keys });
      next();
    } catch (err) {
      // Deliberately terse to the client: the reason goes to the log.
      console.warn(`rejected IAP assertion: ${err.code ?? ''} ${err.message}`);
      res.status(statusFor(err)).json({
        error: statusFor(err) === 503 ? 'cannot verify identity' : 'invalid IAP assertion',
      });
    }
  };
}

/**
 * 403 when the token is at fault, 503 when we could not reach Google's keys to
 * judge it. Both fail closed — the distinction exists so that an IAP or network
 * outage reads as an outage in the logs rather than as a flood of rejected
 * users, and so a client can sensibly retry the second but not the first.
 */
function statusFor(err) {
  const code = err.code ?? '';
  const tokenFault =
    code.startsWith('ERR_JWT_') ||
    code.startsWith('ERR_JWS_') ||
    code === 'ERR_JOSE_ALG_NOT_ALLOWED' ||
    code === 'ERR_JWKS_NO_MATCHING_KEY' ||
    /email claim/.test(err.message);
  return tokenFault ? 403 : 503;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/auth.js server/test/auth.test.js server/package.json package-lock.json
git commit -m "feat: verify IAP signed assertions, failing closed"
```

---

### Task 4: Wire the store into the server and join annotations onto reads

The first task where the API visibly changes. Read paths only; writes come in Task 5.

**Files:**
- Create: `server/src/annotations/index.js`
- Modify: `server/src/index.js`
- Modify: `server/src/routes.js:43-58` (`/series/:slug/shows`), `:62-75` (`/shows/:id`)
- Modify: `server/test/routes.test.js`

**Interfaces:**
- Consumes: `createSqliteStore` (Task 1), temp-table helpers (Task 2), `requireUser` (Task 3)
- Produces:
  - `createStore(env) => Promise<Store>` — driver selection
  - `setStore(store) => void` / `getStore() => Store` — the process-wide handle
  - `annotationOf(row) => Annotation | null` — joined columns to payload, or null
  - `withAnnotation(row) => row` — strips the flat annotation columns and nests them under `annotation`

`routes.js` keeps its existing default export — a plain router. The store is reached through `getStore()` rather than threaded in as a factory parameter, which would churn every handler already in the file.

- [ ] **Step 1: Write the failing tests**

Append to `server/test/routes.test.js`. The existing `before` hook builds the fixture archive and mounts `routes`; extend it to create a store, the temp table, and a dev user. Replace the existing `before` block with:

```js
import { createSqliteStore } from '../src/annotations/sqlite.js';
import { createAnnotationTable, loadAnnotations } from '../src/annotations/temp-table.js';
import { requireUser } from '../src/auth.js';
import { setStore } from '../src/annotations/index.js';

const DEV_USER = 'dev@localhost';
let store;
let handle;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-routes-'));
  const out = path.join(dir, 'test.sqlite');
  buildDatabase({ csvDir: FIXTURE_CSV, outPath: out });
  handle = openDb(out);

  store = createSqliteStore(path.join(dir, 'annotations.sqlite'));
  setStore(store);
  createAnnotationTable(handle);
  loadAnnotations(handle, await store.list(DEV_USER));

  const app = express();
  app.use(express.json());
  app.use('/api', requireUser({ devEmail: DEV_USER }), routes);
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); store?.close(); handle?.close(); });
```

Then add these tests at the end of the file:

```js
test('GET /api/series/:slug/shows returns a null annotation when untouched', async () => {
  const { body } = await get('/api/series/testshow/shows');
  assert.ok(body.rows.every(r => r.annotation === null));
});

test('GET /api/shows/:id returns a null annotation when untouched', async () => {
  const { body: list } = await get('/api/series/testshow/shows');
  const { body } = await get(`/api/shows/${list.rows[0].id}`);
  assert.equal(body.annotation, null);
});

test('an annotation in the temp table surfaces on both read routes', async () => {
  await store.merge(DEV_USER, 1610000001, { listened: true, rating: 4, tags: ['suvi'] });
  loadAnnotations(handle, await store.list(DEV_USER));

  const { body: list } = await get('/api/series/testshow/shows');
  const row = list.rows.find(r => r.content_id === 1610000001);
  assert.equal(row.annotation.listened, true);
  assert.equal(row.annotation.rating, 4);
  assert.deepEqual(row.annotation.tags, ['suvi']);

  const { body: one } = await get(`/api/shows/${row.id}`);
  assert.equal(one.annotation.listened, true);
  assert.deepEqual(one.annotation.tags, ['suvi']);
});

test('annotations do not disturb the existing show fields', async () => {
  const { body } = await get('/api/series/testshow/shows?page=1&pageSize=2');
  assert.equal(body.total, 3);
  assert.equal(body.rows.length, 2);
  assert.equal(body.rows[0].content_id, 1610000003, 'still newest first');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern='annotation'`
Expected: FAIL — `Cannot find module '../src/annotations/index.js'`

- [ ] **Step 3: Write the driver selector**

Create `server/src/annotations/index.js`:

```js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqliteStore } from './sqlite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The process-wide store. A module-level handle rather than a parameter on
 * every route, because routes.js already exports a plain router and threading
 * a factory through it would churn every existing handler.
 */
let store = null;

export function setStore(s) { store = s; }

export function getStore() {
  if (!store) throw new Error('annotation store not initialised; call createStore() first');
  return store;
}

/**
 * Pick a driver. Firestore on Cloud Run (K_SERVICE is set by the platform),
 * a local SQLite file everywhere else — so `npm run dev` and `npm test` need
 * no cloud project, no credentials and no emulator.
 */
export async function createStore(env = process.env) {
  const driver = env.ANNOTATIONS_DRIVER || (env.K_SERVICE ? 'firestore' : 'sqlite');

  if (driver === 'sqlite') {
    return createSqliteStore(
      env.ANNOTATIONS_DB || path.resolve(__dirname, '../../../data/annotations.sqlite'));
  }
  if (driver === 'firestore') {
    const { createFirestoreStore } = await import('./firestore.js');
    return createFirestoreStore({ projectId: env.GOOGLE_CLOUD_PROJECT });
  }
  throw new Error(`unknown ANNOTATIONS_DRIVER: ${driver}`);
}

/** A joined row's annotation columns -> the API's annotation object, or null. */
export function annotationOf(row) {
  if (row.listened === null || row.listened === undefined) return null;
  return {
    listened: !!row.listened,
    listened_at: row.listened_at,
    rating: row.rating,
    notes: row.notes,
    want_to_listen: !!row.want_to_listen,
    tags: JSON.parse(row.tags ?? '[]'),
    updated_at: row.updated_at,
  };
}

/** Strip the flat annotation columns off a row and nest them under `annotation`. */
export function withAnnotation(row) {
  const { listened, listened_at, rating, notes, want_to_listen, tags, updated_at, ...rest } = row;
  return { ...rest, annotation: annotationOf(row) };
}
```

- [ ] **Step 4: Join annotations onto the two read routes**

In `server/src/routes.js`, add to the imports:

```js
import { ANNOTATION_COLUMNS, ANNOTATION_JOIN } from './annotations/temp-table.js';
import { withAnnotation } from './annotations/index.js';
```

Replace the `/series/:slug/shows` handler body's `rows` query and response:

```js
    const rows = db().prepare(`
      SELECT sh.id, sh.content_id, sh.title, sh.show_date, sh.url, sh.track_count,
             ${ANNOTATION_COLUMNS}
      FROM shows sh
      JOIN series s ON s.id = sh.series_id
      ${ANNOTATION_JOIN}
      WHERE s.slug = ?
      ORDER BY sh.show_date DESC, sh.id DESC
      LIMIT ? OFFSET ?`).all(req.params.slug, ps, (p - 1) * ps);
```

and change the response line to:

```js
    res.json({ rows: rows.map(withAnnotation), total, page: p, pageSize: ps });
```

Replace the `/shows/:id` handler's `show` query and response:

```js
    const show = db().prepare(`
      SELECT sh.*, s.name AS series_name, s.slug AS series_slug,
             ${ANNOTATION_COLUMNS}
      FROM shows sh
      JOIN series s ON s.id = sh.series_id
      ${ANNOTATION_JOIN}
      WHERE sh.id = ?`).get(req.params.id);
    if (!show) return res.status(404).json({ error: 'not found' });
```

and:

```js
    const { annotation, ...rest } = withAnnotation(show);
    res.json({ show: rest, tracks, annotation });
```

Note `sh.*` already carries `content_id`, so the join has its key without a payload change.

- [ ] **Step 5: Wire it into boot**

In `server/src/index.js`, add imports:

```js
import { createStore, setStore } from './annotations/index.js';
import { createAnnotationTable, loadAnnotations } from './annotations/temp-table.js';
import { requireUser } from './auth.js';
```

Replace `app.use('/api', routes);` with:

```js
// On Cloud Run, IAP is the only gate; refuse to boot without the audience
// rather than serving the archive to anyone who asks.
const onCloudRun = Boolean(process.env.K_SERVICE);
const audience = process.env.IAP_AUDIENCE || null;
const devEmail = onCloudRun ? null : (process.env.DEV_USER_EMAIL || 'dev@localhost');

if (onCloudRun && !audience) {
  console.error('IAP_AUDIENCE is unset. Refusing to start unauthenticated.');
  process.exit(1);
}

app.use('/api', requireUser({ audience, devEmail }), routes);
```

Then replace the boot block at the bottom with:

```js
try {
  const handle = openDb();
  console.log(`opened ${DB_PATH}`);

  const store = await createStore();
  setStore(store);
  createAnnotationTable(handle);

  const owner = devEmail ?? process.env.OWNER_EMAIL;
  if (owner) {
    // Best-effort: the archive is the product and stays readable even if the
    // annotation store is unreachable.
    try {
      loadAnnotations(handle, await store.list(owner));
    } catch (err) {
      console.error(`could not load annotations: ${err.message}`);
    }
  }
} catch (err) {
  console.error(`cannot open database at ${DB_PATH}: ${err.message}`);
  console.error('run `npm run build:db` first');
  process.exit(1);
}

app.listen(port, () => console.log(`api + ui listening on :${port}`));
```

Top-level `await` is available: the file is an ES module.

The static-file and catch-all handlers stay **outside** `requireUser` for now; Task 10 puts the whole origin behind IAP at the platform level, so the bundle needs no app-level gate.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — every pre-existing route test still passes, plus the four new ones.

- [ ] **Step 7: Check it boots and serves locally**

```bash
npm run dev:server
curl -s localhost:3000/api/series/eesti_pops/shows?pageSize=2 | head -c 400
```
Expected: rows each carrying `"annotation": null`. Stop the server.

- [ ] **Step 8: Commit**

```bash
git add server/src/annotations/index.js server/src/index.js server/src/routes.js server/test/routes.test.js
git commit -m "feat: join annotations onto the show read routes"
```

---

### Task 5: Write routes

**Files:**
- Modify: `server/src/routes.js`
- Create: `server/test/annotations-routes.test.js`

**Interfaces:**
- Consumes: `getStore`, `withAnnotation` (Task 4); `validatePatch` (Task 1); temp-table writers (Task 2)
- Produces:
  - `GET /api/me` → `{ email }`
  - `PATCH /api/shows/:contentId/annotation` → the merged `Annotation`
  - `DELETE /api/shows/:contentId/annotation` → `204`
  - `GET /api/tags` → `[{ tag, count }]`

- [ ] **Step 1: Write the failing tests**

Create `server/test/annotations-routes.test.js`:

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CSV = path.join(__dirname, 'fixtures/csv');
const DEV_USER = 'dev@localhost';
const SHOW = 1610000001; // a content_id present in the fixtures

let server, base, store, handle;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-annroutes-'));
  const out = path.join(dir, 'test.sqlite');
  buildDatabase({ csvDir: FIXTURE_CSV, outPath: out });
  handle = openDb(out);
  createAnnotationTable(handle);

  store = createSqliteStore(path.join(dir, 'annotations.sqlite'));
  setStore(store);

  const app = express();
  app.use(express.json());
  app.use('/api', requireUser({ devEmail: DEV_USER }), routes);
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); store?.close(); handle?.close(); });

const send = async (method, p, body) => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const patch = (p, b) => send('PATCH', p, b);

test('GET /api/me reports the signed-in user', async () => {
  const { body } = await send('GET', '/api/me');
  assert.deepEqual(body, { email: DEV_USER });
});

test('PATCH creates an annotation and returns it', async () => {
  const { status, body } = await patch(`/api/shows/${SHOW}/annotation`, { listened: true });
  assert.equal(status, 200);
  assert.equal(body.listened, true);
  assert.match(body.listened_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('a second PATCH changes only the keys it names', async () => {
  await patch(`/api/shows/${SHOW}/annotation`, { rating: 5 });
  const { body } = await patch(`/api/shows/${SHOW}/annotation`, { notes: 'hea saade' });
  assert.equal(body.notes, 'hea saade');
  assert.equal(body.rating, 5, 'the rating survives a notes-only patch');
  assert.equal(body.listened, true, 'listened survives too');
});

test('the write is visible to the read routes immediately', async () => {
  await patch(`/api/shows/${SHOW}/annotation`, { tags: ['suvi'] });
  const res = await fetch(`${base}/api/series/testshow/shows`);
  const list = await res.json();
  const row = list.rows.find(r => r.content_id === SHOW);
  assert.deepEqual(row.annotation.tags, ['suvi'], 'temp table updated in step with the store');
});

test('PATCH with an explicit null clears a field', async () => {
  await patch(`/api/shows/${SHOW}/annotation`, { rating: 4 });
  const { body } = await patch(`/api/shows/${SHOW}/annotation`, { rating: null });
  assert.equal(body.rating, null);
});

test('PATCH rejects a bad rating with 400', async () => {
  const { status, body } = await patch(`/api/shows/${SHOW}/annotation`, { rating: 9 });
  assert.equal(status, 400);
  assert.match(body.error, /rating/);
});

test('PATCH rejects an unknown field with 400', async () => {
  const { status } = await patch(`/api/shows/${SHOW}/annotation`, { colour: 'red' });
  assert.equal(status, 400);
});

test('PATCH rejects an empty body with 400', async () => {
  const { status } = await patch(`/api/shows/${SHOW}/annotation`, {});
  assert.equal(status, 400);
});

test('PATCH rejects over-long notes with 400', async () => {
  const { status } = await patch(`/api/shows/${SHOW}/annotation`, { notes: 'x'.repeat(4001) });
  assert.equal(status, 400);
});

test('PATCH rejects too many tags with 400', async () => {
  const tags = Array.from({ length: 21 }, (_, i) => `t${i}`);
  const { status } = await patch(`/api/shows/${SHOW}/annotation`, { tags });
  assert.equal(status, 400);
});

test('PATCH on a content_id not in the archive is 404', async () => {
  const { status } = await patch('/api/shows/9999999999/annotation', { listened: true });
  assert.equal(status, 404);
});

test('PATCH on a non-numeric content_id is 400', async () => {
  const { status } = await patch('/api/shows/abc/annotation', { listened: true });
  assert.equal(status, 400);
});

test('GET /api/tags counts distinct tags', async () => {
  await patch(`/api/shows/${SHOW}/annotation`, { tags: ['suvi', 'intervjuu'] });
  await patch('/api/shows/1610000002/annotation', { tags: ['suvi'] });
  const { body } = await send('GET', '/api/tags');
  const suvi = body.find(t => t.tag === 'suvi');
  assert.equal(suvi.count, 2);
  assert.ok(body.some(t => t.tag === 'intervjuu'));
});

test('DELETE removes the annotation from store and temp table', async () => {
  await patch(`/api/shows/${SHOW}/annotation`, { listened: true });
  const { status } = await send('DELETE', `/api/shows/${SHOW}/annotation`);
  assert.equal(status, 204);

  assert.equal(await store.get(DEV_USER, SHOW), null);

  const res = await fetch(`${base}/api/series/testshow/shows`);
  const list = await res.json();
  assert.equal(list.rows.find(r => r.content_id === SHOW).annotation, null);
});

test('DELETE of an absent annotation is still 204', async () => {
  const { status } = await send('DELETE', '/api/shows/1610000003/annotation');
  assert.equal(status, 204);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern='PATCH|DELETE|/api/me|/api/tags'`
Expected: FAIL — 404s, because the routes do not exist.

- [ ] **Step 3: Add the routes**

In `server/src/routes.js`, extend the imports:

```js
import { getStore, withAnnotation } from './annotations/index.js';
import { validatePatch } from './annotations/store.js';
import { upsertAnnotationRow, removeAnnotationRow, ANNOTATION_JOIN, ANNOTATION_COLUMNS }
  from './annotations/temp-table.js';
```

Add these handlers **above** the trailing `router.use(...)` 404 catch-all — order matters, the catch-all swallows anything below it:

```js
/* ------------------------------ annotations -------------------------------- */

router.get('/me', (req, res) => res.json({ email: req.user.email }));

router.get('/tags', (_req, res, next) => {
  try {
    res.json(db().prepare(`
      SELECT j.value AS tag, COUNT(*) AS count
      FROM annotations a, json_each(a.tags) j
      GROUP BY j.value
      ORDER BY count DESC, tag COLLATE NOCASE`).all());
  } catch (e) { next(e); }
});

/** The archive is the authority on which episodes exist. */
function requireShow(req, res) {
  const contentId = Number(req.params.contentId);
  if (!Number.isInteger(contentId)) {
    res.status(400).json({ error: 'content_id must be an integer' });
    return null;
  }
  const row = db().prepare('SELECT content_id FROM shows WHERE content_id = ?').get(contentId);
  if (!row) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  return contentId;
}

router.patch('/shows/:contentId/annotation', async (req, res, next) => {
  try {
    const contentId = requireShow(req, res);
    if (contentId === null) return;

    const check = validatePatch(req.body);
    if (!check.ok) return res.status(400).json({ error: check.error });

    // Durable store first. Only once it has accepted the write does the temp
    // table move, so the two cannot disagree.
    const merged = await getStore().merge(req.user.email, contentId, check.patch);
    upsertAnnotationRow(db(), contentId, merged);
    res.json(merged);
  } catch (e) { next(e); }
});

router.delete('/shows/:contentId/annotation', async (req, res, next) => {
  try {
    const contentId = requireShow(req, res);
    if (contentId === null) return;

    await getStore().remove(req.user.email, contentId);
    removeAnnotationRow(db(), contentId);
    res.status(204).end();
  } catch (e) { next(e); }
});
```

Note: these two handlers are `async` on purpose — the *store* is async even though `better-sqlite3` is not. Express 4 does not forward a rejected promise to the error handler, which is why both bodies are wrapped in `try/catch` with an explicit `next(e)`.

- [ ] **Step 4: Make the store failure a 502**

In `server/src/index.js`, replace the error handler with:

```js
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  // A failed annotation write is the store being unreachable, not a bug in the
  // request: say so, so the client can keep the user's text instead of clearing it.
  const status = err.code === 'ANNOTATION_STORE_UNAVAILABLE' ? 502 : 500;
  res.status(status).json({ error: err.message });
});
```

and in `server/src/annotations/sqlite.js` and (later) `firestore.js`, wrap driver failures:

```js
const unavailable = err => {
  const wrapped = new Error(`annotation store unavailable: ${err.message}`);
  wrapped.code = 'ANNOTATION_STORE_UNAVAILABLE';
  return wrapped;
};
```

Apply it in each async method of the SQLite driver:

```js
    async merge(owner, contentId, patch) {
      try {
        /* ...existing body... */
      } catch (err) { throw unavailable(err); }
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes.js server/src/index.js server/src/annotations/sqlite.js server/test/annotations-routes.test.js
git commit -m "feat: annotation write routes, /api/me and /api/tags"
```

---

### Task 6: Annotation filters on the shows route

**Files:**
- Modify: `server/src/routes.js` (`/series/:slug/shows`)
- Create: `server/test/annotations-filters.test.js`

**Interfaces:**
- Consumes: `ANNOTATION_JOIN` (Task 2), the write routes (Task 5)
- Produces: `?listened=true|false`, `?want=true`, `?tag=<string>`, `?ratingMin=1..5` on `GET /api/series/:slug/shows`

**Why a new test file rather than extending an existing one.** `routes-ordering.test.js` is a bespoke collation harness — it inserts four extra artists and two extra series specifically to expose SQLite's BINARY ordering, so its row counts are wrong for these assertions. And appending to `annotations-routes.test.js` would make every filter total depend on leftover state from Task 5's writes, since `node:test` runs a file's tests in order against one shared database. A clean file per concern is the only way these totals stay readable.

- [ ] **Step 1: Write the failing tests**

Create `server/test/annotations-filters.test.js`:

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CSV = path.join(__dirname, 'fixtures/csv');
const DEV_USER = 'dev@localhost';

let server, base, store, handle;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlb-filters-'));
  const out = path.join(dir, 'test.sqlite');
  buildDatabase({ csvDir: FIXTURE_CSV, outPath: out });
  handle = openDb(out);
  createAnnotationTable(handle);

  store = createSqliteStore(path.join(dir, 'annotations.sqlite'));
  setStore(store);

  const app = express();
  app.use(express.json());
  app.use('/api', requireUser({ devEmail: DEV_USER }), routes);
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); store?.close(); handle?.close(); });

const get = async p => {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: await res.json().catch(() => null) };
};

const patch = async (p, body) => {
  const res = await fetch(`${base}${p}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/**
 * The fixture series `testshow` has exactly three shows: content_ids
 * 1610000001, 1610000002 and 1610000003. Every total below is relative to
 * those three, and each test sets up the state it asserts on.
 */
const reset = async () => {
  for (const id of [1610000001, 1610000002, 1610000003]) {
    await fetch(`${base}/api/shows/${id}/annotation`, { method: 'DELETE' });
  }
};

```

Then the tests themselves, each starting from a clean slate:

```js
test('an unfiltered request is unchanged by the join', async () => {
  await reset();
  const { body } = await get('/api/series/testshow/shows');
  assert.equal(body.total, 3);
  assert.ok(body.rows.every(r => r.annotation === null));
});

test('?listened=false includes shows with no annotation at all', async () => {
  await reset();
  const { body } = await get('/api/series/testshow/shows?listened=false');
  assert.equal(body.total, 3, 'an unannotated show is unlistened, not unknown');
});

test('?listened=false excludes shows marked listened', async () => {
  await reset();
  await patch('/api/shows/1610000001/annotation', { listened: true });
  const { body } = await get('/api/series/testshow/shows?listened=false');
  assert.equal(body.total, 2, 'total reflects the filter, not the whole series');
  assert.ok(!body.rows.some(r => r.content_id === 1610000001));
});

test('?listened=true returns only listened shows', async () => {
  await reset();
  await patch('/api/shows/1610000001/annotation', { listened: true });
  const { body } = await get('/api/series/testshow/shows?listened=true');
  assert.deepEqual(body.rows.map(r => r.content_id), [1610000001]);
  assert.equal(body.total, 1);
});

test('a show annotated but not listened still counts as unlistened', async () => {
  await reset();
  await patch('/api/shows/1610000001/annotation', { rating: 3 });
  const { body } = await get('/api/series/testshow/shows?listened=false');
  assert.equal(body.total, 3, 'rating a show does not mark it listened');
});

test('?want=true returns only the queue', async () => {
  await reset();
  await patch('/api/shows/1610000002/annotation', { want_to_listen: true });
  const { body } = await get('/api/series/testshow/shows?want=true');
  assert.deepEqual(body.rows.map(r => r.content_id), [1610000002]);
});

test('?tag= filters on an exact tag', async () => {
  await reset();
  await patch('/api/shows/1610000003/annotation', { tags: ['suvi', 'intervjuu'] });
  await patch('/api/shows/1610000002/annotation', { tags: ['talv'] });
  const { body } = await get('/api/series/testshow/shows?tag=suvi');
  assert.deepEqual(body.rows.map(r => r.content_id), [1610000003]);
});

test('?tag= keeps diacritics distinct', async () => {
  await reset();
  await patch('/api/shows/1610000003/annotation', { tags: ['Mägi'] });
  assert.equal((await get('/api/series/testshow/shows?tag=Magi')).body.total, 0, 'magi must not match Mägi');
  assert.equal((await get('/api/series/testshow/shows?tag=M%C3%A4gi')).body.total, 1);
});

test('?ratingMin= filters on rating', async () => {
  await reset();
  await patch('/api/shows/1610000001/annotation', { rating: 5 });
  await patch('/api/shows/1610000002/annotation', { rating: 2 });
  const { body } = await get('/api/series/testshow/shows?ratingMin=4');
  assert.deepEqual(body.rows.map(r => r.content_id), [1610000001]);
});

test('?ratingMin= excludes unrated shows', async () => {
  await reset();
  await patch('/api/shows/1610000001/annotation', { rating: 5 });
  const { body } = await get('/api/series/testshow/shows?ratingMin=1');
  assert.equal(body.total, 1, 'NULL rating is not >= 1');
});

test('?ratingMin= outside 1..5 is a 400', async () => {
  assert.equal((await get('/api/series/testshow/shows?ratingMin=9')).status, 400);
  assert.equal((await get('/api/series/testshow/shows?ratingMin=abc')).status, 400);
});

test('filters combine', async () => {
  await reset();
  await patch('/api/shows/1610000001/annotation', { listened: true, rating: 5 });
  await patch('/api/shows/1610000002/annotation', { listened: true, rating: 2 });
  const { body } = await get('/api/series/testshow/shows?listened=true&ratingMin=4');
  assert.equal(body.total, 1);
  assert.deepEqual(body.rows.map(r => r.content_id), [1610000001]);
});

test('paging applies after filtering, not before', async () => {
  await reset();
  await patch('/api/shows/1610000001/annotation', { listened: true });
  const { body } = await get('/api/series/testshow/shows?listened=false&page=1&pageSize=1');
  assert.equal(body.total, 2);
  assert.equal(body.rows.length, 1, 'a filtered page is a full page, not a short one');
});
```

That last test is the one that justifies the whole temp-table design: with a JavaScript merge, the database would paginate all three shows, hand back one row, and the filter would then drop it — giving an empty page with a total of 2.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern='listened|want=|tag=|ratingMin|paging applies'`
Expected: FAIL — the filters are ignored, so every total comes back as 3.

- [ ] **Step 3: Implement the filters**

Replace the whole `/series/:slug/shows` handler in `server/src/routes.js`:

```js
router.get('/series/:slug/shows', (req, res, next) => {
  try {
    const p = page(req.query), ps = size(req.query);
    const where = ['s.slug = ?'], args = [req.params.slug];

    // COALESCE, because an unannotated show LEFT JOINs to NULL and NULL = 0
    // is NULL, not true — without it "unlistened" would return nothing.
    if (req.query.listened === 'true')  where.push('COALESCE(a.listened, 0) = 1');
    if (req.query.listened === 'false') where.push('COALESCE(a.listened, 0) = 0');
    if (req.query.want === 'true')      where.push('COALESCE(a.want_to_listen, 0) = 1');

    if (req.query.ratingMin) {
      const min = Number(req.query.ratingMin);
      if (!Number.isInteger(min) || min < 1 || min > 5) {
        return res.status(400).json({ error: 'ratingMin must be an integer 1-5' });
      }
      where.push('a.rating >= ?');
      args.push(min);
    }

    // Exact match, not LIKE: tags are chosen from a list, and `norm()` would
    // fold Mägi and mägi together where the tag list keeps them apart.
    if (req.query.tag) {
      where.push(`EXISTS (SELECT 1 FROM json_each(a.tags) j WHERE j.value = ?)`);
      args.push(req.query.tag);
    }

    const clause = `WHERE ${where.join(' AND ')}`;
    const from = `
      FROM shows sh
      JOIN series s ON s.id = sh.series_id
      ${ANNOTATION_JOIN}
      ${clause}`;

    const rows = db().prepare(`
      SELECT sh.id, sh.content_id, sh.title, sh.show_date, sh.url, sh.track_count,
             ${ANNOTATION_COLUMNS}
      ${from}
      ORDER BY sh.show_date DESC, sh.id DESC
      LIMIT ? OFFSET ?`).all(...args, ps, (p - 1) * ps);

    const { total } = db().prepare(`SELECT COUNT(*) AS total ${from}`).get(...args);

    res.json({ rows: rows.map(withAnnotation), total, page: p, pageSize: ps });
  } catch (e) { next(e); }
});
```

The `from` fragment is shared by the rows and count queries deliberately: the pre-existing `/api/artists` bug in this file is exactly what happens when those two drift apart.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes.js server/test/annotations-filters.test.js
git commit -m "feat: filter shows by listened, queue, tag and rating"
```

---

### Task 7: The Firestore driver

**Files:**
- Create: `server/src/annotations/firestore.js`
- Create: `server/test/annotations-firestore.test.js`
- Modify: `server/package.json`

**Interfaces:**
- Consumes: `EMPTY`, `applyPatch` (Task 1)
- Produces: `createFirestoreStore({ projectId }) => Store` — the same five methods as Task 1

- [ ] **Step 1: Add the dependency**

```bash
npm install --workspace server @google-cloud/firestore
```

- [ ] **Step 2: Write the contract test**

Create `server/test/annotations-firestore.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStore } from '../src/annotations/firestore.js';

// The suite must stay hermetic: no network, no cloud project, no emulator in
// CI. This runs only when someone has deliberately pointed it at a project.
const PROJECT = process.env.FIRESTORE_TEST_PROJECT;
const skip = PROJECT ? false : 'set FIRESTORE_TEST_PROJECT to run';

const OWNER = `test-${process.pid}@example.com`;
const SHOW = 1610000001;

test('the Firestore driver satisfies the store contract', { skip }, async () => {
  const store = createFirestoreStore({ projectId: PROJECT });
  try {
    assert.equal(await store.get(OWNER, SHOW), null);

    const first = await store.merge(OWNER, SHOW, { listened: true, rating: 5 });
    assert.equal(first.listened, true);
    assert.equal(first.rating, 5);

    const second = await store.merge(OWNER, SHOW, { notes: 'hea' });
    assert.equal(second.rating, 5, 'a notes-only patch preserves the rating');
    assert.equal(second.notes, 'hea');

    const all = await store.list(OWNER);
    assert.equal(all.size, 1);
    assert.equal(all.get(SHOW).notes, 'hea', 'list keys are numeric content_ids');

    await store.remove(OWNER, SHOW);
    assert.equal(await store.get(OWNER, SHOW), null);
  } finally {
    await store.remove(OWNER, SHOW).catch(() => {});
    store.close();
  }
});

test('an unreachable Firestore surfaces as ANNOTATION_STORE_UNAVAILABLE', async () => {
  const store = createFirestoreStore({
    projectId: 'definitely-not-a-real-project',
    settings: { host: '127.0.0.1:1', ssl: false },
  });
  await assert.rejects(
    () => store.list(OWNER),
    err => err.code === 'ANNOTATION_STORE_UNAVAILABLE');
  store.close();
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern='Firestore'`
Expected: FAIL — `Cannot find module '../src/annotations/firestore.js'`

- [ ] **Step 4: Write the driver**

Create `server/src/annotations/firestore.js`:

```js
import { Firestore } from '@google-cloud/firestore';
import { EMPTY, applyPatch } from './store.js';

const unavailable = err => {
  const wrapped = new Error(`annotation store unavailable: ${err.message}`);
  wrapped.code = 'ANNOTATION_STORE_UNAVAILABLE';
  return wrapped;
};

/** Firestore doc -> Annotation. Absent fields fall back to EMPTY's defaults. */
const toAnnotation = data => ({
  listened: data.listened ?? false,
  listened_at: data.listened_at ?? null,
  rating: data.rating ?? null,
  notes: data.notes ?? null,
  want_to_listen: data.want_to_listen ?? false,
  tags: data.tags ?? [],
  updated_at: data.updated_at ?? null,
});

/**
 * Production driver. Credentials come from Application Default Credentials —
 * on Cloud Run that is the runtime service account, so nothing is configured
 * here and no key is stored anywhere.
 *
 * One document per *annotated* show, not per show: a cold start reads only what
 * has actually been marked, which keeps the boot load inside the free tier.
 */
export function createFirestoreStore({ projectId, settings = {} } = {}) {
  const db = new Firestore({ projectId, ...settings });

  // Firestore document ids are strings; content_id is an integer everywhere
  // else, so conversion happens here and nowhere else.
  const shows = owner => db.collection('annotations').doc(owner).collection('shows');

  return {
    async list(owner) {
      try {
        const snap = await shows(owner).get();
        return new Map(snap.docs.map(d => [Number(d.id), toAnnotation(d.data())]));
      } catch (err) { throw unavailable(err); }
    },

    async get(owner, contentId) {
      try {
        const doc = await shows(owner).doc(String(contentId)).get();
        return doc.exists ? toAnnotation(doc.data()) : null;
      } catch (err) { throw unavailable(err); }
    },

    async merge(owner, contentId, patch) {
      try {
        const ref = shows(owner).doc(String(contentId));
        // A transaction, not a plain set({merge:true}): applyPatch needs the
        // current value to decide listened_at, and a read-then-write without
        // one can lose a concurrent field update.
        return await db.runTransaction(async tx => {
          const doc = await tx.get(ref);
          const next = applyPatch(doc.exists ? toAnnotation(doc.data()) : { ...EMPTY }, patch);
          tx.set(ref, next);
          return next;
        });
      } catch (err) { throw unavailable(err); }
    },

    async remove(owner, contentId) {
      try {
        await shows(owner).doc(String(contentId)).delete();
      } catch (err) { throw unavailable(err); }
    },

    close() { return db.terminate(); },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, with the contract test reported as skipped. Confirm the skip is visible — a silently-absent test is not a passing one.

- [ ] **Step 6: Commit**

```bash
git add server/src/annotations/firestore.js server/test/annotations-firestore.test.js server/package.json package-lock.json
git commit -m "feat: Firestore annotation driver"
```

---

### Task 8: The annotation editor

**Files:**
- Modify: `client/src/api.js`
- Create: `client/src/components/Annotator.jsx`
- Modify: `client/src/pages/Show.jsx`
- Modify: `client/src/styles.css`

**Interfaces:**
- Consumes: the API from Tasks 5–6
- Produces: `<Annotator contentId annotation onChange />`; `api.me`, `api.patchAnnotation`, `api.deleteAnnotation`, `api.tags`

- [ ] **Step 1: Extend the API client**

In `client/src/api.js`, add a `send` helper beside the existing `get`:

```js
async function send(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.status === 204 ? null : res.json();
}
```

and add to the `api` object:

```js
  me:               ()            => get('/me'),
  tags:             ()            => get('/tags'),
  patchAnnotation:  (cid, patch)  => send('PATCH', `/shows/${cid}/annotation`, patch),
  deleteAnnotation: (cid)         => send('DELETE', `/shows/${cid}/annotation`),
```

- [ ] **Step 2: Write the editor**

Create `client/src/components/Annotator.jsx`:

```jsx
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const EMPTY = {
  listened: false, listened_at: null, rating: null, notes: null,
  want_to_listen: false, tags: [], updated_at: null,
};

/**
 * Editor for one show's annotation.
 *
 * Every control saves its own field, which is why the API is PATCH: the notes
 * box saves on a debounce, so a whole-document write could land after a star
 * click and silently revert it.
 */
export default function Annotator({ contentId, annotation, onChange }) {
  const [value, setValue] = useState(annotation ?? EMPTY);
  const [notes, setNotes] = useState(annotation?.notes ?? '');
  const [tagDraft, setTagDraft] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    setValue(annotation ?? EMPTY);
    setNotes(annotation?.notes ?? '');
  }, [contentId, annotation]);

  async function save(patch) {
    setSaving(true);
    setError(null);
    try {
      const next = await api.patchAnnotation(contentId, patch);
      setValue(next);
      onChange?.(next);
    } catch (err) {
      // Leave the field as the user typed it; clearing it would lose the text.
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function onNotes(text) {
    setNotes(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save({ notes: text }), 600);
  }

  useEffect(() => () => clearTimeout(timer.current), []);

  function addTag(e) {
    e.preventDefault();
    const tag = tagDraft.trim();
    if (!tag || value.tags.includes(tag)) return setTagDraft('');
    save({ tags: [...value.tags, tag] });
    setTagDraft('');
  }

  return (
    <section className="annotator">
      <div className="annotator-row">
        <label className="toggle">
          <input type="checkbox" checked={value.listened}
                 onChange={e => save({ listened: e.target.checked })} />
          Listened
        </label>

        <label className="toggle">
          <input type="checkbox" checked={value.want_to_listen}
                 onChange={e => save({ want_to_listen: e.target.checked })} />
          Want to listen
        </label>

        <span className="stars" role="group" aria-label="Rating">
          {[1, 2, 3, 4, 5].map(n => (
            <button key={n} type="button"
                    className={n <= (value.rating ?? 0) ? 'star on' : 'star'}
                    aria-label={`${n} of 5`}
                    aria-pressed={n === value.rating}
                    onClick={() => save({ rating: value.rating === n ? null : n })}>★</button>
          ))}
        </span>

        <span className="annotator-state">
          {saving ? 'Saving…' : error ? <span className="err">{error}</span> : null}
        </span>
      </div>

      <textarea className="notes" rows={3} value={notes}
                placeholder="Notes about this episode…"
                onChange={e => onNotes(e.target.value)} />

      <div className="annotator-row">
        {value.tags.map(tag => (
          <span key={tag} className="tag">
            {tag}
            <button type="button" aria-label={`Remove ${tag}`}
                    onClick={() => save({ tags: value.tags.filter(t => t !== tag) })}>×</button>
          </span>
        ))}
        <form onSubmit={addTag}>
          <input value={tagDraft} placeholder="Add a tag"
                 onChange={e => setTagDraft(e.target.value)} />
        </form>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Mount it on the show page**

In `client/src/pages/Show.jsx`, add the import:

```jsx
import Annotator from '../components/Annotator.jsx';
```

and insert directly after the `<p className="sub">…</p>` block:

```jsx
      <Annotator contentId={show.content_id} annotation={data.annotation} />
```

`show.content_id` is present because `/api/shows/:id` selects `sh.*`.

- [ ] **Step 4: Style it**

Append to `client/src/styles.css`, reusing the existing custom properties (`--muted` is already defined; check the file's `:root` block for the others and use what is there rather than introducing new colour literals):

```css
.annotator { margin: 1rem 0 1.5rem; display: grid; gap: .6rem; }
.annotator-row { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
.annotator-state { color: var(--muted); font-size: .85rem; min-height: 1.2em; }
.toggle { display: inline-flex; align-items: center; gap: .35rem; cursor: pointer; }
.stars { display: inline-flex; gap: .1rem; }
.star { background: none; border: 0; cursor: pointer; font-size: 1.25rem;
        line-height: 1; padding: 0 .1rem; color: var(--muted); }
.star.on { color: #e0a80d; }
.star:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.notes { width: 100%; font: inherit; padding: .5rem; border-radius: 6px;
         border: 1px solid var(--muted); background: transparent; color: inherit; }
.tag { display: inline-flex; align-items: center; gap: .3rem; padding: .15rem .5rem;
       border: 1px solid var(--muted); border-radius: 999px; font-size: .85rem; }
.tag button { background: none; border: 0; cursor: pointer; color: var(--muted);
              font-size: 1rem; line-height: 1; padding: 0; }
```

- [ ] **Step 5: Check it by hand**

```bash
npm run dev
```
Open http://localhost:5173, pick any show, and verify: the listened checkbox persists across a reload; clicking the same star twice clears the rating; notes save about half a second after typing stops; a tag can be added and removed. Stop the server.

- [ ] **Step 6: Build to catch syntax errors**

Run: `npm run build`
Expected: the Vite build succeeds.

- [ ] **Step 7: Commit**

```bash
git add client/src/api.js client/src/components/Annotator.jsx client/src/pages/Show.jsx client/src/styles.css
git commit -m "feat: annotation editor on the show page"
```

---

### Task 9: Badges, filters, and the "Mine" page

**Files:**
- Modify: `client/src/pages/SeriesShows.jsx`
- Create: `client/src/pages/Mine.jsx`
- Modify: `client/src/App.jsx`
- Modify: `client/src/api.js`
- Modify: `client/src/styles.css`

**Interfaces:**
- Consumes: the filters from Task 6, `api.tags` from Task 8
- Produces: `/mine` route; `api.shows(slug, params)` now forwards the filter params (already generic — `get()` builds the query string from whatever it is handed)

- [ ] **Step 1: Add filters and badges to the series page**

Replace `client/src/pages/SeriesShows.jsx`:

```jsx
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtDate, fmtNum } from '../api.js';
import { useAsync } from '../components/useAsync.js';
import Pager from '../components/Pager.jsx';

/** Compact state for one show: nothing at all when it has no annotation. */
export function StateBadge({ annotation: a }) {
  if (!a) return null;
  return (
    <span className="badges">
      {a.listened && <span className="badge" title="Listened">✓</span>}
      {a.want_to_listen && <span className="badge" title="Want to listen">☆</span>}
      {a.rating && <span className="badge" title={`Rated ${a.rating} of 5`}>{a.rating}★</span>}
      {a.notes && <span className="badge" title="Has notes">✎</span>}
      {a.tags.map(t => <span key={t} className="badge tagbadge">{t}</span>)}
    </span>
  );
}

const FILTERS = [
  { key: 'all',        label: 'All',           params: {} },
  { key: 'unlistened', label: 'Not listened',  params: { listened: 'false' } },
  { key: 'listened',   label: 'Listened',      params: { listened: 'true' } },
  { key: 'want',       label: 'Queue',         params: { want: 'true' } },
  { key: 'good',       label: 'Rated 4+',      params: { ratingMin: 4 } },
];

export default function SeriesShows() {
  const { slug } = useParams();
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('all');

  const params = FILTERS.find(f => f.key === filter).params;
  const { data, error, loading } = useAsync(
    () => api.shows(slug, { page, pageSize: 100, ...params }),
    [slug, page, filter]);

  const choose = key => { setFilter(key); setPage(1); };

  if (loading) return <p className="empty">Loading…</p>;
  if (error) return <p className="err">{error.message}</p>;

  return (
    <>
      <h1>{slug}</h1>
      <p className="sub">{fmtNum(data.total)} shows</p>

      <div className="filters" role="group" aria-label="Filter shows">
        {FILTERS.map(f => (
          <button key={f.key} type="button"
                  className={f.key === filter ? 'chip on' : 'chip'}
                  aria-pressed={f.key === filter}
                  onClick={() => choose(f.key)}>{f.label}</button>
        ))}
      </div>

      {data.rows.length === 0 ? (
        <p className="empty">No shows match this filter.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Date</th><th>Title</th><th className="num">Tracks</th><th>ERR</th></tr></thead>
            <tbody>
              {data.rows.map(r => (
                <tr key={r.id}>
                  <td className="date">{fmtDate(r.show_date)}</td>
                  <td>
                    <Link to={`/shows/${r.id}`}>{r.title}</Link>
                    <StateBadge annotation={r.annotation} />
                  </td>
                  <td className="num">{r.track_count}</td>
                  <td><a href={r.url} target="_blank" rel="noreferrer">open</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
    </>
  );
}
```

- [ ] **Step 2: Build the Mine page**

Create `client/src/pages/Mine.jsx`:

```jsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, fmtNum } from '../api.js';
import { useAsync } from '../components/useAsync.js';
import { StateBadge } from './SeriesShows.jsx';

const VIEWS = [
  { key: 'want',     label: 'Queue',        params: { want: 'true' } },
  { key: 'listened', label: 'Listened',     params: { listened: 'true' } },
  { key: 'good',     label: 'Rated 4+',     params: { ratingMin: 4 } },
];

export default function Mine() {
  const [view, setView] = useState('want');
  const [tag, setTag] = useState('');
  const [page, setPage] = useState(1);

  const tags = useAsync(() => api.tags(), []);
  const params = { ...VIEWS.find(v => v.key === view).params, ...(tag ? { tag } : {}) };

  // Every series at once: the queue is not a per-series idea.
  const series = useAsync(() => api.series(), []);
  const shows = useAsync(
    async () => {
      if (!series.data) return null;
      const pages = await Promise.all(
        series.data.map(s => api.shows(s.slug, { pageSize: 500, ...params })
          .then(r => r.rows.map(row => ({ ...row, series_name: s.name, series_slug: s.slug })))));
      return pages.flat().sort((a, b) => (b.show_date ?? '').localeCompare(a.show_date ?? ''));
    },
    [series.data, view, tag, page]);

  if (series.error) return <p className="err">{series.error.message}</p>;
  if (shows.loading || series.loading) return <p className="empty">Loading…</p>;
  if (shows.error) return <p className="err">{shows.error.message}</p>;

  const rows = shows.data ?? [];

  return (
    <>
      <h1>Mine</h1>
      <p className="sub">{fmtNum(rows.length)} shows</p>

      <div className="filters" role="group" aria-label="View">
        {VIEWS.map(v => (
          <button key={v.key} type="button"
                  className={v.key === view ? 'chip on' : 'chip'}
                  aria-pressed={v.key === view}
                  onClick={() => { setView(v.key); setPage(1); }}>{v.label}</button>
        ))}
        {(tags.data ?? []).length > 0 && (
          <select value={tag} onChange={e => setTag(e.target.value)} aria-label="Filter by tag">
            <option value="">All tags</option>
            {tags.data.map(t => (
              <option key={t.tag} value={t.tag}>{t.tag} ({t.count})</option>
            ))}
          </select>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="empty">
          Nothing here yet. Open a show and mark it to start building this list.
        </p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Date</th><th>Series</th><th>Title</th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td className="date">{fmtDate(r.show_date)}</td>
                  <td><Link to={`/series/${r.series_slug}`}>{r.series_name}</Link></td>
                  <td>
                    <Link to={`/shows/${r.id}`}>{r.title}</Link>
                    <StateBadge annotation={r.annotation} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
```

Fetching every series and concatenating is deliberate: at 7 series and 2,696 shows this is a handful of requests against a local SQLite file, and it avoids adding a cross-series route to the API for one page. If the archive ever grows an order of magnitude, that is the point to add `GET /api/annotated`.

- [ ] **Step 3: Route and link it**

In `client/src/App.jsx`, add the import:

```jsx
import Mine from './pages/Mine.jsx';
```

add the nav link after the Artists one:

```jsx
            <NavLink to="/mine">Mine</NavLink>
```

and the route before the `*` catch-all:

```jsx
          <Route path="/mine" element={<Mine />} />
```

- [ ] **Step 4: Style the chips and badges**

Append to `client/src/styles.css`:

```css
.filters { display: flex; gap: .4rem; flex-wrap: wrap; align-items: center; margin: .75rem 0; }
.chip { font: inherit; font-size: .85rem; padding: .25rem .7rem; cursor: pointer;
        border: 1px solid var(--muted); border-radius: 6px;
        background: transparent; color: inherit; }
.chip.on { border-color: currentColor; font-weight: 600; }
.badges { display: inline-flex; gap: .3rem; margin-left: .5rem; vertical-align: middle; }
.badge { font-size: .75rem; color: var(--muted); border: 1px solid var(--muted);
         border-radius: 4px; padding: 0 .3rem; }
.tagbadge { border-radius: 999px; }
```

- [ ] **Step 5: Check it by hand**

```bash
npm run dev
```
Verify at http://localhost:5173: badges appear on annotated rows in a series; each filter chip changes the count; "Mine" lists the queue; the tag dropdown narrows it; the empty state reads sensibly when nothing is marked. Stop the server.

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages client/src/App.jsx client/src/styles.css
git commit -m "feat: annotation badges, show filters and the Mine page"
```

---

### Task 10: Terraform — Firestore, IAP, IAM

Nothing here is applied by CI. These are changes to the configuration; the applies happen in Task 11's rollout.

**Files:**
- Modify: `infra/main.tf`
- Modify: `infra/cloud_run.tf`
- Modify: `infra/variables.tf`
- Modify: `infra/outputs.tf`

**Interfaces:**
- Consumes: `IAP_AUDIENCE`, `OWNER_EMAIL` read by `server/src/index.js` (Task 4)
- Produces: Terraform outputs `iap_audience`, `owner_email`

- [ ] **Step 1: Add the variables**

In `infra/variables.tf`, add:

```hcl
variable "owner_email" {
  type        = string
  description = "The single Google account allowed through IAP, and the key annotations are stored under."
}

variable "firestore_location" {
  type        = string
  description = "Firestore location. Cannot be changed after the database is created."
  default     = "eur3"
}
```

and change two existing defaults:

```hcl
# in variable "max_instances"
  # One instance keeps the in-process annotation temp table authoritative: a
  # write on one instance would otherwise leave another serving stale rows.
  default     = 1

# in variable "allow_public_access"
  default     = false
```

- [ ] **Step 2: Enable the APIs and create Firestore**

In `infra/main.tf`, add to `local.required_apis`:

```hcl
    "firestore.googleapis.com",
    "iap.googleapis.com",
```

and append:

```hcl
# ---- the annotation store ---------------------------------------------------

resource "google_firestore_database" "annotations" {
  project     = var.project_id
  name        = "(default)"
  location_id = var.firestore_location
  type        = "FIRESTORE_NATIVE"

  # The archive is rebuildable from the CSVs; annotations are not.
  delete_protection_state = "DELETE_PROTECTION_ENABLED"

  depends_on = [google_project_service.required]
}

# The runtime identity stops being role-less: it now reads and writes its own
# annotations. Still nothing else.
resource "google_project_iam_member" "runtime_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

# ---- IAP --------------------------------------------------------------------

# IAP calls the service on the user's behalf, so it needs its own invoker grant.
resource "google_cloud_run_v2_service_iam_member" "iap_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.app.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-iap.iam.gserviceaccount.com"
}

# Who is allowed through the front door.
resource "google_iap_web_cloud_run_service_iam_member" "owner" {
  project                = var.project_id
  location               = var.region
  cloud_run_service_name = google_cloud_run_v2_service.app.name
  role                   = "roles/iap.httpsResourceAccessor"
  member                 = "user:${var.owner_email}"
}

# The deploy identity needs it too, or the post-deploy healthcheck 403s.
resource "google_iap_web_cloud_run_service_iam_member" "deployer" {
  project                = var.project_id
  location               = var.region
  cloud_run_service_name = google_cloud_run_v2_service.app.name
  role                   = "roles/iap.httpsResourceAccessor"
  member                 = "serviceAccount:${google_service_account.deployer.email}"
}
```

Run `terraform validate` after this step; if the `google_iap_web_cloud_run_service_iam_member` argument names differ in provider 8.3.0, take them from `terraform providers schema -json | jq '.provider_schemas[].resource_schemas.google_iap_web_cloud_run_service_iam_member'` rather than guessing.

- [ ] **Step 3: Turn IAP on and pass the audience to the container**

In `infra/cloud_run.tf`, add to the service body, beside `ingress`:

```hcl
  iap_enabled = true
```

and inside `containers`, after the `ports` block:

```hcl
      env {
        name  = "IAP_AUDIENCE"
        value = local.iap_audience
      }

      env {
        name  = "OWNER_EMAIL"
        value = var.owner_email
      }
```

Update the stale comment above `deletion_protection` — it currently claims nothing here is irreplaceable, which stopped being true the moment annotations existed:

```hcl
  # The archive is rebuildable from the CSVs. The annotations are not, but they
  # live in Firestore, which has its own delete protection.
  deletion_protection = false
```

- [ ] **Step 4: Emit the audience**

In `infra/main.tf`, add to the `locals` block:

```hcl
  # IAP's Cloud Run audience form. NOT the App Engine (/projects/N/apps/ID) or
  # backend-service (/projects/N/global/backendServices/ID) form that most IAP
  # sample code uses; a wrong audience is a check that passes for the wrong
  # service. See docs/superpowers/specs/2026-09-22-show-annotations-design.md.
  iap_audience = "/projects/${data.google_project.this.number}/locations/${var.region}/services/${var.service_name}"
```

and in `infra/outputs.tf`:

```hcl
output "iap_audience" {
  description = "The aud claim the server verifies on every IAP assertion."
  value       = local.iap_audience
}
```

- [ ] **Step 5: Validate**

```bash
cd infra
terraform init -upgrade
terraform fmt -check
terraform validate
```
Expected: `Success! The configuration is valid.` Do **not** apply yet — Task 11's rollout sequences the applies.

- [ ] **Step 6: Commit**

```bash
git add infra/
git commit -m "feat: Firestore, direct IAP and a single instance in Terraform"
```

---

### Task 11: CI healthcheck, README, and rollout

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes: everything above
- Produces: a green pipeline against an IAP-protected service

- [ ] **Step 1: Fix the post-deploy smoke test**

In `.github/workflows/ci.yml`, replace the `Smoke-test the deployment` step:

```yaml
      # IAP now sits in front of the service, so an unauthenticated curl gets a
      # 403 no matter how healthy the revision is. The deploy service account is
      # granted roles/iap.httpsResourceAccessor in infra/main.tf; this mints an
      # ID token for it and presents that.
      #
      # The revision only takes traffic once the startup probe passes, so a
      # failure here means the live site is broken, not merely the new build.
      - name: Smoke-test the deployment
        env:
          SERVICE_URL: ${{ steps.deploy.outputs.url }}
          IAP_CLIENT_ID: ${{ vars.GCP_IAP_CLIENT_ID }}
        run: |
          if [ -z "${IAP_CLIENT_ID}" ]; then
            echo "::notice::GCP_IAP_CLIENT_ID is unset; skipping the authenticated smoke test."
            exit 0
          fi
          token="$(gcloud auth print-identity-token \
            --audiences="${IAP_CLIENT_ID}" \
            --include-email)"
          curl --fail --silent --show-error \
            -H "Authorization: Bearer ${token}" \
            "${SERVICE_URL}/healthz"
```

`gcloud` is already set up in this job via `google-github-actions/setup-gcloud@v2` in the `image` job; add the same step to `deploy` if it is not present there:

```yaml
      - name: Set up gcloud
        uses: google-github-actions/setup-gcloud@v2
```

The step degrades to a notice rather than a failure when the variable is unset, matching how the rest of this workflow stays dormant before infra exists.

- [ ] **Step 2: Document the environment**

Append to `.env.example`:

```
# Who you are when running locally, where IAP does not exist. On Cloud Run this
# is ignored and the identity comes from the signed IAP assertion instead.
DEV_USER_EMAIL=dev@localhost

# Annotation store driver. Defaults to sqlite locally and firestore on Cloud Run.
# ANNOTATIONS_DRIVER=sqlite
# ANNOTATIONS_DB=data/annotations.sqlite
```

- [ ] **Step 3: Update the README**

Change the bullet list at the top:

```markdown
* **Data** — SQLite, committed at `data/tracklists.sqlite` and baked into the image
* **Annotations** — Firestore; listened / rating / notes / tags, keyed on `content_id`
* **Access** — the whole site is behind Cloud Run IAP; one Google account
```

Add a section after "Schema":

````markdown
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
| `IAP_AUDIENCE` | unused | required; the server refuses to boot without it |
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
````

Also correct the "Quick start (Docker)" section, which currently promises the
container needs nothing: add a line noting that `docker compose up` runs with
the SQLite annotation driver and no IAP, because `K_SERVICE` is unset.

- [ ] **Step 4: Full local verification**

```bash
npm ci
npm test
npm run build
docker compose up -d --build
curl -fsS localhost:3000/healthz
curl -fsS localhost:3000/api/me
docker compose down
```
Expected: tests pass, build succeeds, `/healthz` reports a track count, `/api/me` returns `{"email":"dev@localhost"}`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml README.md .env.example
git commit -m "docs: annotations and IAP; fix the post-deploy healthcheck for IAP"
```

- [ ] **Step 6: Roll out, in three separate steps**

Deliberately not one apply. Flipping IAP and shipping new code together turns any failure into a 403 that could mean either.

```bash
# 1. Firestore and IAM. The site is still public and still works.
cd infra
terraform apply   # review the plan: no iap_enabled yet
```

Set `owner_email` in `terraform.tfvars` first, and add it to
`terraform.tfvars.example`.

```bash
# 2. Ship the code. CI builds, deploys, health-checks.
git push -u origin show-annotations
gh pr create --fill
# merge once CI is green
```

Confirm on the live URL that annotations save and reload while the site is
still public.

```bash
# 3. Close the door.
cd infra
# set iap_enabled = true and allow_public_access = false — both already in the
# config from Task 10, so this apply is the one that activates them
terraform apply
gh variable set GCP_IAP_CLIENT_ID --body '<from the IAP settings page>'
```

Then verify, in this order:

1. Opening the URL in a signed-out browser prompts for Google sign-in.
2. Signing in as `owner_email` works and the annotations are still there.
3. Signing in as any other account is refused.
4. `curl -fsS "$SERVICE_URL/healthz"` with no token returns 403 — IAP is on.
5. The next push to `main` goes green, including the authenticated smoke test.

Rollback at any step is the inverse `terraform apply`. No data migration is
involved, so nothing here is one-way.

---

## Verification summary

At the end, all of these must hold:

- [ ] `npm test` passes, with the Firestore contract test reported as **skipped**, not absent
- [ ] `npm run build` succeeds
- [ ] `git check-ignore data/annotations.sqlite` matches; `data/tracklists.sqlite` is still tracked
- [ ] `terraform fmt -check && terraform validate` pass in `infra/`
- [ ] The archive connection is still read-only — `annotations-temp-table.test.js` asserts this directly
- [ ] `data/tracklists.sqlite` is byte-identical to its state at the start of the branch: `git diff --stat main -- data/` is empty
- [ ] An unauthenticated request to the live URL returns 403
- [ ] A listened mark set on one device is visible on another
- [ ] A notes save landing after a star click does not revert the rating
