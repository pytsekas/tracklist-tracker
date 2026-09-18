import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtDate, fmtNum } from '../api.js';
import { useAsync } from '../components/useAsync.js';
import Pager from '../components/Pager.jsx';

export default function SeriesShows() {
  const { slug } = useParams();
  const [page, setPage] = useState(1);
  const { data, error, loading } = useAsync(() => api.shows(slug, { page, pageSize: 100 }), [slug, page]);

  if (loading) return <p className="empty">Loading…</p>;
  if (error) return <p className="err">{error.message}</p>;

  return (
    <>
      <h1>{slug}</h1>
      <p className="sub">{fmtNum(data.total)} shows</p>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Date</th><th>Title</th><th className="num">Tracks</th><th>ERR</th></tr></thead>
          <tbody>
            {data.rows.map(r => (
              <tr key={r.id}>
                <td className="date">{fmtDate(r.show_date)}</td>
                <td><Link to={`/shows/${r.id}`}>{r.title}</Link></td>
                <td className="num">{r.track_count}</td>
                <td><a href={r.url} target="_blank" rel="noreferrer">open</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
    </>
  );
}
