import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEstDate,
  contentIdFromUrl,
  parseFilename,
  detectKind,
} from '../src/importer.js';

test('parseEstDate converts dd.mm.yyyy to ISO', () => {
  assert.equal(parseEstDate('12.09.2026'), '2026-09-12');
  assert.equal(parseEstDate('  01.02.2024  '), '2024-02-01');
});

test('parseEstDate returns null for junk', () => {
  assert.equal(parseEstDate('?'), null);
  assert.equal(parseEstDate(''), null);
  assert.equal(parseEstDate(null), null);
  assert.equal(parseEstDate('2024-02-01'), null);
});

test('contentIdFromUrl pulls the episode id out of an ERR url', () => {
  assert.equal(contentIdFromUrl('https://r2.err.ee/1610128043/saade'), 1610128043);
  assert.equal(contentIdFromUrl('https://err.ee/123'), 123);
});

test('contentIdFromUrl returns null when there is no id', () => {
  assert.equal(contentIdFromUrl('https://example.com/x'), null);
  assert.equal(contentIdFromUrl(''), null);
  assert.equal(contentIdFromUrl(null), null);
});

test('parseFilename splits slug and kind', () => {
  assert.deepEqual(parseFilename('eesti_pops_tracks.csv'), { slug: 'eesti_pops', kind: 'tracks' });
  assert.deepEqual(parseFilename('fantaasia_shows.csv'), { slug: 'fantaasia', kind: 'shows' });
  assert.deepEqual(parseFilename('Eesti_Pops_tracks.csv'), { slug: 'eesti_pops', kind: 'tracks' });
});

test('parseFilename returns nulls for an unrecognised name', () => {
  assert.deepEqual(parseFilename('random.csv'), { slug: null, kind: null });
});

test('detectKind reads the header row', () => {
  assert.equal(detectKind(['content_id', 'artist', 'title']), 'tracks');
  assert.equal(detectKind(['show_title', 'track_count']), 'shows');
  assert.equal(detectKind([' Content_ID ', 'ARTIST', 'Title']), 'tracks');
  assert.equal(detectKind(['foo', 'bar']), 'unknown');
});
