import { Link } from 'react-router-dom';
import { api, fmtDate, fmtNum } from '../api.js';
import { useAsync } from '../components/useAsync.js';

export default function Home() {
  const stats = useAsync(() => api.stats(), []);
  const series = useAsync(() => api.series(), []);

  if (series.loading) return <p className="empty">Laadin…</p>;
  if (series.error) return <p className="err">{series.error.message}</p>;

  const s = stats.data;
  return (
    <>
      <h1>Sarjad</h1>
      <p className="sub">ERR-i saatelugude nimekirjadest imporditud raadiosaated.</p>

      {s && (
        <div className="stats">
          <div className="stat"><div className="n">{fmtNum(s.series)}</div><div className="l">sarja</div></div>
          <div className="stat"><div className="n">{fmtNum(s.shows)}</div><div className="l">saadet</div></div>
          <div className="stat"><div className="n">{fmtNum(s.tracks)}</div><div className="l">lugu</div></div>
          <div className="stat"><div className="n">{fmtNum(s.artists)}</div><div className="l">esitajat</div></div>
        </div>
      )}

      {series.data.length === 0 ? (
        <p className="empty">
          Lugude nimekirju pole laaditud. Arhiiv ehitatakse rakenduse ehitamisel{' '}
          <code>data/csv/</code> CSV-failidest; kohapeal käivitades vaata README-d.
        </p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Sari</th><th className="num">Saateid</th><th className="num">Lugusid</th><th>Esimene</th><th>Viimane</th></tr>
            </thead>
            <tbody>
              {series.data.map(r => (
                <tr key={r.id}>
                  <td><Link to={`/series/${r.slug}`}>{r.name}</Link></td>
                  <td className="num">{fmtNum(r.show_count)}</td>
                  <td className="num">{fmtNum(r.track_count)}</td>
                  <td className="date">{fmtDate(r.first_show)}</td>
                  <td className="date">{fmtDate(r.last_show)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
