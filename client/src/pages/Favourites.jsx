import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, fmtCount } from '../api.js';
import { useAsync } from '../components/useAsync.js';
import AddAlbum from '../components/AddAlbum.jsx';
import { lookupLinks } from '../lookup.js';

const VIEWS = [
  { key: 'open', label: 'Lahtised', params: { done: 'false' } },
  { key: 'done', label: 'Tehtud',   params: { done: 'true' } },
  { key: 'all',  label: 'Kõik',     params: {} },
];

const KINDS = [
  { value: '',       label: 'Kõik liigid' },
  { value: 'show',   label: 'Saated' },
  { value: 'song',   label: 'Lood' },
  { value: 'artist', label: 'Esitajad' },
  { value: 'album',  label: 'Albumid' },
];

const KIND_LABEL = { show: 'Saade', song: 'Lugu', artist: 'Esitaja', album: 'Album' };

/** What to call an entry in labels: its title, or the artist for an artist entry. */
const nameOf = e => e.title ?? e.artist ?? e.kind;

/** The "Põnev" page: the favourites list, things to look up and remember. */
export default function Favourites() {
  const [view, setView] = useState('open');
  const [kind, setKind] = useState('');
  const params = { ...VIEWS.find(v => v.key === view).params, ...(kind ? { kind } : {}) };
  const list = useAsync(() => api.favourites(params), [view, kind]);

  // A local copy of the rows, so a save or a remove updates one row in place
  // and a done tick under the Lahtised view stays visible until the next fetch.
  const [rows, setRows] = useState([]);
  useEffect(() => { if (list.data) setRows(list.data); }, [list.data]);

  const replace = entry => setRows(rs => rs.map(r => (r.id === entry.id ? entry : r)));
  const drop = id => setRows(rs => rs.filter(r => r.id !== id));
  // A new album is open, so show the Lahtised view and let the server list it.
  const onAdded = () => { setView('open'); setKind(''); list.reload(); };

  if (list.error) return <p className="err">{list.error.message}</p>;
  if (list.loading && rows.length === 0) return <p className="empty">Laadin…</p>;

  return (
    <>
      <h1>Põnev</h1>
      <p className="sub">{fmtCount(rows.length, 'kirje', 'kirjet')}</p>

      <AddAlbum onAdded={onAdded} />

      <div className="filters">
        <span className="group" role="group" aria-label="Vaade">
          {VIEWS.map(v => (
            <button key={v.key} type="button"
                    className={v.key === view ? 'chip on' : 'chip'}
                    aria-pressed={v.key === view}
                    onClick={() => setView(v.key)}>{v.label}</button>
          ))}
        </span>
        <select value={kind} onChange={e => setKind(e.target.value)} aria-label="Liik">
          {KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
      </div>

      {rows.length === 0 ? (
        <p className="empty">
          Siin pole veel midagi. Märgi mõni lugu või esitaja põnevaks, et nimekiri tekiks.
        </p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Liik</th><th>Kirje</th><th>Otsi</th><th>Märkmed</th><th>Tehtud</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map(r => <Row key={r.id} entry={r} onChange={replace} onRemove={drop} />)}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function What({ entry: e }) {
  const artist = e.artist_id
    ? <Link to={`/artists/${e.artist_id}`}>{e.artist}</Link>
    : (e.artist ?? <span style={{ color: 'var(--muted)' }}>teadmata</span>);
  const showLink = e.show && (e.show_id
    ? <Link to={`/shows/${e.show_id}`}>{e.show.title}</Link>
    : e.show.title);

  if (e.kind === 'show') {
    return (
      <>
        {showLink}
        <span className="sub-line">{fmtDate(e.show.show_date)} · {e.show.series_name}</span>
      </>
    );
  }
  if (e.kind === 'artist') return artist;
  return (
    <>
      {artist} – {e.title}
      {e.kind === 'song' && e.show && (
        <span className="sub-line">
          kuuldud saates {showLink} · {fmtDate(e.show.show_date)} · {e.show.series_name}
        </span>
      )}
    </>
  );
}

function Row({ entry: e, onChange, onRemove }) {
  const [notes, setNotes] = useState(e.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const timer = useRef(null);
  // The debounced notes text not yet sent, flushed on unmount (see below).
  const pending = useRef(null);
  // Guards against out-of-order PATCH responses, as the Annotator does.
  const seq = useRef(0);

  async function save(patch) {
    const mine = ++seq.current;
    setSaving(true);
    setError(null);
    try {
      const next = await api.patchFavourite(e.id, patch);
      if (mine !== seq.current) return;
      onChange(next);
    } catch (err) {
      if (mine !== seq.current) return;
      // Leave the field as typed; the error says why it did not save.
      setError(err.message);
    } finally {
      if (mine === seq.current) setSaving(false);
    }
  }

  function onNotes(text) {
    setNotes(text);
    pending.current = text;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      pending.current = null;
      save({ notes: text });
    }, 600);
  }

  useEffect(() => () => {
    clearTimeout(timer.current);
    // Navigating away mid-debounce must not drop the note: call the API
    // directly, never touch state on an unmounted row.
    if (pending.current !== null) {
      api.patchFavourite(e.id, { notes: pending.current }).catch(() => {});
    }
  }, []);

  async function remove() {
    setSaving(true);
    setError(null);
    try {
      await api.deleteFavourite(e.id);
      onRemove(e.id);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  const name = nameOf(e);
  return (
    <tr>
      <td>{KIND_LABEL[e.kind]}</td>
      <td><What entry={e} /></td>
      <td>
        <span className="links">
          {lookupLinks(e).map(l => (
            <a key={l.label} href={l.href} target="_blank" rel="noreferrer">{l.label}</a>
          ))}
        </span>
      </td>
      <td>
        <textarea className="notes notes-small" rows={2} value={notes} placeholder="Märkmed…"
                  aria-label={`Märkmed: ${name}`}
                  onChange={ev => onNotes(ev.target.value)} />
        <span className="annotator-state">
          {saving ? 'Salvestan…' : error ? <span className="err">{error}</span> : null}
        </span>
      </td>
      <td>
        <input type="checkbox" checked={e.done} aria-label={`Tehtud: ${name}`}
               onChange={ev => save({ done: ev.target.checked })} />
      </td>
      <td>
        <button type="button" className="chip" disabled={saving}
                aria-label={`Eemalda põnevate hulgast: ${name}`}
                onClick={remove}>Eemalda</button>
      </td>
    </tr>
  );
}
