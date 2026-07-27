# iniSHial — design

> **No backpack required.**

**Date:** 2026-07-27 · **Status:** design, implementation in progress

Platform-facing name is `inishial` (Cloudflare project and D1 names must be
lowercase).

## Goal

Turn a Word/PDF syllabus into a living HTML document that students register
against and parents initial **section by section**, so a signature proves they
read a specific policy rather than scrolled past everything and ticked one box
at the end.

## Why build instead of buy

Prior art was checked before committing to a build.

| | HTML for signer | HTML source of truth | Edit in place | Free |
|---|---|---|---|---|
| DocuSign Responsive Signing + Smart Sections | yes | no | no | no |
| DocuSeal (open source) | no | no | no | yes |
| DocuSeal Enterprise | no | yes | partial | no |
| Simple Syllabus | yes | yes | yes | institution-licensed |
| **This** | yes | yes | yes | yes |

DocuSign's Responsive Signing genuinely converts an uploaded document to
reflowing HTML with collapsible Smart Sections. It fails the actual
requirement: the source of truth stays an uploaded document, so next year's
edit means re-uploading and re-sending. Every e-signature product is built
around "an envelope is a frozen document" — none of them have a document you
edit in place.

The signature mechanics are a solved problem and not the reason to build. The
living, editable source of truth is.

## Constraints

- **Open source** for all code and dependencies. Hosting on Cloudflare
  Pages/D1 is accepted as an exception — the app stays portable.
- Reuses patterns already proven in `bookshelf-auth-prod`: Pages + Functions +
  D1, `functions/_lib/studio_jwt.js` for tokens, `functions/_lib/ollama.js`
  for the model client.
- Separate repo and separate D1 database. Student PII does not enter the
  bookshelf database.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Auth | Student-chosen username + generated **access code** | No student-chosen passwords. Minors reuse passwords across school accounts; a breach here would leak credentials that work elsewhere, and a plaintext password mailed to a parent lives in that inbox forever. A random code is worth nothing outside this app and needs no reset flow. |
