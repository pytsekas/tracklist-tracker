import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Add-or-remove toggle for one show, song, artist or album. Keeps the entry
 * id locally after a save, so the page it sits on never has to refetch.
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
              aria-label={on ? `Remove ${name} from favourites` : `Add ${name} to favourites`}
              onClick={toggle}>
        {on ? '★ Favourited' : '☆ Favourite'}
      </button>
      {error && <span className="err fav-err">{error}</span>}
    </span>
  );
}
