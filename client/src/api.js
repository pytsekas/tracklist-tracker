async function get(path, params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== '' && v != null)
  ).toString();
  const res = await fetch(`/api${path}${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

export const api = {
  stats:      ()             => get('/stats'),
  series:     ()             => get('/series'),
  shows:      (slug, p)      => get(`/series/${slug}/shows`, p),
  show:       (id)           => get(`/shows/${id}`),
  tracks:     (p)            => get('/tracks', p),
  artists:    (p)            => get('/artists', p),
  artist:     (id)           => get(`/artists/${id}`),
};

export const fmtDate = d => (d ? String(d).slice(0, 10).split('-').reverse().join('.') : '—');
export const fmtNum  = n => Number(n || 0).toLocaleString('et-EE');
