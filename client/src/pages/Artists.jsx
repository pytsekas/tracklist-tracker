import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtNum } from '../api.js';
import { useAsync } from '../components/useAsync.js';
import Pager from '../components/Pager.jsx';

export default function Artists() {
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => { setQ(input); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [input]);

  const { data, error, loading } = useAsync(
    () => api.artists({ q, page, pageSize: 100 }), [q, page]);

  return (
    <>
      <h1>Esitajad</h1>
      <p className="sub">Järjestatud esituste arvu järgi.</p>

      <div className="controls">
        <input type="search" placeholder="Esitaja nimi…" value={input}
               aria-label="Otsi esitajaid"
               onChange={e => setInput(e.target.value)} />
      </div>

      {error && <p className="err">{error.message}</p>}
      {loading && <p className="empty">Laadin…</p>}

      {data && (
        <>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Esitaja</th><th className="num">Esitusi</th><th className="num">Sarju</th></tr></thead>
              <tbody>
                {data.rows.map(r => (
                  <tr key={r.id}>
                    <td><Link to={`/artists/${r.id}`}>{r.name}</Link>
                      {r.favourite_id && (
                        <span className="badges">
                          <span className="badge" title="Põnev" aria-label="Põnev">★</span>
                        </span>
                      )}
                    </td>
                    <td className="num">{fmtNum(r.plays)}</td>
                    <td className="num">{r.series_count}</td>
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
