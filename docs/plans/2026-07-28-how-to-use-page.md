# "How to use" — a guided tour with screen recordings

**Goal.** A `/how/` page reachable from the top of the home page, holding
step-by-step instructions plus a short screen recording for every feature, split
three ways: student, parent, teacher.

## Shape of the thing

```
                    public/index.html  nav
                             │  "How to use"
                             ▼
                    public/how/index.html
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
         I'm a student  I'm a parent   I'm a teacher
              │              │              │
              └──────────────┴──────────────┘
                             │  each tab renders from
                             ▼
                 public/how/steps/<role>.json
                             │  { steps: [{ n, title, body, clip }] }
                             ▼
                 public/how/media/<clip>.webm
                             ▲
                             ┆  regenerated, never hand-made
                    scripts/record/<role>.mjs
                             ▲
                    scripts/record/lib.mjs   (shared harness)
```

Steps live in JSON, not in the HTML, so rewording a step or re-recording a clip
never touches markup. The page is a static file with ~30 lines of render code —
the same JS-required posture the rest of the app already takes.

## Why recordings, and how they get made

Playwright records one video **per page**, per context. So each clip is: open a
new page in a shared (already-signed-in) context, do the actions, close the
page, save the video. Shared context means the teacher signs in once and every
later clip inherits the session, while each clip is still its own file.

Two things a raw Playwright recording gets wrong for a tutorial, both fixed in
`lib.mjs`:

- **No mouse cursor.** CDP moves the pointer but nothing paints it. An injected
  dot that tracks `mousemove` and pulses on `mousedown` makes the clip legible.
- **Machine speed.** Typing and clicking land instantly. Human-paced `type()`,
  a `point()` that travels to a target before clicking, and explicit `beat()`
  pauses give a viewer time to read.

`playwright` is deliberately **not** added to `package.json`. `DEPLOY.md` step 1
is `npm install`, and making everyone who deploys a static site download
Chromium is a real cost for no benefit. `scripts/record/lib.mjs` says
`npm i -D playwright` in its header and fails with that message if it is absent.

## Steps

### 0 — Foundation (must land before anything fans out)

| # | Change | Why |
|---|---|---|
| 0.1 | `scripts/dev.mjs`: `DEV_DB` env override for the sqlite path | Four recorders at once would otherwise fight over one `.dev.sqlite` |
| 0.2 | `scripts/dev.mjs`: `.webm` → `video/webm` in the MIME map | Otherwise local dev serves clips as `octet-stream` and nothing plays |
| 0.3 | `.gitignore`: `.dev.sqlite` → `.dev*.sqlite` | The per-recorder databases |
| 0.4 | `scripts/record/lib.mjs` | The shared harness: server boot, context, cursor, `clip()`, `type()`, `point()`, `beat()` |
| 0.5 | Manifest schema + clip geometry | Recorded 1280×800; displayed in a figure `calc(var(--rule) * 14)` tall so a video never breaks the ruled-paper grid |

### 1 — Four recorders, in parallel

Each agent gets its own port and its own database, walks the flow in a real
browser, reads the **actual** on-screen labels (no invented UI text), writes its
recording script, runs it, and emits its manifest.

| Agent | Port | Covers |
|---|---|---|
| `student` | 8801 | Home → Set up my account → student ID, last name, school email → the one-time access code screen → on to signing |
| `parent` | 8802 | Home → Read and sign → student ID + access code → turning pages → initialing a section → the final agree → all-sections-done + print |
| `teacher-setup` | 8803 | Teacher sign-in → Classes → the syllabus editor: start from a document, paste, Fix headings, Suggest initials, Save draft, Publish |
| `teacher-manage` | 8804 | Access codes (read one, reissue both), Who has signed, roster import, teacher sign-up, settings/AI model |

Outputs per agent, all disjoint:
`scripts/record/<role>.mjs`, `public/how/steps/<role>.json`,
`public/how/media/<role>-NN-*.webm`.

### 2 — The page

- `public/how/index.html` — three tabs, steps from the manifests, each clip a
  `<video controls muted loop playsinline preload="metadata">`. No autoplay:
  a page that starts four videos on load is hostile, and it respects
  `prefers-reduced-motion` by simply never moving on its own.
- `public/index.html` — `How to use` in the main nav.
- Admin pages — the same link, since two of the three roles are behind it.

### 3 — Verify

- `npm test` still green (296).
- Playwright pass on `/how/`: light and dark, 1280 and 390 wide, no horizontal
  scroll, every `<video>` reaches `readyState >= 1`, zero off-grid boxes.
- Every frame is seeded demo data. No real student appears in any clip.
- Report total media bytes; downscale if it runs past ~8 MB.

## Known limits, stated up front

- **Clips are binary in git.** Expect a few MB. They are regenerable from
  `scripts/record/`, so a future trim is a delete plus a re-run.
- **No narration.** The step text carries the explanation; the video shows where
  to click. Adding voice would mean a TTS pipeline and a re-record on every
  wording change.
- **Recordings pin the UI.** A button that gets renamed leaves a stale clip.
  Mitigated by keeping the recording scripts in-repo and short.
