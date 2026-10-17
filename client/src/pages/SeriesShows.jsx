import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtDate, fmtNum } from '../api.js';
import { useAsync } from '../components/useAsync.js';
import Pager from '../components/Pager.jsx';

/**
 * Compact state for one show: nothing at all when it is on no list.
 * Each badge carries `aria-label` alongside `title` — `title` alone is not
 * reliably announced by screen readers, and a bare glyph like "★" would
 * otherwise convey nothing to them.
 */
export function StateBadge({ annotation: a, favouriteId = null }) {
  // A row can exist with every field falsy -- pressing "Kuulata" and then
  // pressing it again leaves an annotation record behind, since there is no
  // "clear" action that removes it. Without this check that row would render
  // an empty <span className="badges">, whose margin-left shows up as an
  // unexplained gap that never goes away.
  const hasState = favouriteId || (a && (a.want_to_listen || a.good));
  if (!hasState) return null;
  return (
    <span className="badges">
      {a?.want_to_listen && (
        <span className="badge" title="Kuulata" aria-label="Kuulata">kuulata</span>
      )}
      {a?.good && (
        <span className="badge" title="Päris hea" aria-label="Päris hea">päris hea</span>
      )}
      {favouriteId && (
        <span className="badge" title="Põnev" aria-label="Põnev">★</span>
      )}
    </span>
  );
}

const FILTERS = [
  { key: 'all',  label: 'Kõik',      params: {} },
  { key: 'want', label: 'Kuulata',   params: { want: 'true' } },
  { key: 'good', label: 'Päris hea', params: { good: 'true' } },
];

export default function SeriesShows() {
  const { slug } = useParams();
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('all');

  const params = FILTERS.find(f => f.key === filter).params;
  const { data, error, loading } = useAsync(
    () => api.shows(slug, { page, pageSize: 100, ...params }),
    [slug, page, filter]);

  const choose = key => { setFilter(key); setPage(1); };

  if (loading) return <p className="empty">Laadin…</p>;
  if (error) return <p className="err">{error.message}</p>;

  return (
    <>
      <h1>{slug}</h1>
      <p className="sub">{fmtNum(data.total)} saadet</p>

      <div className="filters" role="group" aria-label="Filtreeri saateid">
        {FILTERS.map(f => (
          <button key={f.key} type="button"
                  className={f.key === filter ? 'chip on' : 'chip'}
                  aria-pressed={f.key === filter}
                  onClick={() => choose(f.key)}>{f.label}</button>
        ))}
      </div>

      {data.rows.length === 0 ? (
        <p className="empty">Ükski saade ei vasta filtrile.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Kuupäev</th><th>Pealkiri</th><th className="num">Lugusid</th><th>ERR</th></tr></thead>
            <tbody>
              {data.rows.map(r => (
                <tr key={r.id}>
                  <td className="date">{fmtDate(r.show_date)}</td>
                  <td>
                    <Link to={`/shows/${r.id}`}>{r.title}</Link>
                    <StateBadge annotation={r.annotation} favouriteId={r.favourite_id} />
                  </td>
                  <td className="num">{r.track_count}</td>
                  <td><a href={r.url} target="_blank" rel="noreferrer">ava</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
    </>
  );
}
