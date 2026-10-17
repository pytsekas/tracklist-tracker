import { Link, useParams } from 'react-router-dom';
import { api, fmtDate, fmtNum } from '../api.js';
import { useAsync } from '../components/useAsync.js';
import FavouriteButton from '../components/FavouriteButton.jsx';
import AddAlbum from '../components/AddAlbum.jsx';

export default function Artist() {
  const { id } = useParams();
  const { data, error, loading } = useAsync(() => api.artist(id), [id]);

  if (loading) return <p className="empty">Laadin…</p>;
  if (error) return <p className="err">{error.message}</p>;

  const { artist, tracks } = data;
  const distinct = new Set(tracks.map(t => t.title.toLowerCase())).size;

  return (
    <>
      <h1>{artist.name}</h1>
      <p className="sub">{fmtNum(tracks.length)} esitust · {fmtNum(distinct)} eri lugu</p>
      <div className="annotator-row">
        <FavouriteButton favouriteId={artist.favourite_id}
                         add={{ kind: 'artist', artist_id: artist.id }}
                         name={artist.name} />
        <AddAlbum artist={artist.name} />
      </div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Pealkiri</th><th>Sari</th><th>Saade</th><th>Kuupäev</th></tr></thead>
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
