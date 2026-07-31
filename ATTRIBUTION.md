# Attribution

iniSHial is MIT licensed. Third-party work it builds on, and the terms that
came with it.

## Notebook theme — MIT

`public/app.css` adapts the token set from bookSHelf's `notebook` theme
(`scripts/workflows/templates/themes/notebook/tokens.json`).

That theme is in turn derived from the **"Notebook Tabs"** style preset in
[`zarazhangrui/frontend-slides`](https://github.com/zarazhangrui/frontend-slides),
by way of Open Design's `fs-notebook-tabs` example, whose `open-design.json`
records `"license": "MIT"` and `"author": {"name": "zarazhangrui"}`.

MIT permits modification and redistribution with attribution. This file is that
attribution.

**Preserved from the original:** cream paper `#f8f6f1`, ink `#1a1a1a`, muted
`#6b6358`, hairline `#d8d2c4`, and the five index-tab hues
`#98d4bb / #c7b8ea / #f4b8c5 / #a8d8ea / #ffe6a7` in order. The signature
devices: cream paper card on a contrasting ground, ruled-line grain, left binder
holes, and the margin rule. Bodoni for display, DM Sans for reading.

**Changed for this app:**

- It is a scrolling document on a phone, not a fixed 1280×720 slide stage, so
  paper geometry is fluid rather than absolutely positioned.
- A handwriting face was added (see below), used only for initials, margin
  notes, and the masthead.
- **The desk is themed, not fixed.** The original's `#2d2d2d` desk is now the
  dark half of `--desk`; light mode puts the same cream sheet on a warm
  parchment desk `#ded5c2` so light mode reads as light rather than as a dim
  room with a bright page in it. Both halves live in one `light-dark()`
  declaration per token.
- **The accent is a highlighter, not a colour.** The berry-rose `#a8455f`
  derived from the deck's pink margin rule is gone: nothing on the page is
  emphasised by recolouring its text. Emphasis is a marker band or a strip of
  tape drawn *behind* words that stay `--ink` (`--mark #ffe08a` light,
  `#6d5717` dark). What remains of the old accent role — outlines, the editor's
  drag affordances, the margin rule — is `--accent`, an amber that never carries
  a word.

### Accessibility

bookSHelf's audit of the inherited tokens still applies and none was lightened:

- `--ink-stone #6b6358` on `--paper #f8f6f1` ≈ **4.9:1** — clears AA
- `--ink #1a1a1a` on cream ≈ **15:1**

Measured for the tokens this app added, in both themes (headless, composited
against the real effective background):

- body text on paper — **16.1:1** light, **13.6:1** dark
- nav text on the desk — **8.0:1** light, **15.1:1** dark
- `--ink` on a `.mark` highlighter band — **13.5:1** light, **5.7:1** dark
- primary button — **13.5:1** light, **5.7:1** dark

Three rules to keep: never put body text on anything but the cream ground; do
not lighten `--ink-stone`; and never let `.mark` or `.tape` inherit a muted
colour — the band is dark enough that muted text on it drops to 2.5:1, so the
act of emphasising a phrase would make it the least readable text on the page.

## Caveat — SIL Open Font License 1.1

`public/fonts/Caveat.ttf`, the handwriting face. Copyright 2014 The Caveat
Project Authors, <https://github.com/googlefonts/caveat>. Full licence in
`public/fonts/OFL-Caveat.txt`.

Self-hosted rather than loaded from Google Fonts: no CDN, and no third-party
request from a page parents open.

**Where handwriting is and is not used.** It is an accent — initials, the
stamped signature, margin notes, the masthead tagline. Body copy, policy text,
and form labels stay in the DM Sans stack. This is a document a parent has to
read and legally initial; a script face for policy text would cost
comprehension and, on a small phone, exclude readers outright.

## Vendored browser libraries

Checked into `public/vendor/` and served from our own origin. No CDN, so a page
a parent or teacher opens makes no third-party request.

- **Mammoth.js 1.11.0** — MIT. DOCX to semantic HTML, in the browser.
  <https://github.com/mwilliamson/mammoth.js>

SortableJS was vendored here until the editor grew section-aware dragging (a
heading carries its whole section). That is not something a generic list-sorter
models, so the reorder is now ~150 lines of our own, ported from bookSHelf's
page editor, and the dependency is gone.

Conversion runs client-side deliberately: the source document never leaves the
teacher's machine, and Workers cannot run a native converter anyway.

Still planned:

- **pdf.js** (Apache-2.0) — PDF text extraction. DOCX is the common case and
  PDF extraction is lossy, so it was not worth blocking the editor on.

## Runtime dependencies

None on the server. No framework, no build step. Hashing and signing use
WebCrypto, already present in the Workers runtime; tests use `node:sqlite` and
`node:test` from the standard library.

The only third-party request the public side makes is to
`buymeacoffee.com`, when a reader clicks `Buy Steven a coffee`. Everything
else stays on the school's origin.

`https://cdnjs.buymeacoffee.com/1.0.0/button.prod.min.js` is loaded on every
public page so its floating widget is ready when the footer card scrolls into
view. The script decides where its button lives (floating, bottom-left) rather
than our markup, so any change to its position comes from BMC and not from
`index.html`. The "More about Steven" link in the footer is a quiet outbound
for readers who did not see the widget.
