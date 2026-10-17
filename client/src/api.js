async function get(path, params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== '' && v != null)
  ).toString();
  const res = await fetch(`/api${path}${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

async function send(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.status === 204 ? null : res.json();
}

export const api = {
  stats:      ()             => get('/stats'),
  series:     ()             => get('/series'),
  shows:      (slug, p)      => get(`/series/${slug}/shows`, p),
  show:       (id)           => get(`/shows/${id}`),
  tracks:     (p)            => get('/tracks', p),
  artists:    (p)            => get('/artists', p),
  artist:     (id)           => get(`/artists/${id}`),
  me:               ()            => get('/me'),
  patchAnnotation:  (cid, patch)  => send('PATCH', `/shows/${cid}/annotation`, patch),
  deleteAnnotation: (cid)         => send('DELETE', `/shows/${cid}/annotation`),
  favourites:       (p)            => get('/favourites', p),
  addFavourite:     (body)         => send('POST', '/favourites', body),
  patchFavourite:   (id, patch)    => send('PATCH', `/favourites/${id}`, patch),
  deleteFavourite:  (id)           => send('DELETE', `/favourites/${id}`),
};

export const fmtDate = d => (d ? String(d).slice(0, 10).split('-').reverse().join('.') : '—');
export const fmtNum  = n => Number(n || 0).toLocaleString('et-EE');
/** A count with its noun: "1 saade", "12 saadet". */
export const fmtCount = (n, one, many) => `${fmtNum(n)} ${Number(n) === 1 ? one : many}`;
