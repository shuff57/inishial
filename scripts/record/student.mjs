// Records the student half of /how/: setting up an account on the first day
// of class and walking away holding an access code. See lib.mjs for the
// shared harness (server boot, cursor, pacing) and
// docs/plans/2026-07-28-how-to-use-page.md for how the four roles fit
// together.
//
//   node scripts/record/student.mjs
//
// Port 8801 and .dev-student.sqlite are this recorder's own. Three other
// recorders run at the same time against their own ports and databases, so
// nothing here may touch 8788 or .dev.sqlite.

import { startServer, open, tap, type, point, beat, park, writeSteps } from './lib.mjs';

const PORT = 8801;
const DB = '.dev-student.sqlite';

// scripts/demo.mjs registers the Biology demo class's first 15 active
// students and deliberately leaves the rest for a page like this one to
// register. 100016 P Student is the first of those -- confirmed against the
// dev server's own startup banner, not assumed. The roster is synthetic on
// purpose (see the comment above STUDENTS in demo.mjs): this page is public
// and long-lived, so nothing recorded on it may read like a real student or
// a real school domain.
const SID = '100016';
const LAST = 'Student';
const SCHOOL_EMAIL = 'student100016@student.example.com';
const PARENT_EMAIL = 'guardian@example.com';

const server = await startServer(PORT, DB);
console.log(server.log());

const rec = await open(server.base, { prefix: 'student' });

// ---- 1. the home page, and the card that starts everything ----
await rec.clip('home', async (page) => {
  await page.goto(server.base + '/');
  await beat(page, 1300);
  // Scoped to the student card specifically -- the home page's nav and its
  // card both say "Set up my account", and a bare href selector would match
  // both under Playwright's strict mode.
  const card = page.locator('#view-home .card.plain', { hasText: "I'm a student" });
  await point(page, card.locator('h2'));
  await beat(page, 500);
  await tap(page, card.locator('a.button'), { after: 400 });
  // The cursor is a fixed overlay -- it doesn't move on its own when the SPA
  // swaps home for the register view, so it would otherwise sit wherever the
  // button happened to be, now over whatever landed under that same pixel.
  await park(page);
  await beat(page, 1300);
});

// ---- 2. the fields the form asks for ----
await rec.clip('register-fill', async (page) => {
  await page.goto(server.base + '/register/');
  await beat(page, 900);
  await type(page, '#reg-sid', SID);
  await type(page, '#reg-last', LAST);
  await type(page, '#reg-username', SCHOOL_EMAIL);
  await type(page, '#reg-email', PARENT_EMAIL);
  // Off the just-typed text before the clip sits on it -- otherwise the
  // cursor parks mid-word over whatever was last typed.
  await park(page);
  await beat(page, 900);
  // Deliberately not submitted -- this student needs to still be unregistered
  // when the next clip opens, because that one does the real submit.
});

// ---- 3. submitting, and the one screen that matters most ----
await rec.clip('register-code', async (page) => {
  await page.goto(server.base + '/register/');
  await type(page, '#reg-sid', SID);
  await type(page, '#reg-last', LAST);
  await type(page, '#reg-username', SCHOOL_EMAIL);
  // Parent/guardian email left blank here: the roster already has one on file
  // for this student, which is the realistic case -- the field's own hint
  // text says to fill it in only when the syllabus should go somewhere else.
  await tap(page, '#registerBtn', { after: 900 });
  // point()'s scrollIntoViewIfNeeded already waits out the fetch round trip,
  // so no separate wait is needed for the reveal to be on screen.
  await point(page, '#doneCodeValue');
  await beat(page, 400);
  // The cursor would otherwise sit directly on the code -- parked off it so
  // the long read-beat below shows every character, unobstructed. This is
  // the most important frame on the whole student path.
  await park(page);
  await beat(page, 2200);          // shown exactly once -- give it room to sit
});

// ---- 4. coming back later, which is also how first-timers get to /sign/ ----
await rec.clip('register-returning', async (page) => {
  await page.goto(server.base + '/register/');
  await beat(page, 700);
  await type(page, '#reg-sid', SID);
  await type(page, '#reg-last', LAST);
  // Username and parent email stay blank on purpose: those two are what tell
  // the server this is a return visit rather than a first registration.
  await tap(page, '#registerBtn', { after: 900 });
  await beat(page, 1000);
  await tap(page, '#doneNext', { after: 900 });
  await park(page);
  await beat(page, 1200);
});

await rec.close();
server.stop();

writeSteps('student', {
  title: 'Setting up as a student',
  blurb: 'Everything a student does on the first day of class: set up an account and walk away holding an access code.',
  steps: [
    {
      title: 'Find your card on the home page',
      body: 'Go to the site and pick the card that says "I\'m a student." It opens the sign-up form.',
      clip: 'student-home.mp4',
    },
    {
      title: 'Fill in your information',
      body: 'Enter your student ID number and last name exactly as they appear on your school ID, then your school email. The parent or guardian email is optional — only fill it in if the syllabus should go to an address different from the one your school already has on file.',
      clip: 'student-register-fill.mp4',
    },
    {
      title: 'Write down your access code',
      body: 'After you submit the form, your own access code is shown once, right there on the screen. Write it down before you go on. This is the only time you will see it, and you need it to come back and finish later.',
      clip: 'student-register-code.mp4',
    },
    {
      title: 'Coming back later',
      body: 'Already set up your account? Go back to the same form and enter just your student ID and last name, leaving the rest blank. That takes you straight to your syllabus instead of asking you to register again.',
      clip: 'student-register-returning.mp4',
    },
  ],
});

console.log('recorded:', rec.made.join(', '));
