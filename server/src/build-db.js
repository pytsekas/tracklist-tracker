import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

export const DEFAULT_CSV_DIR = path.resolve(__dirname, '../../data/csv');
export const DEFAULT_OUT     = path.resolve(__dirname, '../../data/tracklists.sqlite');

/** Create a fresh database at `file` with the schema applied. */
export function createDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}
