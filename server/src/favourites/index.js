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
