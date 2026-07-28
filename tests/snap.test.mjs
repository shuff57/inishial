// Rounding imported content up to a whole ruled line.
//
// The DOM walk needs a browser; this arithmetic does not, and it is where the
// bugs are. An image 137px tall inside a document ruled every 32px is what this
// exists for -- everything after it on the page would otherwise sit 23px off
// the lines for the rest of the section.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gapToNextRule } from '../public/snap.js';

const RULE = 32;

test('content already on a rule is left alone', () => {
  for (const h of [32, 64, 96, 960]) {
    assert.equal(gapToNextRule(h, RULE), 0, `${h}px is already a whole number of rules`);
  }
});

test('an odd height rounds up to the next rule', () => {
  assert.equal(gapToNextRule(137, RULE), 23, '137 + 23 = 160, five rules');
  assert.equal(gapToNextRule(33, RULE), 31);
  assert.equal(gapToNextRule(1, RULE), 31);
});

test('the result always lands on a rule', () => {
  for (let h = 1; h <= 400; h++) {
    const total = h + gapToNextRule(h, RULE);
    const over = total % RULE;
    assert.ok(over < 0.5 || RULE - over < 0.5, `${h}px snapped to ${total}px, which is not a rule`);
  }
});

test('sub-pixel noise is not treated as drift', () => {
  // Browsers report fractional heights. Correcting 63.9 by 0.1 is invisible;
  // the danger is the other direction -- treating 64.1 as "needs 31.9 more"
  // and opening a blank rule under every block on the page.
  assert.equal(gapToNextRule(63.9, RULE), 0);
  assert.equal(gapToNextRule(64.1, RULE), 0);
  assert.equal(gapToNextRule(64.6, RULE), 31.4);
});

test('a zero-height or unmeasured block asks for nothing', () => {
  // An image that has not decoded yet measures 0. Snapping it to a full rule
  // would put a blank line where the picture is about to appear.
  assert.equal(gapToNextRule(0, RULE), 0);
  assert.equal(gapToNextRule(NaN, RULE), 0);
  assert.equal(gapToNextRule(100, 0), 0, 'no rule pitch means nothing to snap to');
});
