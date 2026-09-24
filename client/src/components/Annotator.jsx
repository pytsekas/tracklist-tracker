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
  // The debounced notes text not yet sent, so unmounting mid-debounce can
  // flush it instead of silently dropping it (see the unmount effect below).
  // Kept in a ref, not read from state/props, because the effect that flushes
  // it is mount-once and would otherwise only ever see the first render's
  // values.
  const pending = useRef(null);
  // Guards against out-of-order PATCH responses: two rapid saves (e.g. a
  // star click right after a checkbox toggle) can resolve in the opposite
  // order they were sent in, and without this the earlier-sent response
  // would land last and revert the later change.
  const seq = useRef(0);

  useEffect(() => {
    setValue(annotation ?? EMPTY);
    setNotes(annotation?.notes ?? '');
    // NB: this effect is not currently wired to `onChange`, and that is load
    // bearing. Every save() calls onChange?.(next) with a fresh object; if
    // this effect depended on a changing `annotation` prop driven by that
    // callback, each save would re-fire it and reset `notes` mid-typing.
  }, [contentId, annotation]);

  async function save(patch) {
    const mine = ++seq.current;
    setSaving(true);
    setError(null);
    try {
      const next = await api.patchAnnotation(contentId, patch);
      if (mine !== seq.current) return; // superseded by a newer save
      setValue(next);
      onChange?.(next);
    } catch (err) {
      if (mine !== seq.current) return; // superseded; a newer save already reflects the current state
      // Leave the field as the user typed it; clearing it would lose the text.
      setError(err.message);
    } finally {
      // A stale save finishing after a newer one must not turn off the
      // "Saving…" indicator while that newer save is still in flight.
      if (mine === seq.current) setSaving(false);
    }
    // Residual: if the server itself processes two concurrent writes in the
    // opposite order from how their responses resolve here, the on-screen
    // state can briefly show one field a step behind. The store always has
    // both writes correctly; only this component's display is briefly
    // stale, and the next save or page load corrects it. Not worth chasing
    // with response-merging for a single-user editor.
  }

  function onNotes(text) {
    setNotes(text);
    pending.current = { contentId, text };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      pending.current = null;
      save({ notes: text });
    }, 600);
  }

  useEffect(() => () => {
    clearTimeout(timer.current);
    // Flush a debounced note that hasn't fired yet rather than discarding
    // it — this runs on unmount (e.g. navigating to another show before the
    // 600ms debounce elapses), so the component is already gone: call the
    // API directly, not save(), and never touch state here.
    if (pending.current) {
      api.patchAnnotation(pending.current.contentId, { notes: pending.current.text }).catch(() => {});
    }
  }, []);

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

        <span className="stars" role="group" aria-label={`Rating: ${value.rating ?? 'not rated'} of 5`}>
          {[1, 2, 3, 4, 5].map(n => (
            <button key={n} type="button"
                    className={n <= (value.rating ?? 0) ? 'star on' : 'star'}
                    aria-label={`Rate ${n} of 5`}
                    aria-pressed={n <= (value.rating ?? 0)}
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
