// Records the "Running your class" half of /how/: rosters, access codes, who
// has signed, and teacher accounts. See docs/plans/2026-07-28-how-to-use-page.md.
//
//   node scripts/record/teacher-manage.mjs
//
// Signing in and publishing a syllabus version are done through fetch() from
// inside a page, not through the UI -- neither is one of THIS role's steps.
// Signing in belongs to no single step (every clip needs it already done);
// publishing belongs to the syllabus editor, which the teacher-setup recorder
// owns. Doing them here as plain API calls seeds the state this role's clips
// need without recording, or even touching, someone else's slice.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, open, beat, point, tap, type, park, writeSteps } from './lib.mjs';

const PORT = 8804;
const DB = '.dev-teacher-manage.sqlite';
// Short enough that "Access codes" never wraps to a second line in the
// Classes table -- a wrapped inline link's bounding box spans both lines,
// and tap()'s click lands in the gap between them rather than on either.
const COURSE = 'Study Hall (demo)';

const server = await startServer(PORT, DB);
const rec = await open(server.base, { prefix: 'teacher-manage' });

// ---- fixture roster CSVs -----------------------------------------------
//
// Written to a temp directory, never into the repo: *.csv is gitignored
// because a real export holds student PII, and even a fake one has no
// business sitting in git history next to the code that reads it.
//
// Three fake students, same convention as the seeded demo classes: a letter
// for the given name, "Student" for the family name, an obviously synthetic
// ID, example.com. Letters U/V/W so nothing collides with Biology's A-T or
// Algebra's A-C. Student W is the point of the exercise: present in the
// first file, missing from the second (so the drop sweep marks them),
// present again in the third (so the return path gets exercised too).
const tmp = mkdtempSync(join(tmpdir(), 'inishial-roster-'));
const header = 'Student ID,First Name,Last Name,Period,PEM\n';
const studentU = '900001,U,Student,2,parent.u@example.com\n';
const studentV = '900002,V,Student,2,parent.v@example.com\n';
const studentW = '900003,W,Student,2,parent.w@example.com\n';
const rosterFull = join(tmp, 'roster-full.csv');
const rosterWithoutW = join(tmp, 'roster-without-w.csv');
writeFileSync(rosterFull, header + studentU + studentV + studentW);
writeFileSync(rosterWithoutW, header + studentU + studentV);

// ---- sign in (not a step of its own -- every clip below needs it done) --
await rec.scratch(async (page) => {
  await page.goto(server.base + '/');
  await page.evaluate(() => fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'localdev' }),
  }));
});

// Publish the Biology demo class's open draft as version 2. Every existing
// signature was against version 1, so this is what makes "Signed an older
// version" a real, visible state on the progress page rather than a status
// this role's steps would otherwise have to describe with nothing on screen
// to point at. The syllabus editor that would normally do this belongs to
// the teacher-setup recorder -- calling the publish endpoint directly gets
// the same end state without recording, or touching, their page.
await rec.scratch(async (page) => {
  await page.goto(server.base + '/');
  await page.evaluate(async () => {
    const { courses } = await (await fetch('/api/admin/roster')).json();
    const bio = courses.find((c) => c.name === 'Biology 1 (demo)');
    const { syllabus } = await (await fetch(`/api/admin/syllabus?course_id=${bio.id}`)).json();
    await fetch('/api/admin/syllabus', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ syllabus_id: syllabus.id }),
    });
  });
});

// A link scoped to the row by course name, reused on every clip below rather
// than a hardcoded course_id -- the id a fresh import gets depends on
// whatever ran before it, and the visible name does not.
const classRow = (page, name) => page.locator('#coursesTable tbody tr', { hasText: name });

// ---- 1. import a roster --------------------------------------------------
await rec.clip('roster-import', async (page) => {
  await page.goto(server.base + '/admin/');
  await type(page, '#course', COURSE);
  await point(page, '#drop');
  await page.locator('#file').setInputFiles(rosterFull);
  await beat(page, 700);
  await tap(page, '#previewBtn');
  await park(page);
  await beat(page, 1300);
  await tap(page, '#confirmBtn');
  await park(page);
  await beat(page, 1100);
});

// Student W registers their own account now, while still active on the
// roster -- the account this role's later clips need already sitting there
// BEFORE the drop, so the return clip has something real to prove stayed
// intact. Registration itself is the student recorder's territory, so this
// happens as a background fetch, not a click -- and a plain Node fetch
// rather than one run inside the browser page: /api/register mints its own
// session cookie, and the app reuses one cookie name for every role. Firing
// it from inside the page would silently sign the browser out of the admin
// session every later clip in this script depends on.
await fetch(server.base + '/api/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    student_ext_id: '900003', last: 'Student', username: 'student900003@student.example.com',
  }),
});

