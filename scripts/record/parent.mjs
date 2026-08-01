// Records the PARENT / GUARDIAN walkthrough for /how/: sign in with the
// mailed access code, read the syllabus a section at a time, initial each
// one, and confirm the whole thing.
//
// Each step below opens its OWN tab (that is what lib.mjs's clip() does --
// one page, one video). A fresh tab means the syllabus always starts back on
// page 1, but the account's signatures are stored server-side, so a section
// initialed in an earlier clip shows up already stamped the moment a later
// clip loads it. That is also the point being demonstrated: nothing is lost
// between visits. The session cookie is the other thing that carries across
// tabs, which is why only the "sign in" clip needs to type the access code --
// every clip after it opens straight into the syllabus, until the last clip
// deliberately clears cookies to show what signing in again looks like.
//
// Selectors are scoped by each page's aria-label (`section[aria-label="..."]`)
// rather than by position, because every section's sheet stays in the DOM at
// once (book.js hides the others, it does not remove them) -- a selector that
// only matched "the visible one" would still see three hidden inputs and
// Playwright's strict mode would refuse to click any of them.

import { startServer, open, beat, point, tap, type, reveal, park, writeSteps } from './lib.mjs';

const PORT = 8802;
const DB = '.dev-parent.sqlite';

// The seeded Algebra I class (scripts/dev.mjs): one student, two codes. The
// PARENT code is what this role signs in with -- the STUDENT code belongs to
// the student recorder, and typing the wrong one would sign as the wrong
// role entirely, which is the whole point of the two-code design.
const SID = '123456';
const PARENT_CODE = 'DEMO2345';
// Not tied to any real name -- just something short and legible for the clip.
const INITIALS = 'AR';

const STUDENT_CARD = '#view-home .card:has-text("I\'m a student")';
const PARENT_CARD = '#view-home .card:has-text("I\'m a parent or guardian")';
const PARENT_BUTTON = `${PARENT_CARD} a.button`;

