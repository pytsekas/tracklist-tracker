import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, fmtNum } from '../api.js';
import { useAsync } from '../components/useAsync.js';
import Pager from '../components/Pager.jsx';
import FavouriteButton from '../components/FavouriteButton.jsx';

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
      <h1>Lood</h1>
      <p className="sub">Otsi kõigist imporditud saadetest esitaja või pealkirja järgi.</p>

      <div className="controls">
        <input type="search" placeholder="Esitaja või pealkiri…" value={input}
               onChange={e => setInput(e.target.value)} />
        <select value={series} onChange={e => { setSeries(e.target.value); setPage(1); }}>
          <option value="">Kõik sarjad</option>
          {(list.data || []).map(s => <option key={s.slug} value={s.slug}>{s.name}</option>)}
        </select>
      </div>

      {error && <p className="err">{error.message}</p>}
      {loading && <p className="empty">Laadin…</p>}

      {data && (
        <>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Esitaja</th><th>Pealkiri</th><th>Sari</th><th>Kuupäev</th><th></th></tr></thead>
              <tbody>
                {data.rows.map(r => (
                  <tr key={r.id}>
                    <td>{r.artist_id
                      ? <Link to={`/artists/${r.artist_id}`}>{r.artist}</Link>
                      : <span style={{ color: 'var(--muted)' }}>teadmata</span>}</td>
                    <td><Link to={`/shows/${r.show_id}`}>{r.title}</Link></td>
                    <td>{r.series_name}</td>
                    <td className="date">{fmtDate(r.show_date)}</td>
                    <td>
                      <FavouriteButton favouriteId={r.favourite_id}
                                       add={{ kind: 'song', track_id: r.id }}
                                       name={`${r.artist ?? 'teadmata'} – ${r.title}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.rows.length === 0 && <p className="empty">Vasteid ei ole.</p>}
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}
    </>
  );
}
