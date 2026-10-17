import { Link, useParams } from 'react-router-dom';
import { api, fmtDate } from '../api.js';
import { useAsync } from '../components/useAsync.js';
import Annotator from '../components/Annotator.jsx';
import FavouriteButton from '../components/FavouriteButton.jsx';

export default function Show() {
  const { id } = useParams();
  const { data, error, loading } = useAsync(() => api.show(id), [id]);

  if (loading) return <p className="empty">Laadin…</p>;
  if (error) return <p className="err">{error.message}</p>;

  const { show, tracks } = data;
  return (
    <>
      <h1>{show.title}</h1>
      <p className="sub">
        {fmtDate(show.show_date)} · <Link to={`/series/${show.series_slug}`}>{show.series_name}</Link>
        {show.url && <> · <a href={show.url} target="_blank" rel="noreferrer">kuula ERR-ist</a></>}
      </p>
      <Annotator contentId={show.content_id} annotation={data.annotation} title={show.title} />
      {tracks.length === 0 ? (
        <p className="empty">Sellel saatel pole lugude nimekirja.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead><tr><th className="num">#</th><th>Esitaja</th><th>Pealkiri</th><th></th></tr></thead>
            <tbody>
              {tracks.map(t => (
                <tr key={t.id}>
                  <td className="num">{t.position}</td>
                  <td>{t.artist_id
                    ? <Link to={`/artists/${t.artist_id}`}>{t.artist}</Link>
                    : <span style={{ color: 'var(--muted)' }}>teadmata</span>}</td>
                  <td>{t.title}</td>
                  <td>
                    <FavouriteButton favouriteId={t.favourite_id}
                                     add={{ kind: 'song', track_id: t.id }}
                                     name={`${t.artist ?? 'teadmata'} – ${t.title}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
