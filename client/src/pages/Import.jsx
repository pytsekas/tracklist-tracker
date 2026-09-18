import { useState } from 'react';
import { api, fmtNum } from '../api.js';
import { useAsync } from '../components/useAsync.js';

export default function Import() {
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [over, setOver] = useState(false);
  const history = useAsync(() => api.imports(), []);

  const pick = list => setFiles([...list].filter(f => /\.csv$/i.test(f.name)));

  async function submit() {
    if (!files.length) return;
    setBusy(true); setError(null); setResults(null);
    try {
      const res = await api.upload(files);
      setResults(res.results);
      setFiles([]);
      history.reload();
    } catch (e) { setError(e); }
    finally { setBusy(false); }
  }

  return (
    <>
      <h1>Import</h1>
      <p className="sub">Drop the <code>*_tracks.csv</code> and <code>*_shows.csv</code> files here.</p>

      <div className="note">
        The series is taken from the filename — <code>eesti_pops_tracks.csv</code> becomes
        series <code>eesti_pops</code>. Re-importing the same file is safe: shows are matched
        on their ERR episode id and their tracks are replaced, never duplicated.
      </div>

      <div
        className={`drop${over ? ' over' : ''}`}
        onDragOver={e => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files); }}
      >
        {files.length
          ? <>{files.length} file(s) ready: {files.map(f => f.name).join(', ')}</>
          : <>Drag CSV files here, or</>}
        <div style={{ marginTop: 12 }}>
          <input type="file" multiple accept=".csv" onChange={e => pick(e.target.files)} />
        </div>
      </div>

      <div className="controls" style={{ marginTop: 18 }}>
        <button className="primary" disabled={!files.length || busy} onClick={submit}>
          {busy ? 'Importing…' : `Import ${files.length || ''}`.trim()}
        </button>
        {files.length > 0 && <button onClick={() => setFiles([])} disabled={busy}>Clear</button>}
      </div>

      {error && <p className="err">{error.message}</p>}

      {results && (
        <>
          <h2>Result</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>File</th><th>Kind</th><th>Series</th><th className="num">Rows</th>
                    <th className="num">Shows</th><th className="num">Tracks</th>
                    <th className="num">New artists</th><th className="num">Skipped</th><th>Status</th></tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i}>
                    <td>{r.filename}</td><td>{r.kind}</td><td>{r.series_slug}</td>
                    <td className="num">{fmtNum(r.rows_read)}</td>
                    <td className="num">{fmtNum(r.shows_upserted)}</td>
                    <td className="num">{fmtNum(r.tracks_inserted)}</td>
                    <td className="num">{fmtNum(r.artists_created)}</td>
                    <td className="num">{fmtNum(r.skipped)}</td>
                    <td className={r.ok ? '' : 'err'}>{r.ok ? 'ok' : r.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>Recent imports</h2>
      {history.data?.length
        ? (
          <div className="table-scroll">
            <table>
              <thead><tr><th>When</th><th>File</th><th>Series</th><th className="num">Shows</th><th className="num">Tracks</th><th>Status</th></tr></thead>
              <tbody>
                {history.data.map(r => (
                  <tr key={r.id}>
                    <td className="date">{new Date(r.created_at).toLocaleString('et-EE')}</td>
                    <td>{r.filename}</td><td>{r.series_slug}</td>
                    <td className="num">{fmtNum(r.shows_upserted)}</td>
                    <td className="num">{fmtNum(r.tracks_inserted)}</td>
                    <td className={r.ok ? '' : 'err'}>{r.ok ? 'ok' : r.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
        : <p className="empty">No imports yet.</p>}
    </>
  );
}
