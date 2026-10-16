const MB_TYPE = { song: 'recording', artist: 'artist', album: 'release' };

/**
 * Where to go looking for an entry elsewhere. Computed from the names, never
 * stored: the URLs are search pages, and a later metadata fetch may replace
 * them with real release links.
 */
export function lookupLinks(entry) {
  if (entry.kind === 'show') {
    return entry.show_url ? [{ label: 'ERR', href: entry.show_url }] : [];
  }
  const q = encodeURIComponent([entry.artist, entry.title].filter(Boolean).join(' '));
  return [
    { label: 'Spotify', href: `https://open.spotify.com/search/${q}` },
    { label: 'Discogs', href: `https://www.discogs.com/search/?q=${q}&type=all` },
    { label: 'Bandcamp', href: `https://bandcamp.com/search?q=${q}` },
    { label: 'MusicBrainz',
      href: `https://musicbrainz.org/search?query=${q}&type=${MB_TYPE[entry.kind]}&method=indexed` },
  ];
}
