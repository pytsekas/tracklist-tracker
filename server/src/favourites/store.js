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
