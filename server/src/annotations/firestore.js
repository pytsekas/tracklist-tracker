import { Firestore } from '@google-cloud/firestore';
import { EMPTY, applyPatch, unavailable } from './store.js';
import { withTimeout, FIRESTORE_TIMEOUT_MS } from '../firestore-timeout.js';

/** Firestore doc -> Annotation. Absent fields fall back to EMPTY's defaults. */
const toAnnotation = data => ({
  listened: data.listened ?? false,
  listened_at: data.listened_at ?? null,
  notes: data.notes ?? null,
  want_to_listen: data.want_to_listen ?? false,
  updated_at: data.updated_at ?? null,
});

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
