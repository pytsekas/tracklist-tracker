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
// A configured audience means "verify", on any platform -- not just Cloud
// Run. Keying the dev-identity fallback on the platform marker alone let a
// future non-Cloud-Run deploy that sets IAP_AUDIENCE silently serve
// dev@localhost instead of checking the assertion.
const devEmail = (onCloudRun || audience) ? null : (process.env.DEV_USER_EMAIL || 'dev@localhost');

if (onCloudRun && !audience) {
  console.error('IAP_AUDIENCE is unset. Refusing to start unauthenticated.');
  process.exit(1);
}

// Whose annotations this process serves, and (via requireOwner, below) the
// only identity allowed to use the API at all. Locally this is always the dev
// identity itself -- devEmail wins over OWNER_EMAIL here whenever it is set,
// so requireOwner is a no-op there by construction, matching that IAP (and
// therefore any notion of "owner") does not exist on localhost. The gate only
// starts doing real work once IAP verification is actually in play, whether
// via IAP_AUDIENCE locally or K_SERVICE on Cloud Run, where devEmail is null
// and req.user.email comes from a signed assertion instead of this fallback.
const owner = devEmail ?? process.env.OWNER_EMAIL;

if (onCloudRun && !owner) {
  console.error('OWNER_EMAIL is unset. Refusing to start with no owner to gate the API to.');
  process.exit(1);
}

// This is a single-user site: the durable store and the temp table are both
// keyed on one owner throughout, and the temp table has no owner column at
// all. requireOwner is what makes that true rather than merely assumed --
// without it, anyone IAP lets through (the deploy service account already
// holds roles/iap.httpsResourceAccessor, for the post-deploy healthcheck)
// could read the owner's annotations out of the shared temp table, even
// though only the owner could ever write to it. Gating reads too, not just
// the write routes, is deliberate for that reason. Adding an owner column
// instead would turn this into a half-built multi-user design; one owner per
// process, enforced here in the one place that already knows who it is, is
// the honest single-user one.
function requireOwner(req, res, next) {
  // Case-insensitively: Google account emails aren't case-sensitive, so an
  // OWNER_EMAIL configured with different casing than IAP reports must not
  // lock the real owner out. `owner` can be unset (see the fatal check above,
  // which only applies on Cloud Run) — guarded rather than compared directly,
  // so a missing owner 403s instead of throwing on `undefined.toLowerCase()`.
  // Warn on a mismatch the same way auth.js already does for a rejected
  // assertion — a bare 403 here would otherwise look like a bug rather than a
  // configuration mismatch, with no way to tell them apart from the log.
  if (!owner || req.user.email.toLowerCase() !== owner.toLowerCase()) {
    console.warn(`rejected non-owner ${req.user.email} (owner is ${owner ?? 'unset'})`);
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

app.use('/api', requireUser({ audience, devEmail }), requireOwner, routes);

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
  // A failed annotation write is the store being unreachable, not a bug in the
  // request: say so, so the client can keep the user's text instead of clearing it.
  const status = err.code === 'ANNOTATION_STORE_UNAVAILABLE' ? 502 : 500;
  res.status(status).json({ error: err.message });
});

const port = Number(process.env.PORT || 3000);

// Fatal: the archive is the product. If it cannot be opened, or the temp
// table it hosts can't be created, there is nothing to serve.
let handle;
try {
  handle = openDb();
  console.log(`opened ${DB_PATH}`);
  createAnnotationTable(handle);
} catch (err) {
  console.error(`cannot open database at ${DB_PATH}: ${err.message}`);
  console.error('run `npm run build:db` first');
  process.exit(1);
}

// Non-fatal: annotations are a personal layer on top of the archive, not the
// archive itself. Fail the request, not the process — the archive stays
// fully readable even if the annotation store can't be constructed or
// loaded. If the store never gets set, getStore() throws when called: reads
// keep returning null annotations against the (empty) temp table, and writes
// (Task 5) surface a loud error rather than silently no-op against nothing.
try {
  const store = await createStore();
  setStore(store);

  if (owner) {
    loadAnnotations(handle, await store.list(owner));
  }
} catch (err) {
  console.error(`annotation store unavailable at boot: ${err.message}`);
}

app.listen(port, () => console.log(`api + ui listening on :${port}`));
