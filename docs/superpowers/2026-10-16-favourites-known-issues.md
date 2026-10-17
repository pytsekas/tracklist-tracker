# Known issues: favourites

Two minor defects were seen in the favourites list during the final review and
deliberately left. Neither loses data, and neither blocks the feature. Check
this list before fixing something that may be an accepted trade-off, and do not
re-report these items.

1. **Several favourite buttons for the same song on one page do not sync.**
   Identity merges a song across episodes, so a Tracks search can show the same
   song on several rows (`client/src/pages/Tracks.jsx`,
   `client/src/pages/Show.jsx`, with `client/src/components/FavouriteButton.jsx`).
   Each button keeps its own state, so marking one row leaves the others
   showing "Põnev" instead of "✓ Põnev" until a reload. No data is lost: a repeat POST answers
   200 and a repeat DELETE answers 204. Left because the effect is cosmetic and
   self-heals on reload. **Possible fix:** lift the state into a per-page map
   keyed by favourite id.

2. **Re-adding an album that already exists and is done looks like nothing
   happened.** `client/src/components/AddAlbum.jsx` shows "Lisatud" and
   `client/src/pages/Favourites.jsx` switches to the Lahtised view, where a done
   entry is hidden. The server answered 200 (already existed), which the
   `api.js` wrapper does not expose. Left because the entry is intact and
   reappears under the Tehtud view. **Possible fix:** surface the status from
   the wrapper and show "Juba põnevate hulgas".