async function main() {
  const server = await startServer(PORT, DB);
  const rec = await open(server.base, { prefix: 'parent' });
  const { base } = rec;

  const files = {};
  try {
    // ---- the landing page and the parent card ----
    files.home = await rec.clip('home', async (page) => {
      await page.goto(base + '/');
      await beat(page, 1400);
      await point(page, STUDENT_CARD);      // the other option, for context
      await beat(page, 900);
      await tap(page, PARENT_BUTTON);
      await park(page);               // cursor was mid-card; the new heading is not
      await beat(page, 1400);
    });

    // ---- what the two codes mean ----
    // The step names two things -- an ID and a code -- so the clip fills in the
    // first and stops at the second. An earlier version only hovered the fields
    // and scrolled to the hint, and seven seconds of a still page with a
    // pointer resting on it reads as a video that failed to load rather than
    // one that is making a point. Signing in is step 3's job; this one gets far
    // enough to show what the code field is asking for.
    files.codes = await rec.clip('codes', async (page) => {
      await page.goto(base + '/sign/');
      await beat(page, 1400);
      await type(page, '#sid', SID);
      await beat(page, 700);
      await point(page, '#code');
      await reveal(page, 'label[for="code"] .hint');
      await park(page);
      await beat(page, 2400);
    });

    // ---- signing in ----
    files.signIn = await rec.clip('sign-in', async (page) => {
      await page.goto(base + '/sign/');
      await beat(page, 700);
      await type(page, '#sid', SID);
      await type(page, '#code', PARENT_CODE);
      await tap(page, '#loginBtn');
      await page.waitForSelector('#docTitle', { state: 'visible', timeout: 8000 });
      await park(page);               // the whole view swapped under the cursor
      await beat(page, 1200);
    });

    // ---- turning pages: buttons and arrow keys ----
    files.pages = await rec.clip('pages', async (page) => {
      await page.goto(base + '/sign/');
      await page.waitForSelector('#docTitle', { state: 'visible', timeout: 8000 });
      await beat(page, 700);
      await tap(page, '#nextPage');
      await tap(page, '#nextPage');
      await tap(page, '#prevPage');
      await beat(page, 400);
      await page.keyboard.press('ArrowRight');
      await beat(page, 700);
      await page.keyboard.press('ArrowLeft');
      await park(page);
      await beat(page, 900);
    });

    // ---- initialing one section ----
    files.initial = await rec.clip('initial', async (page) => {
      await page.goto(base + '/sign/');
      await page.waitForSelector('#docTitle', { state: 'visible', timeout: 8000 });
      await tap(page, '#nextPage');   // page 2: "Late work"
      await beat(page, 600);
      await type(page, 'section[aria-label="Late work"] input', INITIALS);
      await tap(page, 'section[aria-label="Late work"] button');
      // The stamp renders in the same spot the button just was -- park first
      // or the cursor sits on top of "Initialed AR on ..." for the whole read.
      await park(page);
      await beat(page, 1200);
    });

    // ---- the rest of the sections ----
    files.finish = await rec.clip('finish', async (page) => {
      await page.goto(base + '/sign/');
      await page.waitForSelector('#docTitle', { state: 'visible', timeout: 8000 });
      await tap(page, '#nextPage', { after: 300 });   // page 2: already stamped
      await beat(page, 600);
      await tap(page, '#nextPage', { after: 300 });   // page 3: "Attendance"
      await type(page, 'section[aria-label="Attendance"] input', INITIALS);
      await tap(page, 'section[aria-label="Attendance"] button');
      await park(page);               // clear of the stamp that just appeared
      await beat(page, 500);
      await tap(page, '#nextPage', { after: 300 });   // page 4: "Academic honesty"
      await type(page, 'section[aria-label="Academic honesty"] input', INITIALS);
      await tap(page, 'section[aria-label="Academic honesty"] button');
      await park(page);
      await beat(page, 600);
    });

    // ---- the final "read in full and agree" block ----
    files.finalAgree = await rec.clip('final-agree', async (page) => {
      await page.goto(base + '/sign/');
      await page.waitForSelector('#docTitle', { state: 'visible', timeout: 8000 });
      await tap(page, '#nextPage', { after: 250 });   // page 2
      await tap(page, '#nextPage', { after: 250 });   // page 3
      await tap(page, '#nextPage', { after: 250 });   // page 4
      await tap(page, '#nextPage', { after: 300 });   // page 5: "Materials", holds the agree block
      await beat(page, 500);
      await type(page, 'section[aria-label="Materials"] input', INITIALS);
      await tap(page, 'section[aria-label="Materials"] button');
      await park(page);
      await beat(page, 500);
      await reveal(page, '#doneBanner');
      await park(page);
      await beat(page, 1200);
    });

    // ---- the done banner and Print a copy ----
    files.bannerPrint = await rec.clip('banner-print', async (page) => {
      await page.goto(base + '/sign/');
      await page.waitForSelector('#docTitle', { state: 'visible', timeout: 8000 });
      await reveal(page, '#doneBanner');
      await beat(page, 2000);
      // Pointed at, not tapped: a real click calls window.print() and there is
      // no one on the other end of a headless browser to dismiss that dialog.
      // Parked again afterward, or the cursor sits on "Print a copy" and hides
      // the word it is meant to be pointing out.
      await point(page, '#doneBanner button');
      await beat(page, 500);
      await park(page);
      await beat(page, 1200);
    });

    // ---- coming back later ----
    files.comeBack = await rec.clip('come-back', async (page) => {
      // Cleared before the first paint, so the clip never flashes the
      // already-signed-in view before "logging out" of it.
      await page.context().clearCookies();
      await page.goto(base + '/sign/');
      await beat(page, 900);
      await type(page, '#sid', SID);
      await type(page, '#code', PARENT_CODE);
      await tap(page, '#loginBtn');
      await page.waitForSelector('#docTitle', { state: 'visible', timeout: 8000 });
      await reveal(page, '#doneBanner');
      await park(page);
      await beat(page, 1400);
    });
  } finally {
    await rec.close();
    server.stop();
  }

  writeSteps('parent', {
    title: 'Reading and initialing as a parent',
    blurb: 'How a parent or guardian signs in with the mailed access code, reads the syllabus a section at a time, initials each one, and confirms the whole thing.',
    steps: [
      {
        title: 'Start on the home page',
        body: 'Open the link your school gave you. Under "I\'m a parent or guardian," tap "Read and sign the syllabus."',
        clip: files.home,
      },
      {
        title: 'Know your access code',
        body: 'You need two things: your student\'s ID number, and an access code -- eight characters, from the email your teacher sent you. That code is what tells the app you\'re the parent and not the student, so use the one from your own email, not one your child gives you.',
        clip: files.codes,
      },
      {
        title: 'Open the syllabus',
        body: 'Type the student ID and your access code exactly as they appear, then tap "Open the syllabus." If it doesn\'t work after a couple of tries, wait a few minutes before trying again, or ask your teacher to resend the code.',
        clip: files.signIn,
      },
      {
        title: 'Turn the pages',
        body: 'The syllabus reads like a notebook, one section per page. Use Back and Next page at the bottom, or the left and right arrow keys on a keyboard. You can move around freely -- nothing is locked.',
        clip: files.pages,
      },
      {
        title: 'Initial each section',
        body: 'Some sections end in a small box asking for your initials. Type them in and tap Initial. The box then shows your initials and the date, so it\'s clear the section is done.',
        clip: files.initial,
      },
      {
        title: 'Work through the rest',
        body: 'Keep turning pages the same way. A section you\'ve already initialed shows a stamp instead of a blank box, so you always know what\'s left. You don\'t have to finish in one sitting.',
        clip: files.finish,
      },
      {
        title: 'Agree to the whole syllabus',
        body: 'The last page asks you to confirm you\'ve read the syllabus in full, not just one section. It works the same as the others -- type your initials and tap Initial.',
        clip: files.finalAgree,
      },
      {
        title: 'You\'re done',
        body: 'Once every section is initialed, a banner at the top says so. Tap Print a copy any time you want a paper copy for your records.',
        clip: files.bannerPrint,
      },
      {
        title: 'Coming back later',
        body: 'Didn\'t finish, or want to check what you signed? Go back to the same link and sign in again with the same student ID and access code. The syllabus opens back up already showing everything you\'ve initialed -- nothing is lost between visits.',
        clip: files.comeBack,
      },
    ],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
