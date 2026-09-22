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

/**
 * A joined row's `ann_*` columns -> the API's annotation object, or null.
 * The prefix is what keeps annotation fields from colliding with the show's
 * own columns; see ANNOTATION_COLUMNS in temp-table.js.
 */
export function annotationOf(row) {
  if (row.ann_listened === null || row.ann_listened === undefined) return null;
  return {
    listened: !!row.ann_listened,
    listened_at: row.ann_listened_at,
    rating: row.ann_rating,
    notes: row.ann_notes,
    want_to_listen: !!row.ann_want_to_listen,
    tags: JSON.parse(row.ann_tags ?? '[]'),
    updated_at: row.ann_updated_at,
  };
}

/** Strip the flat `ann_*` columns off a row and nest them under `annotation`. */
export function withAnnotation(row) {
  const annotation = annotationOf(row);
  const rest = Object.fromEntries(
    Object.entries(row).filter(([k]) => !k.startsWith('ann_')));
  return { ...rest, annotation };
}
