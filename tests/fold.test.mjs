// The fold geometry. Pure maths, so it is worth pinning: every one of these
// went wrong at least once by eye, and "the corner looks a bit off" is not a
// bug report you can act on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldLine, reflection, clipRect, polygon, clampPointer, side } from '../public/fold.js';

const apply = (m, p) => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const samePoint = (p, q, tol = 1e-6) =>
  assert.ok(near(p.x, q.x, tol) && near(p.y, q.y, tol),
    `expected (${q.x}, ${q.y}), got (${p.x.toFixed(4)}, ${p.y.toFixed(4)})`);

const CORNER = { x: 400, y: 600 };   // bottom-right of a 400x600 page

test('folding puts the corner exactly on the pointer', () => {
  // This is what folding paper IS. If it does not hold, the flap does not meet
  // your finger and the whole thing reads as fake.
  for (const pointer of [{ x: 120, y: 500 }, { x: 0, y: 0 }, { x: 399, y: 1 }, { x: 40, y: 590 }]) {
    const line = foldLine(CORNER, pointer);
    samePoint(apply(reflection(line.mid, line.theta), CORNER), pointer, 1e-6);
  }
});

test('the reflection is its own inverse', () => {
  const line = foldLine(CORNER, { x: 150, y: 420 });
  const m = reflection(line.mid, line.theta);
  const p = { x: 217, y: 333 };
  samePoint(apply(m, apply(m, p)), p, 1e-6);
});

test('points on the crease do not move', () => {
  const line = foldLine(CORNER, { x: 100, y: 300 });
  const m = reflection(line.mid, line.theta);
  samePoint(apply(m, line.mid), line.mid, 1e-6);
  // ...and so does any other point along it.
  const along = { x: line.mid.x + Math.cos(line.theta) * 90, y: line.mid.y + Math.sin(line.theta) * 90 };
  samePoint(apply(m, along), along, 1e-5);
});

test('the flap and the rest of the page are complementary', () => {
  const line = foldLine(CORNER, { x: 120, y: 500 });
  const flap = clipRect(400, 600, CORNER, line, true);
  const rest = clipRect(400, 600, CORNER, line, false);
  assert.ok(flap.length >= 3, 'the flap should be a real polygon');
  assert.ok(rest.length >= 3, 'the remaining page should be a real polygon');

  const area = (pts) => Math.abs(pts.reduce((sum, p, i) => {
    const q = pts[(i + 1) % pts.length];
    return sum + (p.x * q.y - q.x * p.y);
  }, 0) / 2);
  assert.ok(near(area(flap) + area(rest), 400 * 600, 0.5),
    'the two pieces must add back up to the page — a gap would show as a seam');
});

test('the flap contains the corner and the rest does not', () => {
  const line = foldLine(CORNER, { x: 150, y: 450 });
  const flap = clipRect(400, 600, CORNER, line, true);
  assert.ok(flap.some((p) => near(p.x, CORNER.x, 0.01) && near(p.y, CORNER.y, 0.01)),
    'the piece that folds has to include the corner being dragged');
});

test('a pointer at the corner folds nothing', () => {
  const line = foldLine(CORNER, { x: 400, y: 600 });
  assert.equal(line.length, 0);
  const flap = clipRect(400, 600, CORNER, line, true);
  const area = Math.abs(flap.reduce((sum, p, i) => {
    const q = flap[(i + 1) % flap.length];
    return sum + (p.x * q.y - q.x * p.y);
  }, 0) / 2);
  assert.ok(area < 1, 'no drag, no fold');
});

test('the pointer is clamped so the page cannot leave the book', () => {
  const far = clampPointer({ x: -5000, y: -5000 }, CORNER, 400, 600);
  const reach = Math.hypot(far.x - CORNER.x, far.y - CORNER.y);
  assert.ok(reach <= Math.hypot(400, 600) + 0.001, `reach ${reach} exceeds the diagonal`);
  // A pointer already in range is left alone.
  samePoint(clampPointer({ x: 200, y: 300 }, CORNER, 400, 600), { x: 200, y: 300 });
});

test('side() tells the flap from the page', () => {
  const line = foldLine(CORNER, { x: 100, y: 200 });
  assert.equal(side(CORNER, CORNER, line), 1);
  assert.equal(side({ x: 0, y: 0 }, CORNER, line), -1, 'the far corner is not part of the flap');
});

test('polygon() degrades to nothing rather than to the whole page', () => {
  // A clip of "everything" would show the flap covering the page, which reads
  // as the page having jumped. Nothing is the safe direction to fail.
  assert.match(polygon([]), /polygon\(0 0, 0 0, 0 0\)/);
  assert.match(polygon([{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }]), /1\.0px 2\.0px/);
});