| Signature | Typed initials + audit row | Timestamp, IP, user agent, and a hash of the exact block text. A drawn squiggle is not more binding and costs image storage plus mobile touch handling. |
| Roster | Teacher uploads CSV first | Only listed student IDs may register. Blocks junk and impostor accounts. |
| Roster re-upload | Absent students marked `dropped`, never deleted | What every roster-sync system converges on (Canvas concludes an enrollment, OneRoster flips status to inactive). Deleting cascades away signatures that may still need producing for the period the student was enrolled, and students dropped in week two are frequently back in week three — at which point their account and signatures should simply return. Scoped to the (course, period) pairs the uploaded file actually covers, so uploading one period cannot drop another. |
| Credential minting | Codes created by the teacher's export, not at registration | Codes are hashed and therefore unrecoverable, so the plaintext has to surface at the moment it is created. Minting during export puts the one and only plaintext in the same CSV about to be mailed, and students never have to carry a code. Re-exporting does not rotate codes already issued; `?reissue=1` does that deliberately. |
| Scope | Several syllabi, one per course | |
| Extraction | Mammoth.js (DOCX) / pdf.js (PDF), **in the browser** | Deterministic and lossless. Cloudflare Workers cannot run a pandoc binary, and client-side conversion means the source file never needs uploading. |
| Structuring | Ollama, authoring time only | The model splits blocks and proposes which sections deserve initials. It never does text extraction — see risks. |
| Editor | Block list over JSON | bookSHelf's editor (`studio/src/main/annotate.ts`) was reviewed and does not port: it writes `position:absolute` in fixed 1280x720 stage coordinates, correct for a slide and wrong for a document read on a phone. Stable block IDs also keep signature audit rows valid across edits. |
| Frontend | Static HTML + vanilla JS, no build step | Matches bookSHelf. One vendored dependency: Mammoth. |
| Parent notification | **Teacher sends it, manually, from their own account** | Deletes the entire mail subsystem — no SMTP, no relay, no bounce handling, and no proprietary sender to conflict with the open-source constraint. Export a CSV per class and mail-merge from school email or whatever the district already uses. |
| Parent link | One public URL per syllabus | Since nothing is auto-sent, there is no recipient to mint a token for. The parent authenticates with student ID + access code at the URL. No per-parent JWTs. |
| Navigation | One static top nav, duplicated into all eight pages | Logo left, destinations centre, session right. Duplicated markup rather than injected by JS, so the nav is in the HTML before any script runs — a nav that appears late is a nav that flashes, and a nav that needs JS is a dead end when JS fails. `ui.js` only decorates it (`aria-current`, carrying `?course_id` across the admin pages). The rule it enforces: no page you can land on has no way back out, the editor and the import flow included. |
| Theming | `light-dark()` + `color-scheme`, one declaration per token | The toggle sets `color-scheme` on `<html>` and never names a colour, so a theme can never go stale in one half — the alternative, a duplicate `@media (prefers-color-scheme: dark)` block, is how a dark theme ends up with one unconverted value nobody notices. Absent a stored choice it follows the OS. Browsers without `light-dark()` keep a complete light palette declared above the `@supports` block, so the failure mode is "always light", never "no colours at all". |
| Vertical rhythm | A real baseline grid on `--rule` (32px), verified by measurement | Body line-height is one rule and every block consumes a whole number of them, so text sits on the ruled lines of the paper rather than drifting off them. `--baseline` (the font's baseline offset) plus `--sit` (3px, clearing the descenders) positions the ruled background. The arithmetic is not trusted: `tests`-adjacent headless checks read the rendered baseline of every text element back out of the laid-out page, which is the only thing that catches a `display:inline-block` textarea adding 9px of strut, or a 1.6rem handwritten stamp growing its line by 2px and accumulating 8px of drift over four signed sections. |
| Page transitions | Native cross-document view transitions | The sheet hinges on the left spine — where the binder holes are — lifts and turns, revealing the next page. No library and no JavaScript: the page-flip libraries render a book widget out of DOM nodes they own and cannot animate a real navigation, and this is a multi-page app with forms and server state, not a flipbook. Unsupported browsers navigate instantly, which is what they do today. Suppressed entirely under `prefers-reduced-motion` — a full-viewport rotation is exactly the motion that triggers vestibular symptoms. |
| Emphasis | A highlighter band behind the words, never a text colour | Every word on the page is `--ink`; importance is a marker stroke or a strip of tape drawn behind it on a `::before`. One contrast pair to get right instead of a dozen, it needs no per-theme recolouring, and it is the emphasis a teacher actually makes on paper. Animated with `transform: scaleX()` (compositor-only) rather than `background-size`, and under `prefers-reduced-motion` the band still arrives — it just arrives already drawn. Print and forced-colours both discard backgrounds, so the underline beneath it is the real cue and the band is decoration on top. |

## Architecture

```
  AUTHOR (once a year)
  syllabus.docx
      │  mammoth.js / pdf.js  (browser, exact extraction)
      ▼
  clean HTML ──POST /api/import──> Worker ──> Ollama ──> blocks[]
                                                            │
                                                            ▼
                                              editor: drag, edit, mark
                                                            │
                                                     PUBLISH (freeze version)
  ──────────────────────────────────────────────────────────┼─────────────
                                                            ▼
  STUDENT (day 1, QR)            PARENT                       TEACHER
  student ID + last name         opens the public URL         dashboard
    ↓ matched to roster            ↓                          per course/period
  picks username                 student ID + access code     who is missing
    ↓                              ↓  [rate limited]          print signed copy
  receives access code           reads, initials sections       │
  gives parent email               ↓                            │
    │                            signature rows written         │
    │                                                           ▼
    └────────────────────────────────────────────>  CSV export: student,
                                                    parent email, code, link
                                                           │
                                                    teacher mail-merges
                                                    from their own account
```

## Data model

```
courses      id, name
imports      id, created_at, admin_email, filename    -- one row per upload
roster       id, course_id, period, student_ext_id, first, last,
             status, dropped_at, last_seen_import
accounts     id, roster_id, username, code_hash, code_issued_at,
             parent_email, created_at
syllabi      id, course_id, title
versions     id, syllabus_id, num, published_at          -- NULL = draft
blocks       id, version_id, ord, type, html, needs_initials
signatures   id, account_id, version_id, block_id, role,
             initials, block_hash, signed_at, ip, user_agent
```

`type` is one of `heading | text | list | initial | agree`.

## Versioning — the load-bearing idea

A living document and a legal signature want opposite things. If the
attendance policy changes in October, what did the parent who initialed in
August agree to?

Editing writes to the draft version. **Publishing freezes it**: `published_at`
is stamped and no published block is ever mutated. Each signature stores the
hash of the block text at signing time.

Republishing shows a diff first, so re-initialing is requested only for blocks
that actually changed. Unchanged sections keep their existing signatures — a
typo fix does not invalidate the document.

`signatures` is append-only. The entire audit story is "rows are never
modified."

## Security

Not negotiable, called out so it does not get trimmed later:

- **Access codes are rate limited** per IP and per student, counted in D1. An
  8-character code resists a person guessing and falls instantly to a script
  making 10,000 requests.
- **Codes stored hashed**, PBKDF2 via WebCrypto — already present in the
  Workers runtime, no dependency. A D1 leak yields no usable codes.
- The syllabus URL is **public and shared**, so the access code is the only
  thing standing between a stranger and signing as someone's parent. This
  makes the rate limiter load-bearing rather than defensive, and it is why
  codes must be long enough to resist offline guessing (8+ chars, base32,
  ambiguous characters excluded).
- `studio_jwt.js` is used only for the teacher's own admin session. Parents
  never get a token.
- Student PII lives in its own D1 database, not the bookshelf one.

## AI boundaries

- **The model never extracts text.** On a document parents legally initial, a
  model transcribing a DOCX can drop a sentence or smooth a policy into
  something that was never written, and nobody notices until a parent disputes
  it. Mammoth extracts verbatim; the model only structures what Mammoth
  produced.
- **Proposes, never applies.** Suggestions land in a diff next to the original.
  Nothing enters a published version without an explicit accept.
- **Authoring time only.** Parents and students never reach a model. Signing
  stays deterministic, instant, and free per signature.

Local Ollama serves the import path; `ollama.com` with `OLLAMA_API_KEY` as a
Pages secret serves in-editor assist. Same client either way.

## Deferred

Named so they are choices, not oversights:

- Spanish (or other language) translation of a section — one Ollama call,
  add when the parent population needs it.
- Persistent student accounts shared with bookSHelf. Syllabus owns its own
  accounts for now.
- Drawn signature canvas.
- Any per-student PDF generation beyond browser print CSS.

## Deferred (continued)

- Automated parent email. Deliberately not built — the teacher sends links
  from their own account, which removes the only proprietary dependency the
  design would otherwise have needed.

## Open questions

- Roster CSV column format. Building against common SIS headers with a
  case-insensitive alias map (`Student ID` / `StudentID` / `Student Number`,
  `Last Name` / `LastName`, etc.) so most exports import without changes. A
  real sample from the SIS will confirm or extend the alias list.
