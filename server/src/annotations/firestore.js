import { Firestore } from '@google-cloud/firestore';
import { EMPTY, applyPatch, unavailable } from './store.js';

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

// The SDK retries a downed backend on its own before ever rejecting — up to
// ~42s to exhaust its retries on a read, verified empirically against a host
// that refuses every connection. That budget comes from a lookup internal to
// the SDK (`getServiceConfig` in @google-cloud/firestore's util.js, which
// constructs its retry config with `{}` as the override argument — hardcoded,
// not sourced from anything passed to the `Firestore` constructor), so it
// cannot be shortened through public settings. Left alone, a Firestore outage
// would make every annotation write hang for ~42s before the 502 the spec
// promises, burning Cloud Run request time for nothing. Racing every call
// against a short, driver-owned deadline is the only way to keep that
// promise; the timeout is a production feature, not a test device.
const FIRESTORE_TIMEOUT_MS = 5000;

function withTimeout(promise, ms, label) {
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
    // The loser is a real call the SDK may still be retrying in the
    // background, and an abandoned runTransaction can still go on to commit —
    // the client already got its 502 and moved on, so a late success here
    // must not surface as an unhandled rejection. The warning is gated on
    // `firedLate`, not just on `promise` resolving: without that guard, an
    // ordinary call that wins the race well inside `ms` would also log "after
    // its deadline had already fired", which is false, and at request rate
    // that false line would drown out the one case this exists to catch.
    promise.then(
      () => { if (firedLate) console.warn(`Firestore ${label} completed after its ${ms}ms deadline had already fired`); },
      () => {});
  });
}

/**
 * Production driver. Credentials come from Application Default Credentials —
 * on Cloud Run that is the runtime service account, so nothing is configured
 * here and no key is stored anywhere.
 *
 * One document per *annotated* show, not per show: a cold start reads only what
 * has actually been marked, which keeps the boot load inside the free tier.
 *
 * `client` and `timeoutMs` exist for tests: a caller can inject a stub in
 * place of a real `Firestore` client, and shorten the timeout, so the failure
 * and timeout paths can be exercised in milliseconds instead of dialling a
 * real (or deliberately unreachable) backend. Production code never sets
 * either — `annotations/index.js` calls this with only `{ projectId }`.
 */
export function createFirestoreStore({
  projectId,
  client = null,
  timeoutMs = FIRESTORE_TIMEOUT_MS,
} = {}) {
  const db = client ?? new Firestore({ projectId });

  // Firestore document ids are strings; content_id is an integer everywhere
  // else, so conversion happens here and nowhere else.
  const shows = owner => db.collection('annotations').doc(owner).collection('shows');

  return {
    async list(owner) {
      try {
        const snap = await withTimeout(shows(owner).get(), timeoutMs, 'list');
        return new Map(snap.docs.map(d => [Number(d.id), toAnnotation(d.data())]));
      } catch (err) { throw unavailable(err); }
    },

    async get(owner, contentId) {
      try {
        const doc = await withTimeout(shows(owner).doc(String(contentId)).get(), timeoutMs, 'get');
        return doc.exists ? toAnnotation(doc.data()) : null;
      } catch (err) { throw unavailable(err); }
    },

    async merge(owner, contentId, patch) {
      try {
        const ref = shows(owner).doc(String(contentId));
        // A transaction, not a plain set({merge:true}): applyPatch needs the
        // current value to decide listened_at, and a read-then-write without
        // one can lose a concurrent field update.
        const run = db.runTransaction(async tx => {
          const doc = await tx.get(ref);
          const next = applyPatch(doc.exists ? toAnnotation(doc.data()) : { ...EMPTY }, patch);
          tx.set(ref, next);
          return next;
        });
        return await withTimeout(run, timeoutMs, 'merge');
      } catch (err) { throw unavailable(err); }
    },

    async remove(owner, contentId) {
      try {
        await withTimeout(shows(owner).doc(String(contentId)).delete(), timeoutMs, 'remove');
      } catch (err) { throw unavailable(err); }
    },

    close() { return db.terminate(); },
  };
}
