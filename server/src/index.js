import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import routes from './routes.js';
import { openDb, db, DB_PATH } from './db.js';
import { createStore, setStore } from './annotations/index.js';
import { createAnnotationTable, loadAnnotations } from './annotations/temp-table.js';
import { requireUser } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());

// On Cloud Run, IAP is the only gate; refuse to boot without the audience
// rather than serving the archive to anyone who asks.
const onCloudRun = Boolean(process.env.K_SERVICE);
const audience = process.env.IAP_AUDIENCE || null;
const devEmail = onCloudRun ? null : (process.env.DEV_USER_EMAIL || 'dev@localhost');

if (onCloudRun && !audience) {
  console.error('IAP_AUDIENCE is unset. Refusing to start unauthenticated.');
  process.exit(1);
}

app.use('/api', requireUser({ audience, devEmail }), routes);

app.get('/healthz', (_req, res) => {
  try {
    const { n } = db().prepare('SELECT COUNT(*) AS n FROM tracks').get();
    if (n === 0) return res.status(503).json({ ok: false, error: 'database is empty' });
    res.json({ ok: true, tracks: n });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

// serve the built React app when it exists (production image)
const clientDist = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api|\/healthz).*/, (_req, res) =>
    res.sendFile(path.join(clientDist, 'index.html')));
}

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.PORT || 3000);

try {
  const handle = openDb();
  console.log(`opened ${DB_PATH}`);

  const store = await createStore();
  setStore(store);
  createAnnotationTable(handle);

  const owner = devEmail ?? process.env.OWNER_EMAIL;
  if (owner) {
    // Best-effort: the archive is the product and stays readable even if the
    // annotation store is unreachable.
    try {
      loadAnnotations(handle, await store.list(owner));
    } catch (err) {
      console.error(`could not load annotations: ${err.message}`);
    }
  }
} catch (err) {
  console.error(`cannot open database at ${DB_PATH}: ${err.message}`);
  console.error('run `npm run build:db` first');
  process.exit(1);
}

app.listen(port, () => console.log(`api + ui listening on :${port}`));
