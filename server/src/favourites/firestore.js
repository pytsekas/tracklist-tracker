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
  // A hand-made document without a timestamp must not break the list sort;
  // it sorts last.
  added_at: data.added_at ?? '',
  updated_at: data.updated_at ?? data.added_at ?? '',
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
