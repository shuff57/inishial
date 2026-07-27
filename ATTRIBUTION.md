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

**Preserved from the original:** the locked palette — dark desk `#2d2d2d`,
cream paper `#f8f6f1`, ink `#1a1a1a`, muted `#6b6358`, hairline `#d8d2c4`, and
the five index-tab hues `#98d4bb / #c7b8ea / #f4b8c5 / #a8d8ea / #ffe6a7` in
order. The signature devices: cream paper card on a dark ground, ruled-line
grain, left binder holes, and the margin rule. Bodoni for display, DM Sans for
reading.

**Changed for this app:** it is a scrolling document on a phone, not a fixed
1280×720 slide stage, so paper geometry is fluid rather than absolutely
positioned. The berry-rose accent `#a8455f` comes from bookSHelf's page-theme
derivation of the deck's pink margin rule, deepened to clear AA on cream. A
handwriting face was added (see below), used only for initials, margin notes,
and the masthead.

### Accessibility, carried over unchanged

bookSHelf's audit of this palette applies here and no token was lightened:

- `--ink-stone #6b6358` on `--paper #f8f6f1` ≈ **4.9:1** — clears AA
- `--ink #1a1a1a` on cream ≈ **15:1**

Two rules to keep: never put body text on anything but the cream ground, and do
not lighten `--ink-stone`.

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

Both are checked into `public/vendor/` and served from our own origin. No CDN,
so a page a parent or teacher opens makes no third-party request.

- **Mammoth.js 1.11.0** — MIT. DOCX to semantic HTML, in the browser.
  <https://github.com/mwilliamson/mammoth.js>
- **SortableJS 1.15.6** — MIT. Drag-to-reorder in the editor.
  <https://github.com/SortableJS/Sortable>

Conversion runs client-side deliberately: the source document never leaves the
teacher's machine, and Workers cannot run a native converter anyway.

Still planned:

- **pdf.js** (Apache-2.0) — PDF text extraction. DOCX is the common case and
  PDF extraction is lossy, so it was not worth blocking the editor on.

## Runtime dependencies

None on the server. No framework, no build step. Hashing and signing use
WebCrypto, already present in the Workers runtime; tests use `node:sqlite` and
`node:test` from the standard library.
