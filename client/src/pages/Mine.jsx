import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, fmtNum } from '../api.js';
import { useAsync } from '../components/useAsync.js';
import { StateBadge } from './SeriesShows.jsx';

const VIEWS = [
  { key: 'want', label: 'Kuulata',   params: { want: 'true' } },
  { key: 'good', label: 'Päris hea', params: { good: 'true' } },
];

// The server caps pageSize at 500 (server/src/routes.js `size()`), and the
// largest series (fantaasia) has ~1,940 shows — so a series where every show
// matched a filter would need 4 pages. This cap is a guard against a server
// bug that never lets `rows.length` catch up with `total`, not a limit we
// expect to hit: 50 pages is 25,000 rows, ~13x today's entire archive for a
// single series.
const MAX_PAGES_PER_SERIES = 50;

/** Fetch every row matching `params` for one series, paging past the server's 500-row cap. */
async function fetchAllShows(slug, params) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES_PER_SERIES; page++) {
    const res = await api.shows(slug, { page, pageSize: 500, ...params });
    rows.push(...res.rows);
    if (rows.length >= res.total || res.rows.length === 0) break;
  }
  return rows;
}

/** The "Minu" page: the shows to listen to, and the good ones with their comments. */
export default function Mine() {
  const [view, setView] = useState('want');

  const params = VIEWS.find(v => v.key === view).params;

  // Every series at once: these lists are not a per-series idea.
  const series = useAsync(() => api.series(), []);
  const shows = useAsync(
    async () => {
      if (!series.data) return null;
      const pages = await Promise.all(
        series.data.map(s => fetchAllShows(s.slug, params)
          .then(rows => rows.map(row => ({ ...row, series_name: s.name, series_slug: s.slug })))));
      return pages.flat().sort((a, b) => (b.show_date ?? '').localeCompare(a.show_date ?? ''));
    },
    [series.data, view]);

  if (series.error) return <p className="err">{series.error.message}</p>;
  if (shows.loading || series.loading) return <p className="empty">Laadin…</p>;
  if (shows.error) return <p className="err">{shows.error.message}</p>;

  const rows = shows.data ?? [];

  return (
    <>
      <h1>Minu</h1>
      <p className="sub">{fmtNum(rows.length)} saadet</p>

      <div className="filters" role="group" aria-label="Vaade">
        {VIEWS.map(v => (
          <button key={v.key} type="button"
                  className={v.key === view ? 'chip on' : 'chip'}
                  aria-pressed={v.key === view}
                  onClick={() => setView(v.key)}>{v.label}</button>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="empty">
          Siin pole veel midagi. Ava saade ja märgi see, et nimekiri tekiks.
        </p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Kuupäev</th><th>Sari</th><th>Pealkiri</th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td className="date">{fmtDate(r.show_date)}</td>
                  <td><Link to={`/series/${r.series_slug}`}>{r.series_name}</Link></td>
                  <td>
                    <Link to={`/shows/${r.id}`}>{r.title}</Link>
                    <StateBadge annotation={r.annotation} favouriteId={r.favourite_id} />
                    {/* The comment is why the show was good; it only makes sense here. */}
                    {view === 'good' && r.annotation?.notes && (
                      <span className="sub-line">{r.annotation.notes}</span>
                    )}
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
