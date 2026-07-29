// The model menu: which names survive, and which shelf they land on.
//
// Worth testing rather than eyeballing, because the two rules pull against
// each other. A version supersedes; a variant does not. Get that backwards and
// the menu quietly loses gpt-oss:120b the moment gpt-oss:20b appears beside it.
//
// The list here is the real one from ollama.com, so a change in the rules is
// checked against what a teacher actually sees.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModel, shortlist, tierOf, hide } from '../functions/api/admin/models.js';

const LISTED = [
  'deepseek-v4-flash', 'deepseek-v4-pro', 'gemma4:31b', 'glm-5.1', 'glm-5.2',
  'gpt-oss:120b', 'gpt-oss:20b', 'kimi-k2.5', 'kimi-k2.6', 'kimi-k2.7-code',
  'kimi-k3', 'minimax-m2.5', 'minimax-m2.7', 'minimax-m3',
  'mistral-large-3:675b', 'nemotron-3-nano:30b', 'nemotron-3-super',
  'nemotron-3-ultra', 'qwen3.5:397b',
];

test('a name splits into family, version, variant and tag', () => {
  assert.deepEqual(parseModel('glm-5.2'), { family: 'glm', version: '5.2', variant: '', tag: '' });
  assert.deepEqual(parseModel('kimi-k2.7-code'), { family: 'kimi-k', version: '2.7', variant: 'code', tag: '' });
  assert.deepEqual(parseModel('nemotron-3-nano:30b'), { family: 'nemotron', version: '3', variant: 'nano', tag: '30b' });
  // No version at all is normal, not a parse failure.
  assert.deepEqual(parseModel('gpt-oss:120b'), { family: 'gpt-oss', version: '', variant: '', tag: '120b' });
});

test('an older version drops once a newer one is listed', () => {
  const kept = shortlist(LISTED);
  assert.ok(!kept.includes('glm-5.1'), 'glm-5.1 is superseded by glm-5.2');
  assert.ok(kept.includes('glm-5.2'));
  assert.ok(!kept.includes('kimi-k2.5'));
  assert.ok(!kept.includes('kimi-k2.6'));
  assert.ok(kept.includes('kimi-k3'));
  assert.ok(!kept.includes('minimax-m2.5') && !kept.includes('minimax-m2.7'));
  assert.ok(kept.includes('minimax-m3'));
});

test('a variant is not a predecessor', () => {
  const kept = shortlist(LISTED);
  // Sizes of the same thing -- neither supersedes the other.
  assert.ok(kept.includes('gpt-oss:120b') && kept.includes('gpt-oss:20b'));
  // Different builds at the same version.
  assert.ok(kept.includes('deepseek-v4-flash') && kept.includes('deepseek-v4-pro'));
  // A code-tuned 2.7 is not beaten by a general 3.
  assert.ok(kept.includes('kimi-k2.7-code'));
  assert.ok(kept.includes('nemotron-3-nano:30b') && kept.includes('nemotron-3-super')
    && kept.includes('nemotron-3-ultra'));
});

test('the configured default survives even when superseded', () => {
  // Whatever runs when nothing is chosen has to be nameable in the menu.
  const kept = shortlist(LISTED, 'glm-5.1');
  assert.ok(kept.includes('glm-5.1'));
  assert.ok(kept.includes('glm-5.2'), 'and the newer one is still there too');
});

test('a model is shelved by size or by the vendor\'s own word for it', () => {
  assert.equal(tierOf('deepseek-v4-flash'), 'fastest');
  assert.equal(tierOf('nemotron-3-nano:30b'), 'fastest');
  assert.equal(tierOf('gpt-oss:20b'), 'fastest', '20B is small enough to be quick');
  assert.equal(tierOf('gemma4:31b'), 'fastest');

  assert.equal(tierOf('deepseek-v4-pro'), 'smartest');
  assert.equal(tierOf('nemotron-3-ultra'), 'smartest');
  assert.equal(tierOf('mistral-large-3:675b'), 'smartest');
  assert.equal(tierOf('qwen3.5:397b'), 'smartest');

  assert.equal(tierOf('gpt-oss:120b'), 'balanced', 'the default sits in the middle');
  assert.equal(tierOf('glm-5.2'), 'balanced');
  assert.equal(tierOf('kimi-k3'), 'balanced');
  assert.equal(tierOf('nemotron-3-super'), 'balanced', 'super is not one of the size words');
});

test('every surviving model lands on exactly one shelf', () => {
  const shelves = new Set(['smartest', 'balanced', 'fastest']);
  for (const name of shortlist(LISTED)) {
    assert.ok(shelves.has(tierOf(name)), `${name} landed on ${tierOf(name)}`);
  }
});

test('a model the plan cannot run is not offered', () => {
  // kimi-k3 is listed by the host and answers 402 "extra usage only". A button
  // that fails after you have waited for it is worse than no button.
  const kept = hide(LISTED, { OLLAMA_HIDE: 'kimi-k3' });
  assert.ok(!kept.includes('kimi-k3'));
  assert.ok(kept.includes('kimi-k2.7-code'), 'and nothing else in the family goes with it');
  assert.equal(hide(LISTED, {}).length, LISTED.length, 'no list configured hides nothing');
  assert.equal(hide(LISTED, { OLLAMA_HIDE: ' kimi-k3 , glm-5.1 ' }).length, LISTED.length - 2,
    'the list tolerates spaces');
});

test('the configured default is never hidden', () => {
  // If what runs by default is unusable, that is worth seeing rather than
  // concealing -- a menu with no entry for the model in use explains nothing.
  const kept = hide(LISTED, { OLLAMA_HIDE: 'kimi-k3' }, 'kimi-k3');
  assert.ok(kept.includes('kimi-k3'));
});

test('the menu is smaller than the raw list, and keeps the useful ones', () => {
  const kept = shortlist(LISTED);
  assert.ok(kept.length < LISTED.length, 'something was actually filtered');
  assert.equal(kept.length, 14, '19 listed, five superseded versions dropped');
});
