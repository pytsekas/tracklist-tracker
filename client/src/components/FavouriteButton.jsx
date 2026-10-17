import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * The "Põnev" toggle: adds a song, artist or album to the favourites list or
 * removes it. Keeps the entry id locally after a save, so the page it sits on
 * never has to refetch.
 *
 * `add` is the POST body for this thing; `name` is what to call it in the
 * accessible label.
 */
export default function FavouriteButton({ favouriteId, add, name }) {
  const [id, setId] = useState(favouriteId ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // A page reload hands in a fresh prop; a save does not, so local state wins
  // between reloads.
  useEffect(() => { setId(favouriteId ?? null); }, [favouriteId]);

  async function toggle() {
    setSaving(true);
    setError(null);
    try {
      if (id) {
        await api.deleteFavourite(id);
        setId(null);
      } else {
        const entry = await api.addFavourite(add);
        setId(entry.id);
      }
    } catch (err) {
      // Keep the current state; the error says why nothing changed.
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const on = Boolean(id);
  return (
    <span className="fav-wrap">
      <button type="button" className={on ? 'fav on' : 'fav'} disabled={saving}
              aria-pressed={on}
              aria-label={on ? `Eemalda põnevate hulgast: ${name}` : `Lisa põnevate hulka: ${name}`}
              onClick={toggle}>
        {on ? '✓ Põnev' : 'Põnev'}
      </button>
      {error && <span className="err fav-err">{error}</span>}
    </span>
  );
}
