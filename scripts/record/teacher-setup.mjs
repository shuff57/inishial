// Records the "building your syllabus" half of the teacher path on /how/:
// signing in, the Classes page, and the syllabus editor end to end -- start
// from a document, fix its structure, ask for initials, edit by hand, save,
// and publish. See lib.mjs for the shared harness (server boot, cursor,
// pacing) and docs/plans/2026-07-28-how-to-use-page.md for how the four
// recorders fit together.
//
//   node scripts/record/teacher-setup.mjs
//
// Port 8803 and .dev-teacher-setup.sqlite are this recorder's own. Three
// other recorders run at the same time against their own ports and
// databases, so nothing here may touch 8788 or .dev.sqlite.
//
// The other half of the teacher path -- access codes, who has signed, roster
// import, teacher sign-up -- is scripts/record/teacher-manage.mjs. This file
// stays out of that ground entirely.

import { startServer, open, tap, type, point, beat, park, reveal, writeSteps } from './lib.mjs';

const PORT = 8803;
const DB = '.dev-teacher-setup.sqlite';

// Resolved BY NAME from this recorder's own database, not hardcoded.
//
// They were 1 and 2, "confirmed against a running server rather than assumed"
// -- and that confirmation expired the moment the seed grew a Geometry class
// for the multi-class flow. Geometry took id 2, Biology slid to 3, and every
// clip that thought it was opening the demo class opened Geometry instead:
// same editor, different syllabus, so nothing errored until a step reached for
// a heading only Biology has. An id is a fact about insertion order; a name is
// a fact about the seed.
const { DatabaseSync } = await import('node:sqlite');
const { join } = await import('node:path');
const { fileURLToPath } = await import('node:url');

function courseIds(dbFile) {
  const db = new DatabaseSync(join(fileURLToPath(new URL('../..', import.meta.url)), dbFile));
  const byName = (name) => {
    const row = db.prepare('SELECT id FROM courses WHERE name = ?').get(name);
    if (!row) throw new Error(`no course named ${name} in ${dbFile} -- has the seed in scripts/dev.mjs changed?`);
    return row.id;
  };
  try {
    return { algebra: byName('Algebra I'), biology: byName('Biology 1 (demo)') };
  } finally {
    db.close();
  }
}

// Unpinned. This was 'gpt-oss:20b', chosen when the configured default was
// gpt-oss:120b and its cold start turned the AI clips into a minute of a
// spinner. Both models have since left the host, so the pin did not merely go
// stale -- it named a model that no longer answers, and the two AI clips
// recorded their own failure message instead of the feature.
//
// Empty means "whatever the host is configured to serve", which is the setting
// a teacher gets and therefore the honest thing to film. Set RECORD_MODEL to
// pin it again if a future default is too slow to watch.
const AI_MODEL = process.env.RECORD_MODEL || '';

// A syllabus paragraph pasted from Word or Docs. Deliberately imperfect: one
// line ("Grading Policy.") is a real heading that ends in a period, which
// textToBlocks()'s "short line, no terminal punctuation" heuristic reads as
// body text -- exactly the mistake Fix format exists to catch. The other
// two headings ("Course Overview", "Attendance") have no terminal
// punctuation, so the local heuristic already gets them right, and the AI
// pass leaves them alone.
const PASTE_TEXT = [
  'Course Overview',
  'This semester covers waves, energy, and simple machines. Lab days happen every Friday and cannot be made up from home.',
  'Grading Policy.',
  'Grades come from tests, labs, homework, and one final project. Late work loses ten percent per day and stops being accepted after one week.',
  'Attendance',
  'Attendance is taken every class period. A missed lab requires a written makeup assignment turned in within a week.',
].join('\n\n');

/** The screen position of one WORD inside an element, found with a Range
 *  rather than guessed from layout. A double-click selects whatever word is
 *  under the pointer in a real browser, so the exact pixel is what matters --
 *  this locates it the way a reader's own eye would, instead of assuming a
 *  fixed offset that breaks the moment the text reflows. */
