import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtDate, fmtNum } from '../api.js';
import { useAsync } from '../components/useAsync.js';
import Pager from '../components/Pager.jsx';

/**
 * Compact state for one show: nothing at all when it has no annotation.
 * Each symbol carries `aria-label` alongside `title` — `title` alone is not
 * reliably announced by screen readers, and a bare glyph like "✓" or "☆"
 * would otherwise convey nothing to them.
 */
export function StateBadge({ annotation: a }) {
  // A row can exist with every field falsy -- ticking "Listened" and then
  // unticking it leaves an annotation record behind, since there is no
  // "clear" action that removes it. Without this check that row would render
  // an empty <span className="badges">, whose margin-left shows up as an
  // unexplained gap that never goes away.
  const hasState = a && (a.listened || a.want_to_listen || a.rating || a.notes || a.tags.length);
  if (!hasState) return null;
  return (
    <span className="badges">
      {a.listened && <span className="badge" title="Listened" aria-label="Listened">✓</span>}
      {a.want_to_listen && (
        <span className="badge" title="Want to listen" aria-label="Want to listen">☆</span>
      )}
      {a.rating && (
        <span className="badge" title={`Rated ${a.rating} of 5`} aria-label={`Rated ${a.rating} of 5`}>
          {a.rating}★
        </span>
      )}
      {a.notes && <span className="badge" title="Has notes" aria-label="Has notes">✎</span>}
      {a.tags.map(t => <span key={t} className="badge tagbadge">{t}</span>)}
    </span>
  );
}

const FILTERS = [
  { key: 'all',        label: 'All',           params: {} },
  { key: 'unlistened', label: 'Not listened',  params: { listened: 'false' } },
  { key: 'listened',   label: 'Listened',      params: { listened: 'true' } },
  { key: 'want',       label: 'Queue',         params: { want: 'true' } },
  { key: 'good',       label: 'Rated 4+',      params: { ratingMin: 4 } },
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

  if (loading) return <p className="empty">Loading…</p>;
  if (error) return <p className="err">{error.message}</p>;

  return (
    <>
      <h1>{slug}</h1>
      <p className="sub">{fmtNum(data.total)} shows</p>

      <div className="filters" role="group" aria-label="Filter shows">
        {FILTERS.map(f => (
          <button key={f.key} type="button"
                  className={f.key === filter ? 'chip on' : 'chip'}
                  aria-pressed={f.key === filter}
                  onClick={() => choose(f.key)}>{f.label}</button>
        ))}
      </div>

      {data.rows.length === 0 ? (
        <p className="empty">No shows match this filter.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Date</th><th>Title</th><th className="num">Tracks</th><th>ERR</th></tr></thead>
            <tbody>
              {data.rows.map(r => (
                <tr key={r.id}>
                  <td className="date">{fmtDate(r.show_date)}</td>
                  <td>
                    <Link to={`/shows/${r.id}`}>{r.title}</Link>
                    <StateBadge annotation={r.annotation} />
                  </td>
                  <td className="num">{r.track_count}</td>
                  <td><a href={r.url} target="_blank" rel="noreferrer">open</a></td>
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
