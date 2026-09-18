import { Link, useParams } from 'react-router-dom';
import { api, fmtDate } from '../api.js';
import { useAsync } from '../components/useAsync.js';

export default function Show() {
  const { id } = useParams();
  const { data, error, loading } = useAsync(() => api.show(id), [id]);

  if (loading) return <p className="empty">Loading…</p>;
  if (error) return <p className="err">{error.message}</p>;

  const { show, tracks } = data;
  return (
    <>
      <h1>{show.title}</h1>
      <p className="sub">
        {fmtDate(show.show_date)} · <Link to={`/series/${show.series_slug}`}>{show.series_name}</Link>
        {show.url && <> · <a href={show.url} target="_blank" rel="noreferrer">listen on ERR</a></>}
      </p>
      {tracks.length === 0 ? (
        <p className="empty">This show has no tracklist.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead><tr><th className="num">#</th><th>Artist</th><th>Title</th></tr></thead>
            <tbody>
              {tracks.map(t => (
                <tr key={t.id}>
                  <td className="num">{t.position}</td>
                  <td>{t.artist_id
                    ? <Link to={`/artists/${t.artist_id}`}>{t.artist}</Link>
                    : <span style={{ color: 'var(--muted)' }}>unknown</span>}</td>
                  <td>{t.title}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