// ---- 2. a dropped student is marked, not deleted -------------------------
await rec.clip('roster-drop', async (page) => {
  await page.goto(server.base + '/admin/');
  await type(page, '#course', COURSE);
  await point(page, '#drop');
  await page.locator('#file').setInputFiles(rosterWithoutW);
  await beat(page, 700);
  await tap(page, '#previewBtn');
  await park(page);
  await beat(page, 1600);   // the "would drop" callout is the whole point of this step
  await tap(page, '#confirmBtn');
  await park(page);
  await beat(page, 1100);
});

// ---- 3. re-importing brings them back ------------------------------------
// Upload only -- the proof that Student W's account survived the round trip
// is its own clip below. One clip that did both ran to 1.75 MB after VP9,
// about three times the length of any other clip here; two short clips read
// better than one long one and cost less besides.
await rec.clip('roster-return', async (page) => {
  await page.goto(server.base + '/admin/');
  await type(page, '#course', COURSE);
  await point(page, '#drop');
  await page.locator('#file').setInputFiles(rosterFull);
  await beat(page, 700);
  await tap(page, '#previewBtn');
  await park(page);
  await beat(page, 1000);
  await tap(page, '#confirmBtn');
  await park(page);
  await beat(page, 900);
});

// ---- 4. proof the account came back intact --------------------------------
await rec.clip('roster-account-intact', async (page) => {
  await page.goto(server.base + '/admin/');
  await tap(page, classRow(page, COURSE).getByRole('link', { name: 'Access codes' }));
  await beat(page, 700);
  // A code already sitting there, because the account never went anywhere
  // while Student W was dropped -- not a fresh one minted just now. Matched
  // by ID, not by "Student" -- all three rows on this roster share that
  // family name.
  await point(page, page.locator('#rows tr', { hasText: '900003' }));
  await beat(page, 400);
  await park(page);
  await beat(page, 1300);
});

// ---- 5. two codes, both readable on screen -------------------------------
await rec.clip('codes-read', async (page) => {
  await page.goto(server.base + '/admin/');
  await tap(page, classRow(page, 'Algebra I').getByRole('link', { name: 'Access codes' }));
  await beat(page, 800);
  const firstRow = page.locator('#rows tr').first();
  await point(page, firstRow.locator('td').nth(3).locator('.code'));   // parent code
  await beat(page, 400);
  await park(page);
  await beat(page, 1100);
  await point(page, firstRow.locator('td').nth(4).locator('.code'));   // student code
  await beat(page, 400);
  await park(page);
  await beat(page, 1200);
  await point(page, '#csv');
  await beat(page, 400);
  await park(page);
  await beat(page, 900);
});

// ---- 6. the states a code cell can be in ---------------------------------
//
// Only the em dash is something a normal page view can actually catch on
// screen. settle() in credentials.js mints any missing parent code for every
// row the instant this page is requested (see the `mine` check there) --
// unscoped, that is every row with an account. "Not issued yet" is real, but
// it resolves itself in the same request that would render it, so it never
// survives to reach the table. Described in the step text instead of faked
// here.
await rec.clip('codes-states', async (page) => {
  await page.goto(server.base + '/admin/');
  await tap(page, classRow(page, 'Biology 1 (demo)').getByRole('link', { name: 'Access codes' }));
  await beat(page, 800);
  // no account yet -- an em dash in both code columns
  await point(page, page.locator('#rows .code.none').filter({ hasText: '—' }).first());
  await beat(page, 400);
  await park(page);
  await beat(page, 1400);
  // a code, for contrast -- including ones minted by this very page load
  await point(page, page.locator('#rows .code').first());
  await beat(page, 400);
  await park(page);
  await beat(page, 1300);
});

// ---- 7. reissue, and its consequence -------------------------------------
await rec.clip('codes-reissue', async (page) => {
  await page.goto(server.base + '/admin/');
  await tap(page, classRow(page, 'Biology 1 (demo)').getByRole('link', { name: 'Access codes' }));
  await beat(page, 800);
  const reissueBtn = page.locator('[data-reissue]').first();
  await point(page, reissueBtn);
  // confirm() is native and freezes the page underneath it -- there is no DOM
  // node to point a cursor at, so the pause below stands in for it. Accepting
  // is delayed rather than immediate so that pause reads as deliberate.
  page.once('dialog', (dialog) => { setTimeout(() => dialog.accept(), 1300); });
  await tap(page, reissueBtn, { after: 2200 });
  // The payoff: the new code, in the row the "fresh" highlight just marked.
  await point(page, page.locator('tr.fresh td').nth(3).locator('.code'));
  await beat(page, 400);
  await park(page);
  await beat(page, 1200);
});

