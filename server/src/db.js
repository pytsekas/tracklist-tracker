import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The baked database. Built at image build time by build-db.js. */
export const DB_PATH =
  process.env.DB_PATH || path.resolve(__dirname, '../../data/tracklists.sqlite');

let handle = null;

/**
 * Open the database read-only. Throws if the file is missing, which is what we
 * want: a container with no data should fail at boot rather than serve an
 * empty archive.
 */
export function openDb(file = DB_PATH) {
  handle = new Database(file, { readonly: true, fileMustExist: true });
  return handle;
}

/** The open handle. Throws if openDb() has not been called yet. */
export function db() {
  if (!handle) throw new Error('database not opened; call openDb() first');
  return handle;
}
