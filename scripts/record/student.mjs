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
const PARENT_EMAIL = 'guardian@example.com';
// Typed into the school type-ahead, which resolves a name to the id the form
// submits. Must match a seeded school EXACTLY or nothing resolves and the form
// refuses to submit -- the dev seed's courses are unowned, so they resolve to
// the placeholder school, which is what this name is.
const SCHOOL = '(unassigned)';
// What registration hands back and what sign-in then asks for. Derived from
// (student id, school), so it is predictable enough to name here -- see
// api/register.js. There is no school-email field on the form any more: the
// username is generated rather than chosen.

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
  await type(page, '#reg-school-name', SCHOOL);
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
  await type(page, '#reg-school-name', SCHOOL);
  // Parent/guardian email left blank here: the roster already has one on file
  // for this student, which is the realistic case -- the field's own hint
  // text says to fill it in only when the syllabus should go somewhere else.
  await tap(page, '#registerBtn', { after: 900 });
  // point()'s scrollIntoViewIfNeeded already waits out the fetch round trip,
  // so no separate wait is needed for the reveal to be on screen.
  //
  // BOTH halves are the point of this frame now, not just the code. Sign-in
  // takes a username and an access code, so a student who writes down only one
  // of them cannot get back in -- and the username is shown here and in no
  // other place a student ever sees.
  await point(page, '#doneUsername');
  await beat(page, 900);
  await point(page, '#doneCodeValue');
  await beat(page, 400);
  // The cursor would otherwise sit directly on the code -- parked off it so
  // the long read-beat below shows every character, unobstructed. This is
  // the most important frame on the whole student path.
  await park(page);
  await beat(page, 2600);          // shown exactly once -- give it room to sit
});

// ---- 4. what happens if they come back to the WRONG page ----
//
// This clip used to show re-registering as the way to resume, because the form
// accepted a second submission and carried the student through to their
// syllabus. It does not any more: registration is first-time-only, and coming
// back a second time is answered with a card that says so and points at
// /sign/. Recording the old behaviour would be recording a path that no longer
// exists, so the clip now shows the signpost and follows it.
await rec.clip('register-returning', async (page) => {
  await page.goto(server.base + '/register/');
  await beat(page, 700);
  await type(page, '#reg-sid', SID);
  await type(page, '#reg-last', LAST);
  await type(page, '#reg-school-name', SCHOOL);
  await tap(page, '#registerBtn', { after: 900 });
  await page.waitForSelector('#registerExists', { state: 'visible', timeout: 8000 });
  await park(page);
  await beat(page, 1600);          // long enough to read why nothing went wrong
  await tap(page, '#registerExists a.button', { after: 900 });
  await park(page);
  await beat(page, 1400);
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
      body: 'Your student ID number and your last name, exactly as they appear on your school ID -- and your school from the list, if the site asks for one. That is the whole form. If the syllabus should go to an address other than the one your school already has for your family, put it in the optional "Parent or guardian\'s email" field underneath. None of this is what you sign in with later; it is only how we find you on your teacher\'s roster.',
      clip: 'student-register-fill.mp4',
    },
    {
      title: 'Write down your username and access code',
      body: 'After you submit the form, the screen shows your username and your access code. Write down both -- they are the only two things you need to get back in, and the code is shown this once and never again. Your username looks like an email address but is not one; nothing is sent to it.',
      clip: 'student-register-code.mp4',
    },
    {
      title: 'Coming back later',
      body: 'Don\'t go back to the sign-up form -- it will only tell you that you already have an account. Use "Read & initial" instead and sign in with the two things you wrote down: your username and your access code. Nothing else is asked for. Everything you already initialed is still there.',
      clip: 'student-register-returning.mp4',
    },
    {
      title: 'If you lost your username or access code',
      body: 'Neither can be emailed to you directly. School and district mail systems block outside senders, so nothing we send would reach your school address. Follow "Don\'t have a code, or lost it?" on the sign-in page instead and enter a parent or guardian\'s personal email -- your username and code both go to that inbox alongside theirs, and they can read yours back to you. Your teacher can also look both up.',
    },
  ],
});

console.log('recorded:', rec.made.join(', '));
