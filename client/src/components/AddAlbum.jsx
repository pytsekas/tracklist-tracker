import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * The one free-text way into favourites: an album the archive knows nothing
 * about. With `artist` given (the Artist page) only the title is typed;
 * without it (the Favourites page) both fields are.
 */
export default function AddAlbum({ artist: fixedArtist = null, onAdded }) {
  const [artist, setArtist] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [added, setAdded] = useState(false);
  const timer = useRef(null);
  const artistValue = fixedArtist ?? artist;

  useEffect(() => () => clearTimeout(timer.current), []);

  async function submit(ev) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    setAdded(false);
    try {
      const entry = await api.addFavourite({ kind: 'album', artist: artistValue, title });
      setTitle('');
      if (!fixedArtist) setArtist('');
      setAdded(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setAdded(false), 2000);
      onAdded?.(entry);
    } catch (err) {
      // Keep the typed text; clearing it would lose the user's input.
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="controls" onSubmit={submit}
          aria-label={fixedArtist ? `Add an album by ${fixedArtist}` : 'Add an album'}>
      {!fixedArtist && (
        <input type="text" value={artist} placeholder="Artist" aria-label="Artist"
               onChange={e => setArtist(e.target.value)} />
      )}
      <input type="text" value={title}
             placeholder={fixedArtist ? `Album by ${fixedArtist}` : 'Album'}
             aria-label={fixedArtist ? 'Album title' : 'Album'}
             onChange={e => setTitle(e.target.value)} />
      <button type="submit" disabled={busy || !artistValue.trim() || !title.trim()}>
        {fixedArtist ? 'Add' : 'Add album'}
      </button>
      <span className="annotator-state">
        {added ? 'Added' : error ? <span className="err">{error}</span> : null}
      </span>
    </form>
  );
}
