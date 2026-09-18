import { Link, useParams } from 'react-router-dom';
import { api, fmtDate, fmtNum } from '../api.js';
import { useAsync } from '../components/useAsync.js';

export default function Artist() {
  const { id } = useParams();
  const { data, error, loading } = useAsync(() => api.artist(id), [id]);

  if (loading) return <p className="empty">Loading…</p>;
  if (error) return <p className="err">{error.message}</p>;

  const { artist, tracks } = data;
  const distinct = new Set(tracks.map(t => t.title.toLowerCase())).size;

  return (
    <>
      <h1>{artist.name}</h1>
      <p className="sub">{fmtNum(tracks.length)} plays · {fmtNum(distinct)} distinct tracks</p>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Title</th><th>Series</th><th>Show</th><th>Date</th></tr></thead>
          <tbody>
            {tracks.map(t => (
              <tr key={t.id}>
                <td>{t.title}</td>
                <td><Link to={`/series/${t.series_slug}`}>{t.series_name}</Link></td>
                <td><Link to={`/shows/${t.show_id}`}>{t.show_title}</Link></td>
                <td className="date">{fmtDate(t.show_date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
