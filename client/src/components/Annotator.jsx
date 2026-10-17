import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const EMPTY = {
  good: false, good_at: null, notes: null, want_to_listen: false, updated_at: null,
};

/**
 * Editor for one show's annotation: "Kuulata" (want to listen), "Päris hea"
 * (good) and, once a show is good, the "Kommentaar" box that says why.
 *
 * Every control saves its own field, which is why the API is PATCH: the
 * comment box saves on a debounce, so a whole-document write could land after
 * a button click and silently revert it.
 */
export default function Annotator({ contentId, annotation, onChange, title }) {
  const [value, setValue] = useState(annotation ?? EMPTY);
  const [notes, setNotes] = useState(annotation?.notes ?? '');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const timer = useRef(null);
  // The debounced comment text not yet sent, so unmounting mid-debounce can
  // flush it instead of silently dropping it (see the unmount effect below).
  // Kept in a ref, not read from state/props, because the effect that flushes
  // it is mount-once and would otherwise only ever see the first render's
  // values.
  const pending = useRef(null);
  // Guards against out-of-order PATCH responses: two rapid saves (e.g. the
  // Päris hea button right after the Kuulata one) can resolve in the opposite
  // order they were sent in, and without this the earlier-sent response would
  // land last and revert the later change.
  const seq = useRef(0);

  // Accessible names carry the show title when the caller gives one, so two
  // shows' controls never read the same to a screen reader.
  const label = name => (title ? `${name}: ${title}` : name);

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
      // "Salvestan…" indicator while that newer save is still in flight.
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
    // Flush a debounced comment that hasn't fired yet rather than discarding
    // it — this runs on unmount (e.g. navigating to another show before the
    // 600ms debounce elapses), so the component is already gone: call the
    // API directly, not save(), and never touch state here.
    if (pending.current) {
      api.patchAnnotation(pending.current.contentId, { notes: pending.current.text }).catch(() => {});
    }
  }, []);

  return (
    <section className="annotator">
      <div className="annotator-row">
        <button type="button" className={value.want_to_listen ? 'fav on' : 'fav'}
                aria-pressed={value.want_to_listen} disabled={saving}
                aria-label={label('Kuulata')}
                onClick={() => save({ want_to_listen: !value.want_to_listen })}>
          Kuulata
        </button>

        <button type="button" className={value.good ? 'fav on' : 'fav'}
                aria-pressed={value.good} disabled={saving}
                aria-label={label('Päris hea')}
                onClick={() => save({ good: !value.good })}>
          Päris hea
        </button>

        <span className="annotator-state">
          {saving ? 'Salvestan…' : error ? <span className="err">{error}</span> : null}
        </span>
      </div>

      {/* The comment belongs to "Päris hea": it says why the show was good, so
          the box only appears once the show is marked. A comment typed earlier
          is kept on the server and comes back when the flag is set again. */}
      {value.good && (
        <textarea className="notes" rows={3} value={notes}
                  placeholder="Miks see saade hea oli…"
                  aria-label={label('Kommentaar')}
                  onChange={e => onNotes(e.target.value)} />
      )}
    </section>
  );
}
