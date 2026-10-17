export default function Pager({ page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  return (
    <div className="pager">
      <button disabled={page <= 1} onClick={() => onPage(page - 1)}>Eelmine</button>
      <span>Lehekülg {page} / {pages} · {total.toLocaleString('et-EE')} rida</span>
      <button disabled={page >= pages} onClick={() => onPage(page + 1)}>Järgmine</button>
    </div>
  );
}
