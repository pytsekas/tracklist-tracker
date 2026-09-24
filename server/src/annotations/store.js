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

/**
 * Wrap a driver failure so the error handler can tell "the store is
 * unreachable" (502, worth retrying) from "this request is wrong" (400).
 * Lives here rather than in each driver so there is one copy, not one per
 * backend.
 */
export function unavailable(err) {
  const wrapped = new Error(`annotation store unavailable: ${err.message}`);
  wrapped.code = 'ANNOTATION_STORE_UNAVAILABLE';
  wrapped.cause = err;
  return wrapped;
}
