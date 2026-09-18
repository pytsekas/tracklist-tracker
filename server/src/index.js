import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import routes from './routes.js';
import { migrate, waitForDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use('/api', routes);

app.get('/healthz', (_req, res) => res.json({ ok: true }));

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
  const tooBig = err.code === 'LIMIT_FILE_SIZE';
  res.status(tooBig ? 413 : 500).json({ error: err.message });
});

const port = Number(process.env.PORT || 3000);
await waitForDb();
await migrate();
app.listen(port, () => console.log(`api + ui listening on :${port}`));
