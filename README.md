# iniSHial

**No backpack required.**

A living, editable syllabus that parents initial section by section — so a
signature proves they read the late-work policy, not that they scrolled past it
and ticked one box at the end.

## Why this exists

Every e-signature product treats a document as a frozen envelope. Change the
syllabus next year and you re-upload it and re-send everything. DocuSign's
Responsive Signing will even render your upload as reflowing HTML with
collapsible sections — but the source of truth is still that upload.

iniSHial keeps the syllabus editable and versions the signatures instead.
Fix a typo and nobody re-signs. Change the attendance policy and only that
section needs re-initialing.

## How it works

```
  AUTHOR (once a year)
  syllabus.docx
      │  mammoth.js / pdf.js  — exact extraction, in the browser
      ▼
  clean HTML ──> Ollama structures it ──> drag, edit, mark sections
                                                   │
                                            PUBLISH (freeze a version)
  ─────────────────────────────────────────────────┼─────────────────
                                                   ▼
  STUDENT (day 1, QR)        PARENT                      TEACHER
  student ID + last name     opens the link              dashboard
    ↓ matched to roster        ↓                         who is missing
  picks a username           student ID + access code    print signed copy
    ↓                          ↓                         credential CSV
  gives parent's email       initials each section          │
                               ↓                            ▼
                             signature rows written    you mail the link
                                                       from your own account
```

Nothing is emailed by the app. You send the link yourself, which is what keeps
the whole stack open source.

## Stack

Cloudflare Pages + Functions + D1. Static HTML and vanilla JS, no build step.
Every dependency is open source: Mammoth (DOCX), pdf.js (PDF), SortableJS
(reorder), Ollama (authoring-time AI). WebCrypto for hashing — already in the
runtime, nothing installed.

## Setup

```bash
npm install
npx wrangler d1 create inishial     # paste the id into wrangler.toml
npm run db:local                     # apply the schema locally
npm run dev
npm test
```

Then put a Cloudflare Access application in front of `/api/admin/*`. The
Functions fail closed without it, but failing closed is not the same as being
protected. Narrow it further with the `ADMIN_EMAILS` var.

## Design

`docs/plans/2026-07-27-interactive-syllabus-design.md` — decisions, the
versioning model, security boundaries, and what was deliberately left out.