async function wordBox(page, selector, word) {
  const box = await page.evaluate(({ sel, word }) => {
    const el = document.querySelector(sel);
    const text = el.textContent;
    const at = text.indexOf(word);
    if (at === -1) return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node, offset = at;
    while ((node = walker.nextNode())) {
      if (offset < node.length) break;
      offset -= node.length;
    }
    if (!node) return null;
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + word.length);
    const r = range.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, { sel: selector, word });
  if (!box) throw new Error(`word not found: "${word}" in ${selector}`);
  return box;
}

/** Travel to an element, then double-click its centre. Never
 *  locator.dblclick() in a clip -- it teleports the same way page.click()
 *  does; point() is what makes the trip visible first. */
async function pointAndDblClick(page, target) {
  const loc = await point(page, target);
  const box = await loc.boundingBox();
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * Pick a block up, carry it to just above another one, and drop it.
 *
 * Not in lib.mjs: tap()/point() are for clicks, and a drag is a HELD press --
 * mousedown, several visible moves, mouseup. The editor's own drag lives
 * entirely on pointermove/pointerup (see reorder.js and the startDrag()
 * closure in admin/editor/index.html), which real mouse events satisfy just
 * as well as a real cursor would.
 */
async function dragBlockAbove(page, fromSelector, toSelector) {
  const from = page.locator(fromSelector);
  await from.scrollIntoViewIfNeeded();
  const f = await from.boundingBox();
  const startX = f.x + f.width / 2, startY = f.y + f.height / 2;
  await page.mouse.move(startX, startY, { steps: 20 });
  await beat(page, 300);
  await page.mouse.down();
  await beat(page, 150);
  // A few pixels of movement is what crosses startDrag()'s 4px threshold and
  // actually begins the drag rather than reading as a plain click.
  await page.mouse.move(startX, startY - 12, { steps: 6 });
  await beat(page, 150);
  const to = page.locator(toSelector);
  await to.scrollIntoViewIfNeeded();
  const t = await to.boundingBox();
  // Just inside the top edge of the target -- insertionIndex() resolves a Y
  // above a row's midpoint to "before it".
  await page.mouse.move(t.x + t.width / 2, t.y + 4, { steps: 25 });
  await beat(page, 400);
  await page.mouse.up();
  await beat(page, 700);
}

const server = await startServer(PORT, DB);
console.log(server.log());

// After startServer, because that is what creates and seeds the database.
const { algebra: ALGEBRA_ID, biology: BIOLOGY_ID } = courseIds(DB);
console.log(`  courses: Algebra I = ${ALGEBRA_ID}, Biology 1 (demo) = ${BIOLOGY_ID}`);

const rec = await open(server.base, { prefix: 'teacher-setup' });

// ---- setup that leaves no clip of its own ----
await rec.scratch(async (page) => {
  // Granted on the shared context, not just this page -- every later clip()
  // call opens a fresh page in the same context and inherits the grant. The
  // real paste demo (clip 4) depends on this: a dispatched ClipboardEvent is
  // never trusted, so Chromium ignores it for the native paste-into-textarea
  // action. navigator.clipboard.writeText() plus a real Ctrl+V is the one
  // combination that lands text in the box the way an actual paste would --
  // confirmed by hand, because the more obvious route (setting the OS
  // clipboard from Node and pressing Ctrl+V) does NOT reach a headless
  // browser's textarea at all.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.base });
  // The model Fix format and Suggest initials will use, remembered exactly the
  // way a teacher's own choice would be -- but only when RECORD_MODEL named
  // one. Left unset, the editor's own "default" is what gets filmed, which is
  // what a teacher who never opens Settings actually sees.
  await page.goto(server.base + '/');
  if (AI_MODEL) await page.evaluate((m) => localStorage.setItem('inishial:ollama-model', m), AI_MODEL);
});

// ---- 1. sign in ----
await rec.clip('signin', async (page) => {
  await page.goto(server.base + '/admin/login/');
  await beat(page, 900);
  await type(page, '#password', 'localdev');
  await tap(page, '#submit', { after: 900 });
  await beat(page, 700);
});

// ---- 2. the Classes page ----
await rec.clip('classes', async (page) => {
  await page.goto(server.base + '/admin/');
  const row = page.locator('#coursesTable tbody tr', { hasText: 'Algebra I' });
  await row.waitFor({ state: 'visible' });
  await beat(page, 700);
  await point(page, row);
  await beat(page, 500);
  await point(page, row.locator('a', { hasText: 'Syllabus' }));
  await beat(page, 600);
  await point(page, row.locator('a', { hasText: 'Who has signed' }));
  await beat(page, 500);
  await point(page, row.locator('a', { hasText: 'Access codes' }));
  await beat(page, 600);
  const row2 = page.locator('#coursesTable tbody tr', { hasText: 'Biology' });
  await point(page, row2);
  await beat(page, 900);
  await park(page);
  await beat(page, 900);
});

// ---- 3. open the editor on a class with nothing drafted yet ----
//
// Algebra I was seeded with only a PUBLISHED version -- no draft row exists
// for it, because it never went through this app's own publish flow. The
// very first GET the editor makes calls ensureDraft(), which opens an empty
// draft rather than copying the published content forward (that copy only
// happens on an actual Publish -- see the PUT handler in
// functions/api/admin/syllabus.js). So the editor's honest first-open state
// for a brand new class is exactly this: nothing in the draft yet, and the
// import card showing itself because there is nothing else to show.
await rec.clip('editor-open', async (page) => {
  await page.goto(server.base + '/admin/editor/?course_id=' + ALGEBRA_ID);
  await beat(page, 900);
  await point(page, '#who');
  await beat(page, 500);
  for (const id of ['#structureBtn', '#suggestBtn', '#saveBtn', '#publishBtn']) {
    await point(page, id);
    await beat(page, 260);
  }
  await reveal(page, '#importCard');
  await point(page, '#importCard h2');
  await beat(page, 400);
  await park(page);
  await beat(page, 900);
});

// ---- 4. start over from a pasted document ----
await rec.clip('start-paste', async (page) => {
  await page.goto(server.base + '/admin/editor/?course_id=' + ALGEBRA_ID);
  await beat(page, 900);
  await point(page, '#drop');
  await beat(page, 700);
  // The text is put INTO the box directly rather than through the OS clipboard.
  // navigator.clipboard.writeText needs both a permission grant and a focused
  // document, and a recorded page reliably has neither -- it failed silently,
  // which left the box empty, "Use this text" building nothing, and Save
  // writing an EMPTY DRAFT. The damage surfaced three clips later as an AI step
  // with no blocks to act on, which looks nothing like a clipboard problem.
  //
  // Nothing is lost: #pasteBtn reads the textarea's value (editor/index.html),
  // so this exercises the same path, and a real paste lands instantly too --
  // the box jumping to size is what a viewer sees either way.
  await tap(page, '#paste', { after: 300 });
  await page.fill('#paste', PASTE_TEXT);
  await beat(page, 1400);              // the box grown to fit is the whole point of this clip
  await tap(page, '#pasteBtn', { after: 300 });
  await beat(page, 900);
  await point(page, '#blocks');
  await beat(page, 400);
  await park(page);
  await beat(page, 900);
  await tap(page, '#saveBtn', { after: 600 });
  await park(page);
  await beat(page, 1100);
});

// ---- 5. the AI model lives in Settings ----
await rec.clip('settings', async (page) => {
  await page.goto(server.base + '/admin/editor/?course_id=' + ALGEBRA_ID);
  await beat(page, 900);
  await tap(page, '#settings summary', { after: 500 });
  await point(page, '#aiModel');
  await beat(page, 400);
  await park(page);
  await beat(page, 900);
  await point(page, '.settings .hint');
  await beat(page, 400);
  await park(page);
  await beat(page, 900);
  await page.keyboard.press('Escape');
  await beat(page, 500);
});

// ---- 6. Fix format ----
await rec.clip('fix-headings', async (page) => {
  await page.goto(server.base + '/admin/editor/?course_id=' + ALGEBRA_ID);
  await beat(page, 900);
  await tap(page, '#structureBtn', { after: 300 });
  await reveal(page, '#aiLog');
  await page.waitForFunction(() => !document.getElementById('structureBtn').disabled, { timeout: 120_000 });
  await beat(page, 800);
  await park(page);
  await beat(page, 1200);
  // "Grading Policy." now starts its own page. Its wording is untouched --
  // retag() only ever rebuilds the tag around it -- so the trailing period
  // that made it look like body text is still sitting right there in a
  // heading, which is the honest proof that nothing was reworded.
  await tap(page, '.pages button[data-page="1"]', { after: 500 });
  await point(page, '#blocks .blk .edit >> nth=0');
  await beat(page, 400);
  await park(page);
  await beat(page, 900);
  await tap(page, '#saveBtn', { after: 600 });
  await park(page);
  await beat(page, 1000);
});

// ---- 7. Suggest initials ----
await rec.clip('suggest-initials', async (page) => {
  await page.goto(server.base + '/admin/editor/?course_id=' + ALGEBRA_ID);
  await beat(page, 900);
  await tap(page, '#suggestBtn', { after: 300 });
  await reveal(page, '#aiLog');
  await page.waitForFunction(() => !document.getElementById('suggestBtn').disabled, { timeout: 120_000 });
  await beat(page, 800);
  await park(page);
  await beat(page, 900);
  // A suggestion is a margin note, not a change -- toggleSigning() is what
  // actually appends a prompt, and only a click on THIS page's own button
  // calls it. Landing on Attendance and accepting shows exactly one of the
  // two suggestions; Grading Policy carries the other and is left for the
  // viewer to notice the same "why" note there.
  //
  // Attendance rather than Grading Policy on purpose: toggleSigning() builds
  // its prompt as "I have read and understand the <heading> policy.", and
  // Grading Policy's heading still ends in the period Fix format left
  // alone -- accepting THAT suggestion reads "...the grading policy. policy."
  // Real behaviour, just not what this clip is trying to teach.
  await tap(page, '.pages button[data-page="2"]', { after: 500 });
  await point(page, '#blocks .why');
  await beat(page, 400);
  await park(page);
  await beat(page, 900);
  await tap(page, '.page-tools button:has-text("Require initials")', { after: 500 });
  await beat(page, 700);
  await park(page);
  await beat(page, 900);
  await tap(page, '#saveBtn', { after: 600 });
  await park(page);
  await beat(page, 1000);
});

// ---- 8. edit text in place, and add a block ----
await rec.clip('edit-blocks', async (page) => {
  await page.goto(server.base + '/admin/editor/?course_id=' + ALGEBRA_ID);
  await beat(page, 900);
  // "waves" sits in the first paragraph pasted under Course Overview -- block
  // index 1, untouched by every edit since (Fix format and Require
  // initials only ever reach index 2 and later).
  await point(page, '#blocks .blk[data-index="1"] .edit');
  const box = await wordBox(page, '#blocks .blk[data-index="1"] .edit', 'waves');
  await page.mouse.move(box.x, box.y, { steps: 15 });
  await beat(page, 300);
  await page.mouse.dblclick(box.x, box.y);
  await beat(page, 350);
  await page.keyboard.type('forces', { delay: 65 });
  await beat(page, 700);
  await park(page);
  await beat(page, 600);
  await tap(page, '[data-add="text"]', { after: 500 });
  await pointAndDblClick(page, '#blocks .blk[data-index="2"] .edit');
  await beat(page, 250);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('A field trip permission form goes home every April.', { delay: 45 });
  await beat(page, 900);
  await park(page);
  await beat(page, 800);
  await tap(page, '#saveBtn', { after: 600 });
  await park(page);
  await beat(page, 1000);
});

// ---- 9. reorder by dragging, delete with the X ----
await rec.clip('reorder-delete', async (page) => {
  await page.goto(server.base + '/admin/editor/?course_id=' + ALGEBRA_ID);
  await beat(page, 900);
  // Course Overview is three blocks now: the heading, the edited paragraph,
  // and the field-trip line added last clip -- indices 0, 1, 2.
  await dragBlockAbove(page, '#blocks .blk[data-index="2"] .edit', '#blocks .blk[data-index="1"] .edit');
  await beat(page, 800);
  await park(page);
  await beat(page, 800);
  const trip = page.locator('#blocks .blk', { hasText: 'field trip' });
  await tap(page, trip.locator('button', { hasText: '✕' }), { after: 500 });
  await beat(page, 700);
  await park(page);
  await beat(page, 800);
  await tap(page, '#saveBtn', { after: 600 });
  await park(page);
  await beat(page, 1000);
});

// ---- 10. save draft, on its own ----
await rec.clip('save-draft', async (page) => {
  await page.goto(server.base + '/admin/editor/?course_id=' + ALGEBRA_ID);
  await beat(page, 900);
  await point(page, '#status');
  await beat(page, 400);
  await park(page);
  await beat(page, 500);
  await tap(page, '#title', { after: 200 });
  await page.keyboard.press('End');
  await page.keyboard.type(' (Fall)', { delay: 65 });
  await beat(page, 450);
  await point(page, '#status');
  await beat(page, 400);
  await park(page);
  await beat(page, 700);
  await tap(page, '#saveBtn', { after: 700 });
  await point(page, '#msg');
  await beat(page, 400);
  await park(page);           // off the notice before the long read beat
  await beat(page, 1000);
});

// ---- 11. the draft nobody has seen yet ----
await rec.clip('biology-preview', async (page) => {
  await page.goto(server.base + '/admin/editor/?course_id=' + BIOLOGY_ID);
  await beat(page, 900);
  await point(page, '#status');
  await beat(page, 400);
  await park(page, { x: 650, y: 760 });
  await beat(page, 500);
  await tap(page, page.locator('.pages button', { hasText: 'Grading Policy' }), { after: 600 });
  await point(page, '#blocks .blk:has-text("Anything up to three days late")');
  await beat(page, 400);
  // park()'s default resting spot sits under the page rail, and Biology's ten
  // pages run the rail down past it -- moved left, clear of every tab, for
  // every long read beat in this clip.
  await park(page, { x: 650, y: 760 });
  await beat(page, 1200);
  await tap(page, page.locator('.pages button', { hasText: 'Tutoring' }), { after: 600 });
  await point(page, '#blocks .blk:has-text("Room 214")');
  await beat(page, 400);
  await park(page, { x: 650, y: 760 });
  await beat(page, 1200);
});

// ---- 12. publish ----
await rec.clip('publish', async (page) => {
  page.on('dialog', (d) => d.accept());   // the diff summary confirm() -- see the step text for what it says
  await page.goto(server.base + '/admin/editor/?course_id=' + BIOLOGY_ID);
  await beat(page, 900);
  await point(page, '#status');
  await beat(page, 400);
  await park(page, { x: 650, y: 760 });
  await beat(page, 500);
  await tap(page, '#publishBtn', { after: 300 });
  await page.waitForSelector('#msg:not([hidden])', { timeout: 15_000 });
  await point(page, '#msg');
  await beat(page, 500);
  // Same reason as biology-preview: the default resting spot sits under
  // Biology's ten-page rail.
  await park(page, { x: 650, y: 760 });
  await beat(page, 1800);
});

await rec.close();
server.stop();

writeSteps('teacher-setup', {
  title: 'Building your syllabus',
  blurb: 'Sign in, open the editor, turn a Word document into a syllabus, and publish it.',
  steps: [
    {
      title: 'Sign in',
      body: 'Go to Teacher sign-in and enter your school email and password. If your school is using the shared admin password instead of individual accounts, leave the email blank.',
      clip: 'teacher-setup-signin.mp4',
    },
    {
      title: 'Find your class on the Classes page',
      body: 'Every class you teach is a row here, with how many students are active, dropped, registered, and holding an access code. Syllabus opens the editor below; Who has signed and Access codes are covered in the rest of this guide.',
      clip: 'teacher-setup-classes.mp4',
    },
    {
      title: 'Open the syllabus editor',
      body: 'A brand new class opens straight to "Start from a document," because there is nothing in the draft yet to show instead. The editor works one page at a time, the same page a parent turns to, with Fix format, Suggest initials, Save draft, and Publish along the top. Nothing here is visible to parents until you publish it.',
      clip: 'teacher-setup-editor-open.mp4',
    },
    {
      title: 'Start from a document',
      body: 'Drop a .docx here, or paste text straight from Word or Google Docs. The box grows to fit whatever you paste. Pasted text is split into blocks automatically: a short line with no punctuation becomes a heading, everything else becomes a paragraph or a list.',
      clip: 'teacher-setup-start-paste.mp4',
    },
    {
      title: 'Choose the AI model in Settings',
      body: 'The gear icon next to Sign out holds one setting: which AI model answers Fix format and Suggest initials. Your choice is remembered on this computer.',
      clip: 'teacher-setup-settings.mp4',
    },
    {
      title: 'Fix format straightens out the structure',
      body: 'A pasted document often has real headings that do not look like headings to a simple rule: a title that ends with a period, or a line that got bolded instead of styled. Fix format asks an AI model to tell headings from body text and retags them. It never rewrites a word; only the tag around a line ever changes.',
      clip: 'teacher-setup-fix-headings.mp4',
    },
    {
      title: 'Suggest initials flags sections worth a signature',
      body: 'This asks the same model which sections a parent should have to initial individually: grading and late work, attendance, safety, academic honesty, anything that costs money. Suggestions show up as a note in the margin; nothing is required until you click Require initials on a page yourself.',
      clip: 'teacher-setup-suggest-initials.mp4',
    },
    {
      title: 'Edit text and add a block',
      body: 'Double-click any line to place a cursor and type. Below the page, "Add to this page" adds a paragraph, a list, a subheading, or an initials box wherever you are reading.',
      clip: 'teacher-setup-edit-blocks.mp4',
    },
    {
      title: 'Reorder or delete a block',
      body: 'Click a block once to pick it up, then drag it, or use the ↑ / ↓ arrows to nudge it a line at a time. The ✕ on the right deletes it. A heading carries its whole page with it when you drag it; a loose line moves on its own.',
      clip: 'teacher-setup-reorder-delete.mp4',
    },
    {
      title: 'Save draft keeps it private',
      body: 'Save draft writes your changes to the server, but nothing changes for parents. They still see whatever was last published. Save often; there is no autosave, and the page warns you before you navigate away with unsaved changes.',
      clip: 'teacher-setup-save-draft.mp4',
    },
    {
      title: 'Review what changed before publishing',
      body: 'This class already has a published syllabus and an open draft with real edits: a softened late-work policy, and a new Tutoring and Extra Help page. Read through a draft before publishing it. Publish shows you a count of what changed, but not the actual wording.',
      clip: 'teacher-setup-biology-preview.mp4',
    },
    {
      title: 'Publish when it is ready',
      body: 'Publishing asks you to confirm how many sections are new or changed, how many are unchanged, and how many changed sections require initials, then makes the new version live immediately. Anyone who already initialed a section that changed now shows as having signed an older version and has to initial it again, even if the change was small.',
      clip: 'teacher-setup-publish.mp4',
    },
  ],
});

console.log('recorded:', rec.made.join(', '));
