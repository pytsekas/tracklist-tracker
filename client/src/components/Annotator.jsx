import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const EMPTY = {
  listened: false, listened_at: null, rating: null, notes: null,
  want_to_listen: false, tags: [], updated_at: null,
};

/**
 * Editor for one show's annotation.
 *
 * Every control saves its own field, which is why the API is PATCH: the notes
 * box saves on a debounce, so a whole-document write could land after a star
 * click and silently revert it.
 */
export default function Annotator({ contentId, annotation, onChange }) {
  const [value, setValue] = useState(annotation ?? EMPTY);
  const [notes, setNotes] = useState(annotation?.notes ?? '');
  const [tagDraft, setTagDraft] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    setValue(annotation ?? EMPTY);
    setNotes(annotation?.notes ?? '');
  }, [contentId, annotation]);

  async function save(patch) {
    setSaving(true);
    setError(null);
    try {
      const next = await api.patchAnnotation(contentId, patch);
      setValue(next);
      onChange?.(next);
    } catch (err) {
      // Leave the field as the user typed it; clearing it would lose the text.
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function onNotes(text) {
    setNotes(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save({ notes: text }), 600);
  }

  useEffect(() => () => clearTimeout(timer.current), []);

  function addTag(e) {
    e.preventDefault();
    const tag = tagDraft.trim();
    if (!tag || value.tags.includes(tag)) return setTagDraft('');
    save({ tags: [...value.tags, tag] });
    setTagDraft('');
  }

  return (
    <section className="annotator">
      <div className="annotator-row">
        <label className="toggle">
          <input type="checkbox" checked={value.listened}
                 onChange={e => save({ listened: e.target.checked })} />
          Listened
        </label>

        <label className="toggle">
          <input type="checkbox" checked={value.want_to_listen}
                 onChange={e => save({ want_to_listen: e.target.checked })} />
          Want to listen
        </label>

        <span className="stars" role="group" aria-label="Rating">
          {[1, 2, 3, 4, 5].map(n => (
            <button key={n} type="button"
                    className={n <= (value.rating ?? 0) ? 'star on' : 'star'}
                    aria-label={`${n} of 5`}
                    aria-pressed={n === value.rating}
                    onClick={() => save({ rating: value.rating === n ? null : n })}>★</button>
          ))}
        </span>

        <span className="annotator-state">
          {saving ? 'Saving…' : error ? <span className="err">{error}</span> : null}
        </span>
      </div>

      <textarea className="notes" rows={3} value={notes}
                placeholder="Notes about this episode…"
                aria-label="Notes about this episode"
                onChange={e => onNotes(e.target.value)} />

      <div className="annotator-row">
        {value.tags.map(tag => (
          <span key={tag} className="tag">
            {tag}
            <button type="button" aria-label={`Remove ${tag}`}
                    onClick={() => save({ tags: value.tags.filter(t => t !== tag) })}>×</button>
          </span>
        ))}
        <form onSubmit={addTag}>
          <input value={tagDraft} placeholder="Add a tag"
                 aria-label="Add a tag"
                 onChange={e => setTagDraft(e.target.value)} />
        </form>
      </div>
    </section>
  );
}
