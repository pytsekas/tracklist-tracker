import test from 'node:test';
import assert from 'node:assert/strict';
import { norm, likeEscape } from '../src/normalize.js';

test('norm lowercases Estonian letters', () => {
  assert.equal(norm('Õhtu'), 'õhtu');
  assert.equal(norm('MÄGI'), 'mägi');
  assert.equal(norm('Öö ÜLE'), 'öö üle');
});

test('norm trims and collapses whitespace', () => {
  assert.equal(norm('  a   b  '), 'a b');
  assert.equal(norm('a\t\nb'), 'a b');
});

test('norm handles empty input', () => {
  assert.equal(norm(null), '');
  assert.equal(norm(undefined), '');
  assert.equal(norm(''), '');
});

test('norm keeps diacritics distinct', () => {
  // õ/ä/ö/ü are separate Estonian letters, not accented variants.
  assert.notEqual(norm('Mägi'), norm('magi'));
  assert.notEqual(norm('Õhtu'), norm('ohtu'));
});

test('likeEscape escapes LIKE metacharacters', () => {
  assert.equal(likeEscape('50%'), '50\\%');
  assert.equal(likeEscape('a_b'), 'a\\_b');
  assert.equal(likeEscape('c\\d'), 'c\\\\d');
});

test('likeEscape leaves ordinary text alone', () => {
  assert.equal(likeEscape('Õhtu jõuab'), 'Õhtu jõuab');
  assert.equal(likeEscape(null), '');
});
