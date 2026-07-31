// The icon sprite, and every reference to it.
//
// These exist because the sprite failed silently, twice, in the same way. A
// `--` inside an XML comment is illegal; public/icons.svg is served as
// image/svg+xml and therefore parsed as XML, not as HTML. When it fails to
// parse the browser reports nothing, the request still returns 200, the <svg>
// box is still the size CSS gave it, and every icon button simply renders
// empty. Nothing in a normal page test would notice.
//
// The house comment style uses ` -- ` for an aside everywhere else in this
// repo, so the mistake is one keystroke away every time an icon is added or
// its note is edited. Hence a test rather than a promise to remember.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PUBLIC = new URL('../public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const sprite = readFileSync(join(PUBLIC, 'icons.svg'), 'utf8');

const comments = (s) => s.match(/<!--[\s\S]*?-->/g) ?? [];

/** Every .html under public/, so a new page is covered without being listed. */
function pages(dir = PUBLIC, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { if (entry !== 'vendor') pages(full, out); }
    else if (entry.endsWith('.html')) out.push(full);
  }
  return out;
}

test('the sprite is well-formed XML, so the browser can actually parse it', () => {
  // The specific rule that has bitten twice: no "--" inside a comment body.
  for (const c of comments(sprite)) {
    assert.ok(!c.slice(4, -3).includes('--'),
      `illegal "--" inside an XML comment (use an em dash):\n${c.slice(0, 90)}…`);
  }
  // And the shape a sprite has to have at all.
  assert.match(sprite, /<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(!/<svg[^>]*style="[^"]*display:\s*none/.test(sprite),
    'display:none on the root leaves externally referenced symbols with no geometry');
});

test('the favicon is well-formed too, and carries its own colours', () => {
  const fav = readFileSync(join(PUBLIC, 'favicon.svg'), 'utf8');
  for (const c of comments(fav)) {
    assert.ok(!c.slice(4, -3).includes('--'), 'illegal "--" inside an XML comment in favicon.svg');
  }
  // A favicon renders with no document around it, so currentColor has nothing
  // to resolve against and the mark comes out invisible. Checked against the
  // MARKUP only -- the comment in that file explains this choice and names
  // currentColor to do so, which a naive search reads as a violation.
  const markup = fav.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/currentColor/.test(markup), 'favicon cannot use currentColor');
  assert.match(fav, /prefers-color-scheme:\s*dark/, 'favicon should follow the reader\'s theme');
});

test('every icon a page asks for actually exists in the sprite', () => {
  const defined = new Set([...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
  assert.ok(defined.size > 0, 'no symbols found — the sprite is empty or unparseable');

  const missing = [];
  for (const file of pages()) {
    const html = readFileSync(file, 'utf8');
    for (const m of html.matchAll(/<use href="\/icons\.svg#([^"]+)"/g)) {
      if (!defined.has(m[1])) missing.push(`${file.slice(PUBLIC.length)} -> #${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], 'these pages reference symbols that do not exist');
});

test('a control that swaps to an icon keeps a name for anyone not looking at it', () => {
  // .to-icon hides its .label at narrow widths. Hidden VISUALLY is fine;
  // hidden from the accessibility tree would leave a row of nameless buttons,
  // so each one has to carry a label span or an explicit aria-label.
  const bad = [];
  for (const file of pages()) {
    const html = readFileSync(file, 'utf8');
    for (const m of html.matchAll(/<(a|button)[^>]*class="[^"]*\bto-icon\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/g)) {
      const [tag, inner] = [m[0], m[2]];
      if (!/class="label"/.test(inner) && !/aria-label=/.test(tag)) {
        bad.push(`${file.slice(PUBLIC.length)}: ${tag.slice(0, 70)}…`);
      }
    }
  }
  assert.deepEqual(bad, [], 'these icon-swapping controls have no accessible name');
});
