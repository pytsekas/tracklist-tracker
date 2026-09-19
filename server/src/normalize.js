/**
 * Fold a string for case-insensitive search.
 *
 * JavaScript's toLowerCase() is Unicode-aware, so Õ -> õ and Ä -> ä. This is
 * what MariaDB's utf8mb4_unicode_ci collation gave us for free; SQLite's LIKE
 * only folds ASCII, so we precompute this into *_norm columns instead.
 *
 * Diacritics are preserved on purpose: in Estonian õ, ä, ö and ü are distinct
 * letters, so "magi" must not match "Mägi".
 */
export const norm = s => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Escape the LIKE metacharacters in a search needle so a query for "50%"
 * matches a literal percent sign instead of every row. Pair with ESCAPE '\'.
 */
export const likeEscape = s => String(s ?? '').replace(/[\\%_]/g, c => `\\${c}`);
