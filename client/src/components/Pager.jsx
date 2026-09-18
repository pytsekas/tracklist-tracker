export default function Pager({ page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  return (
    <div className="pager">
      <button disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
      <span>Page {page} of {pages} · {total.toLocaleString('et-EE')} rows</span>
      <button disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
    </div>
  );
}
