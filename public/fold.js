// Folding a page corner, for real.
//
// A CSS transform maps a rectangle to a rectangle. It can rotate and skew one in
// perspective, but it cannot BEND it -- so a single element turning is always a
// flat board on a hinge, which is what a whole-sheet rotateY looks like.
//
// A fold is three layers instead:
//
//        ╱ fold line = perpendicular bisector of (corner → pointer)
//       ╱
//  ┌───┼──────┐   1. the page, clipped to everything BEHIND the fold line
//  │   │╲     │   2. whatever is underneath, now uncovered
//  │   │ ╲    │   3. a CLONE of the page, MIRRORED across the fold line, clipped
//  └───┴──╲───┘      to the part in front of it -- the reverse of the paper
//
// Layer 3 is the whole trick: the folded-back flap is showing the back of the
// same sheet, so it has to be the same content reflected, not a blank triangle.
//
// What this deliberately does NOT do is curl. A curl is a curved surface, which
// needs the page as a deformable mesh, which means rasterising it to a texture
// -- and that would kill the live initials inputs the moment you touched the
// corner. A straight fold line is what real DOM can do.

/** Reflection of the plane across the line through `mid` at angle `theta`,
 *  as the six numbers CSS matrix() wants.
 *
 *  matrix(a,b,c,d,e,f) maps (x,y) to (ax + cy + e, bx + dy + f). For a
 *  reflection about a line through the origin at angle t that is
 *  [cos2t, sin2t; sin2t, -cos2t]; the translation is what puts the line back
 *  through `mid` instead of through (0,0). */
export function reflection(mid, theta) {
  const a = Math.cos(2 * theta);
  const b = Math.sin(2 * theta);
  const c = b;
  const d = -a;
  return {
    a, b, c, d,
    e: mid.x - (a * mid.x + c * mid.y),
    f: mid.y - (b * mid.x + d * mid.y),
  };
}

/** The fold line between a corner and the pointer: its midpoint and angle.
 *  Perpendicular bisector, because folding paper puts the corner exactly on the
 *  point you dragged it to -- every point on the crease is equidistant from
 *  both. */
export function foldLine(corner, pointer) {
  const vx = pointer.x - corner.x;
  const vy = pointer.y - corner.y;
  return {
    mid: { x: (corner.x + pointer.x) / 2, y: (corner.y + pointer.y) / 2 },
    // The crease runs perpendicular to corner→pointer.
    theta: Math.atan2(vx, -vy),
    length: Math.hypot(vx, vy),
  };
}

/** Which side of the fold line a point is on. Positive means the same side as
 *  the corner, i.e. the part that folds. */
export function side(point, corner, line) {
  const dx = Math.cos(line.theta);
  const dy = Math.sin(line.theta);
  const cross = (p) => (p.x - line.mid.x) * dy - (p.y - line.mid.y) * dx;
  return Math.sign(cross(point)) === Math.sign(cross(corner)) ? 1 : -1;
}

/**
 * Clip a rectangle to one side of the fold line -- Sutherland–Hodgman with a
 * single edge, which is all a half-plane needs.
 *
 * `keepCornerSide` picks which piece you get: the flap, or the page minus the
 * flap. Returns polygon points in px, ready for clip-path.
 */
export function clipRect(w, h, corner, line, keepCornerSide) {
  const dx = Math.cos(line.theta);
  const dy = Math.sin(line.theta);
  const signed = (p) => (p.x - line.mid.x) * dy - (p.y - line.mid.y) * dx;
  const cornerSign = Math.sign(signed(corner)) || 1;
  const keep = (p) => {
    const s = signed(p) * cornerSign;
    return keepCornerSide ? s >= 0 : s <= 0;
  };

  const rect = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const out = [];
  for (let i = 0; i < rect.length; i++) {
    const cur = rect[i];
    const nxt = rect[(i + 1) % rect.length];
    const curIn = keep(cur);
    const nxtIn = keep(nxt);
    if (curIn) out.push(cur);
    if (curIn !== nxtIn) {
      // Where the edge crosses the fold line.
      const a = signed(cur);
      const b = signed(nxt);
      const t = a / (a - b);
      out.push({ x: cur.x + (nxt.x - cur.x) * t, y: cur.y + (nxt.y - cur.y) * t });
    }
  }
  return out;
}

/** A clip-path polygon() value from points in px. */
export function polygon(points) {
  if (points.length < 3) return 'polygon(0 0, 0 0, 0 0)';
  return `polygon(${points.map((p) => `${p.x.toFixed(1)}px ${p.y.toFixed(1)}px`).join(', ')})`;
}

/** Keep the pointer inside the page, and stop the fold passing the far edge --
 *  a corner cannot be dragged further than the sheet is wide without the paper
 *  leaving the book. */
export function clampPointer(pointer, corner, w, h) {
  const maxReach = Math.hypot(w, h) * 0.98;
  const vx = pointer.x - corner.x;
  const vy = pointer.y - corner.y;
  const d = Math.hypot(vx, vy);
  if (d <= maxReach || d === 0) return pointer;
  const k = maxReach / d;
  return { x: corner.x + vx * k, y: corner.y + vy * k };
}