// ---- 8. who has signed, and what each status means -----------------------
await rec.clip('progress', async (page) => {
  await page.goto(server.base + '/admin/');
  await tap(page, classRow(page, 'Biology 1 (demo)').getByRole('link', { name: 'Who has signed' }));
  await beat(page, 1000);
  await tap(page, page.locator('#filters button[data-f="outstanding"]'));
  await park(page);
  await beat(page, 1300);
  await tap(page, page.locator('#filters button[data-f="stale"]'));
  await park(page);
  await beat(page, 1600);
});

// ---- 9. a second teacher sees none of this --------------------------------
await rec.clip('signup', async (page) => {
  await page.goto(server.base + '/admin/signup/');
  await beat(page, 900);
  await type(page, '#email', 'newteacher@school.edu');
  await type(page, '#name', 'B. Teacher');
  await type(page, '#password', 'DemoPassphrase2026');
  await type(page, '#confirm', 'DemoPassphrase2026');
  await tap(page, '#submit');
  await park(page);
  await beat(page, 1800);   // lands on /admin/ signed in as the new account -- an empty class list
});

await rec.close();
server.stop();

writeSteps('teacher-manage', {
  title: 'Running your class',
  blurb: 'Import rosters, hand out and manage access codes, watch signatures come in, and add other teachers to your school.',
  steps: [
    {
      title: 'Import a roster',
      body: 'On the Classes page, drop a CSV under "Import a roster," or paste rows copied straight from a spreadsheet. Columns are matched by name — Student ID, First/Last Name, Period, and PEM for the parent\'s email — so most exports from your SIS work unchanged. Give the class a name only if the file has no Course column. Preview shows exactly what the import will do; nothing is written until you apply it.',
      clip: 'teacher-manage-roster-import.mp4',
    },
    {
      title: 'A student who leaves is marked dropped, not deleted',
      body: 'Upload the same class again later in the term and anyone missing from the new file is not removed — they are marked dropped. Preview always lists who that would be before you commit, so a file that is missing a period by mistake does not quietly drop half the roster.',
      clip: 'teacher-manage-roster-drop.mp4',
    },
    {
      title: 'Re-importing brings a returning student back',
      body: 'A student who shows up again in a later file goes straight back to active, on the same roster row they had before. Nothing to reissue or re-register — the next step shows why.',
      clip: 'teacher-manage-roster-return.mp4',
    },
    {
      title: 'The account comes back intact, not fresh',
      body: 'That student\'s account, their codes, and anything already signed came back with them. The code on screen here is the same one they had before they dropped off the roster — not a new one minted for the occasion.',
      clip: 'teacher-manage-roster-account-intact.mp4',
    },
    {
      title: 'Every code is right here, ready to read back',
      body: 'Each student has two codes: the parent\'s, mailed home, and the student\'s own, shown to them once when they set up their account. Which one is typed in at sign-in decides whose initials get written, so the two are never the same string — and both are visible on this page if a parent calls asking for theirs again.',
      clip: 'teacher-manage-codes-read.mp4',
    },
    {
      title: 'What an empty cell means',
      body: 'An em dash means no account exists yet, so there is nothing to hand out. "Not issued yet" is real, but you will rarely catch it on screen: opening this page mints a parent code for anyone missing one, so by the time the table renders it is usually already filled in. "Cannot be shown" is a third thing entirely, and does not resolve itself — that code exists and still works for sign-in, it just predates the code vault, or was sealed under a secret that has since rotated. Reissuing is the only way to see it on screen again.',
      clip: 'teacher-manage-codes-states.mp4',
    },
    {
      title: 'Reissue when a code is lost or compromised',
      body: 'Reissue both mints two new codes for one student on the spot. The pair already mailed out — yesterday or back in September — stops working the instant you confirm, so know where the new one is going before you click through the warning.',
      clip: 'teacher-manage-codes-reissue.mp4',
    },
    {
      title: 'Handle the CSV export carefully',
      body: 'Download CSV hands you every code on the roster in one plaintext file, ready for a mail merge. Treat it like the printed originals: do not leave it sitting in a shared downloads folder, and delete it once the merge is done.',
    },
    {
      title: 'See who has signed, and what each status means',
      body: 'Not registered, no code issued, not started, partly signed, signed an older version, or complete — the filters above the table narrow to any one of them. "Signed an older version" is the one worth watching: it appears the moment you publish a change, for every parent who had already initialed the syllabus before it.',
      clip: 'teacher-manage-progress.mp4',
    },
    {
      title: 'Teacher accounts keep every roster separate',
      body: 'Sign up at /admin/signup/ with a school address on the allowed domain, and you see only the classes, rosters and codes you have imported — a colleague\'s are invisible from your account, and yours from theirs. The domain check only decides who is allowed to sign up; it does not verify who is actually behind that address. If you need real identity, put Cloudflare Access in front of /admin/ instead — it is checked on every admin request, alongside this.',
      clip: 'teacher-manage-signup.mp4',
    },
  ],
});
