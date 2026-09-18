import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, fmtNum } from '../api.js';
import { useAsync } from '../components/useAsync.js';
import Pager from '../components/Pager.jsx';

export default function Tracks() {
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [series, setSeries] = useState('');
  const [page, setPage] = useState(1);

  // debounce typing so we aren't querying 38k rows on every keystroke
  useEffect(() => {
    const t = setTimeout(() => { setQ(input); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [input]);

  const list = useAsync(() => api.series(), []);
  const { data, error, loading } = useAsync(
    () => api.tracks({ q, series, page, pageSize: 100 }), [q, series, page]);

  return (
    <>
      <h1>Tracks</h1>
      <p className="sub">Search across every imported show by artist or title.</p>

      <div className="controls">
        <input type="search" placeholder="Artist or title…" value={input}
               onChange={e => setInput(e.target.value)} />
        <select value={series} onChange={e => { setSeries(e.target.value); setPage(1); }}>
          <option value="">All series</option>
          {(list.data || []).map(s => <option key={s.slug} value={s.slug}>{s.name}</option>)}
        </select>
      </div>

      {error && <p className="err">{error.message}</p>}
      {loading && <p className="empty">Loading…</p>}

      {data && (
        <>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Artist</th><th>Title</th><th>Series</th><th>Date</th></tr></thead>
              <tbody>
                {data.rows.map(r => (
                  <tr key={r.id}>
                    <td>{r.artist_id
                      ? <Link to={`/artists/${r.artist_id}`}>{r.artist}</Link>
                      : <span style={{ color: 'var(--muted)' }}>unknown</span>}</td>
                    <td><Link to={`/shows/${r.show_id}`}>{r.title}</Link></td>
                    <td>{r.series_name}</td>
                    <td className="date">{fmtDate(r.show_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.rows.length === 0 && <p className="empty">No matches.</p>}
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}
    </>
  );
}
