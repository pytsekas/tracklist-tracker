import { Link } from 'react-router-dom';
import { api, fmtDate, fmtNum } from '../api.js';
import { useAsync } from '../components/useAsync.js';

export default function Home() {
  const stats = useAsync(() => api.stats(), []);
  const series = useAsync(() => api.series(), []);

  if (series.loading) return <p className="empty">Loading…</p>;
  if (series.error) return <p className="err">{series.error.message}</p>;

  const s = stats.data;
  return (
    <>
      <h1>Series</h1>
      <p className="sub">Radio shows imported from the ERR tracklist scrapes.</p>

      {s && (
        <div className="stats">
          <div className="stat"><div className="n">{fmtNum(s.series)}</div><div className="l">series</div></div>
          <div className="stat"><div className="n">{fmtNum(s.shows)}</div><div className="l">shows</div></div>
          <div className="stat"><div className="n">{fmtNum(s.tracks)}</div><div className="l">tracks</div></div>
          <div className="stat"><div className="n">{fmtNum(s.artists)}</div><div className="l">artists</div></div>
        </div>
      )}

      {series.data.length === 0 ? (
        <p className="empty">
          No tracklists loaded. The archive is built from the CSV files in{' '}
          <code>data/csv/</code> when the app is built — see the README if you are
          running this locally.
        </p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Series</th><th className="num">Shows</th><th className="num">Tracks</th><th>First</th><th>Last</th></tr>
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
