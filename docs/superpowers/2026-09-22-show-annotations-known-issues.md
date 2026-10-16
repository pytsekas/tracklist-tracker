# Deferred findings — for the final whole-branch review to triage

Every item below was found by a task review, graded Minor, and deliberately not
fixed at the time. None blocked its task. The question for the final review is
narrower than "is this a defect": **which of these should be fixed before this
branch merges, and which are fine to live with?**

One is already scoped with a ready fix. One is a decision for the user, not a
fix at all.

Rating and tags were removed from annotations on 2026-10-16, so the items that
were only about the `tag` and `ratingMin` query parameters and the tag select
no longer apply and have been removed from this list.

## Test and coverage

1. **`unavailable()` has no direct test.** It and its four call sites in
   `sqlite.js` are never exercised by a test that forces a driver failure. Partly
   covered downstream: Task 7's stub tests assert the code for the Firestore
   driver, and Task 5's uninitialised-store tests assert the 502 it produces.

2. **`get()` and `remove()` failure paths are not stub-tested** in the Firestore
   driver; only `list()` and `merge()` are. Identical `try/catch` shape.

3. **Test output is not pristine.** Three `console.warn` lines from
   `server/src/auth.js:61` appear during the run, from the middleware failure-path
   tests. Specified behaviour, not stray noise — but the suite's output is noisy.
   Fixing it means injecting a logger rather than suppressing the warning.

4. **A test name is broader than its assertions.** "annotations do not disturb
   the existing show fields" checks total, order and count, not individual field
   values. Wording from the brief.

## Code shape

5. **Identical `try/catch` wrapper repeated four times** in `sqlite.js`; a
   `withUnavailable(fn)` helper would collapse it. Verbatim from the brief.

6. **Redundant `Number(contentId)` conversions** in `get()`, `merge()` and
    `remove()` of `sqlite.js` —
    better-sqlite3 already returns and accepts JS numbers for INTEGER columns.

7. **`close()` returns a Promise in `firestore.js`, synchronous in `sqlite.js`.**
    No caller awaits or inspects it and production never calls it, so nothing is
    broken — but it is a real interface-shape divergence between two drivers
    required to be interchangeable.

8. **The `settings` constructor parameter in `firestore.js` is dead surface.**
    It existed for the host override in the unreachable-host test the controller
    withdrew. Controller's leftover, not the implementer's.

9. **`iapKeys(url)` memoises on first call and ignores its argument thereafter**
    (`auth.js:10-13`). No caller passes a URL today.

10. **`statusFor(err)` is computed twice per rejected request** (`auth.js:62-63`).
    Pure function, harmless.

11. **`ANNOTATION_COLUMNS` / `ANNOTATION_JOIN` are plain strings** with no guard
    that a consuming route aliases `shows` as `sh`; a route that forgets fails
    with an opaque SQLite error. The contract is documented in the module comment.

12. **No graceful shutdown closes the annotation store.** Pre-existing pattern —
    `db()` is the same — so not a regression.

13. **Neither write handler guards the far edge** where `upsertAnnotationRow` /
    `removeAnnotationRow` throws *after* a successful store write. Accepted and
    now documented in code comments at both handlers; same process, same
    connection, temp table just created.

## Not a fix — a decision for the user

14. **`firestore_location` defaults to `"eur3"`**, a Europe multi-region, while
    Cloud Run runs in `europe-north1`, which is itself an available Firestore
    location. **Irreversible after the database is created.** Multi-region costs
    more and is more durable; regional co-locates. Being surfaced to the user
    rather than decided silently.

## Pre-existing, untouched by this branch

15. **MySQL-era leftovers in the sample config file.** From the MariaDB→SQLite
    migration, not this work. Flagged by Task 11's implementer as out of scope.

16. **The `/api/artists` rows-vs-count mismatch.** The rows query joins through
    `tracks` so it returns only artists with plays, while `total` counts every
    matching artist. Explicitly out of scope for this plan and left alone; every
    new query in this branch was checked for the same shape and none introduced
    one.

## Added after Task 11's review — documentation

17. **An inverted clause about when the guarantee holds.** `infra/README.md:244`
    attaches "in steady state" to "would serve stale rows", which literally says
    staleness happens in steady state — the opposite of the point.
    `README.md:184` gets the clause order right. Graded a wording nit by the
    reviewer; I rate it higher, because it states the reverse of the truth in a
    document read during rollout. **Ready fix:** reorder the clause to match
    `README.md:184`.

18. **`/healthz` is unaccounted for in the Access sentence.** `README.md:213`
    says "since IAP is what protects the static bundle", but `/healthz`
    (`server/src/index.js:29`) is neither `/api` nor the bundle. It is also
    IAP-protected, and `infra/README.md:199-217` covers the case, so no reader
    ends up wrong.

19. **"These two names" sits above one name** in the sample config file, with
    the other pair below, so the count reads oddly.

20. **A commented `ANNOTATIONS_DB` relative path resolves against `server/`,**
    not the repo root, under `npm run dev`. The code's own default
    (`server/src/annotations/index.js:36`) resolves correctly, so this only
    bites someone who uncomments the line.

21. **One unverifiable claim.** `infra/README.md:195-197` names the Cloud
    Console path for the IAP client id (Security → Identity-Aware Proxy). It
    cannot be checked from this repo. Plausible, correctly gated on "once IAP is
    on", and the placeholder stays an honest placeholder.

## Also for triage — not a code finding

22. **Two non-reproducing transient test failures** occurred during this plan,
    in Tasks 8 and 11. Both were in tests that spin up servers or build fixture
    databases; neither reproduced across five consecutive runs afterwards. Task
    8's traced to stray `node --watch` processes; Task 11's attribution to
    concurrent work is probably wrong, since Task 10 had closed. Possible latent
    flakiness under load. Flagged rather than dismissed a second time.
