import mysql from 'mysql2/promise';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'tracklists',
  password: process.env.DB_PASSWORD || 'tracklists',
  database: process.env.DB_NAME || 'tracklists',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  // lets the importer send multi-row INSERTs efficiently
  namedPlaceholders: false,
});

/** Wait for MariaDB to accept connections (compose healthcheck covers most of it). */
export async function waitForDb(attempts = 30, delayMs = 2000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const c = await pool.getConnection();
      await c.ping();
      c.release();
      return;
    } catch (err) {
      if (i === attempts) throw err;
      console.log(`db not ready (${err.code || err.message}) - retry ${i}/${attempts}`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

/** Apply schema.sql. Every statement is idempotent, so this runs on every boot. */
export async function migrate() {
  const sql = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = sql
    .split(/;\s*$/m)
    .map(s => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
  for (const stmt of statements) await pool.query(stmt);
  console.log(`schema applied (${statements.length} statements)`);
}
