// A fake class, complete enough to see the whole app working.
//
// The point is to have something to PUBLISH and something to look at after
// publishing. So the demo ships two versions:
//
//   version 1, published, with signatures spread across every state the
//              progress page can report -- complete, partly signed, not
//              started, registered-but-no-code, and never registered
//   version 2, an open draft that differs from it, so Publish… has a real
//              diff to show and a real consequence to warn about
//
// Publishing version 2 is worth doing deliberately: every signature above is
// against version 1, so the roster flips to "Signed an older version" the
// moment you do. That is the app's actual behaviour today, and seeing it on
// fake students is much better than discovering it on real ones.
//
// Idempotent and additive. It adds a course if that course is not already
// there and does nothing otherwise, so a real imported syllabus in the same
// database is never touched. DEMO_RESET=1 rebuilds it from scratch.
//
// The one import is attestationHash. seedDemo() below takes its crypto by
// injection so the fixture does not reach into the endpoints it exists to let
// you exercise -- but this is the shared rule in _lib, not a handler, and it
// has to be the SAME rule: a signature is matched to a section by this hash, so
// a fixture that computed it differently would seed a demo class whose every
// signature reads as missing.
import { attestationHash } from '../functions/_lib/syllabus.js';

const COURSE = 'Biology 1 (demo)';
const PERIOD = '6';

// Predictable so they can be typed from the banner rather than looked up.
//
// Two per student, because there are two now: the parent was mailed one and the
// student was shown the other when they registered. Which one you sign in with
// is what decides whose signature you can write, so having both to hand is the
// point of the demo class.
export const demoCode = (extId) => 'DEMO' + String(extId).slice(-4);
export const demoStudentCode = (extId) => 'STUD' + String(extId).slice(-4);

// Fake students, and visibly so.
//
// This roster is what the recordings on /how/ film -- a public, long-lived
// page -- so nothing here may read like a person. A plausible name beside a
// plausible ID beside a plausible school address invites the question of
// whether it is a real student, and that is a much worse thing to publish than
// an obviously synthetic roster. Letters for given names, "Student" for family
// names, sequential IDs, and example.com, which RFC 2606 reserves for this.
//
// The SHAPES are still deliberately varied, because every one of them has its
// own path through the app and its own way of going wrong:
//   - a missing parent email  -> the export's "missing" column, /register's fallback
//   - a dropped student       -> must stay in the roster, never be deleted
//   - names with punctuation  -> CSV quoting, and the formula-injection guard
// So the apostrophe, the hyphen and the diacritic all survive the rename. They
// are load-bearing, not flavour.
const STUDENTS = [
  ['100001', 'A', 'Student', 'parent.a@example.com'],
  ['100002', 'B', "O'Student", 'parent.b@example.com'],
  ['100003', 'C', 'Stüdent', 'parent.c@example.com'],
  ['100004', 'D', 'Student-Case', 'parent.d@example.com'],
  ['100005', 'E', 'Student', 'parent.e@example.com'],
  ['100006', 'F', 'Student', null],
  ['100007', 'G', 'Student', 'parent.g@example.com'],
  ['100008', 'H', 'Student', 'parent.h@example.com'],
  ['100009', 'I', 'Student', 'parent.i@example.com'],
  ['100010', 'J', 'Student', null],
  ['100011', 'K', 'Student', 'parent.k@example.com'],
  ['100012', 'L', 'Student', 'parent.l@example.com'],
  ['100013', 'M', 'Student', 'parent.m@example.com'],
  ['100014', 'N', 'Student', 'parent.n@example.com'],
  ['100015', 'O', 'Student', 'parent.o@example.com'],
  ['100016', 'P', 'Student', 'parent.p@example.com'],
  ['100017', 'Q', 'Student', null],
  ['100018', 'R', 'Student', 'parent.r@example.com'],
  // Dropped: still on the roster, marked, never deleted. Re-uploading a file
  // that includes them again brings them back with their account intact.
  ['100019', 'S', 'Student', 'parent.s@example.com'],
  ['100020', 'T', 'Student', 'parent.t@example.com'],
];
const DROPPED = new Set(['100019', '100020']);

const h2 = (t) => ['heading', `<h2>${t}</h2>`, 0, 2];
const h3 = (t) => ['heading', `<h3>${t}</h3>`, 0, 3];
const p = (t) => ['text', `<p>${t}</p>`, 0, 2];
const ul = (items) => ['list', `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`, 0, 2];
const initial = (t) => ['initial', t, 1, 2];
const agree = (t) => ['agree', t, 1, 2];

/**
 * The published syllabus. Written to exercise the app rather than to be a good
 * biology syllabus: subheadings inside one policy (so it stays ONE thing to
 * initial), a table, lists, sections of very different lengths, and prompts
 * that always sit at the end of what they attest to.
 */
const VERSION_1 = [
  // Not a person, for the same reason the roster is not: this heading is the
  // first thing on screen in the recordings on /how/, and a plausible teacher
  // name reads as a real one.
  h2('T. Teacher — Biology 1, Period 6'),
  p('Room 214 · teacher@example.edu · Prep periods 2 and 4'),
  p('The fastest way to reach me is email. I answer during the school day and usually within one school day — not evenings or weekends.'),

  h2('Course Description'),
  p('Biology 1 is a laboratory science covering cells, genetics, evolution, ecology, and human body systems. Roughly a third of class time is spent on hands-on lab work, and lab days cannot be made up at home.'),

  h2('Materials'),
  p('Bring these every day. Anything on this list that costs money can be borrowed from the classroom set — ask me privately rather than going without.'),
  ul(['A charged Chromebook', 'A composition notebook kept only for this class',
    'Pen or pencil, and a coloured pencil set for diagrams', 'Closed-toe shoes on lab days']),
  initial('I have read the materials list and understand what my student needs to bring.'),

  h2('Grading Policy'),
  p('Grades are updated weekly and are always visible in the portal. If a grade looks wrong, tell me — it usually is a missing entry rather than a missing assignment.'),
  h3('Daily work'),
  p('Short assignments completed in class. Graded for completion and effort, not correctness. These exist so that mistakes are cheap.'),
  h3('Labs'),
  p('Graded on the write-up rather than on getting the expected result. A careful lab that failed earns full marks; a tidy lab with invented data does not.'),
  h3('Exams'),
  p('One per unit, announced at least a week ahead. The lowest exam score of the semester is dropped automatically.'),
  h3('Late work'),
  p('Late work loses 10% per school day to a floor of 50%, and is not accepted more than two weeks late without a documented absence.'),
  ['text', `<table><tr><th>Category</th><th>Weight</th></tr>`
    + `<tr><td>Daily work</td><td>20%</td></tr>`
    + `<tr><td>Labs</td><td>30%</td></tr>`
    + `<tr><td>Exams</td><td>40%</td></tr>`
    + `<tr><td>Final project</td><td>10%</td></tr></table>`, 0, 2],
  initial('I have read and understand the grading policy, including how late work is scored.'),

  h2('Attendance and Participation'),
  p('Attendance is taken daily. Three unexcused tardies count as one absence. Students are responsible for work missed during any absence, and the week\'s assignments are always posted in the portal.'),
  p('Lab days are the exception worth knowing about: a missed lab cannot be repeated at home, so an absent student completes an alternative written assignment instead.'),
  initial('I have read and understand the attendance policy, including how missed labs are handled.'),

  h2('Lab Safety'),
  p('Every student passes a safety check before touching equipment. A student who cannot follow these rules is removed from the lab for that day and completes the written alternative — this is a safety decision, not a punishment.'),
  ul(['Goggles on before the lab begins, off after clean-up',
    'Closed-toe shoes, and long hair tied back',
    'No food or drink at any bench, at any time',
    'Nothing goes down the sink unless I say so',
    'Report every spill, cut and burn immediately, however small']),
  initial('I have read the lab safety rules and understand my student may be removed from a lab for breaking them.'),

  h2('Academic Honesty and Use of AI'),
  p('Work submitted must be the student\'s own. Copying, sharing answers, and unattributed AI use are all handled as academic dishonesty and reported to administration.'),
  h3('Where AI is allowed'),
  p('AI tools may be used to check understanding, generate practice questions, and explain a concept a different way. Say so when you have used one — a note at the end of the assignment is enough.'),
  h3('Where it is not'),
  p('Lab write-ups, exam responses, and the final project must be written without AI assistance. These are the pieces that show me what a student can actually do, and a polished paragraph tells me nothing.'),
  initial('I have read and understand the academic honesty and AI policy.'),

  h2('Dissection and Field Work'),
  p('The anatomy unit in spring includes a dissection. Students who opt out complete an equivalent digital dissection with no grade penalty and no need to explain why — tell me by email before the unit begins.'),
  p('There is one field trip, to the wetland preserve in April. It is free, and a separate district permission form goes home in March.'),

  h2('Agreement'),
  agree('I have read this syllabus in full and agree to its terms.'),
];

/**
 * The open draft: version 1 plus a real change, so Publish… has something to
 * report and the diff is worth reading rather than empty.
 */
const VERSION_2 = (() => {
  const next = VERSION_1.map((b) => [...b]);
  // A softened late-work rule -- the kind of edit that actually happens in
  // week three, and exactly the kind a parent may have already initialled the
  // old wording of.
  const late = next.findIndex((b) => String(b[1]).includes('loses 10% per school day'));
  next[late][1] = '<p>Late work loses 10% per school day to a floor of 50%. Anything up to three days late can be turned in for full credit once per quarter — tell me you are using it.</p>';
  // And a whole new section, so the diff shows an addition as well as a change.
  const agreeAt = next.findIndex((b) => b[0] === 'heading' && String(b[1]).includes('Agreement'));
  next.splice(agreeAt, 0,
    h2('Tutoring and Extra Help'),
    p('I am in Room 214 every Tuesday and Thursday until 4:15. No appointment, no sign-up — come in and work, and ask when you get stuck.'),
    p('Students who are failing at the midpoint of a quarter will be asked to attend once a week until the grade recovers. You will hear from me by email before that happens.'),
    initial('I know when tutoring is available and how my student may be asked to attend.'),
  );
  return next;
})();

/**
 * Add the demo class if it is not already there.
 *
 * Everything is written through raw SQL rather than the API handlers on
 * purpose: this is a fixture, and it should not depend on the endpoints it
 * exists to let you exercise.
 */
export async function seedDemo(db, { hashCode, seal = async () => null, reset = false,
  now = Math.floor(Date.now() / 1000) } = {}) {
  const existing = db.prepare('SELECT id FROM courses WHERE name = ?').get(COURSE)?.id;
  if (existing && !reset) return { added: false, courseId: existing, course: COURSE };
  // ON DELETE CASCADE carries the roster, accounts, syllabus and signatures.
  if (existing) db.prepare('DELETE FROM courses WHERE id = ?').run(existing);

  const courseId = Number(db.prepare('INSERT INTO courses (name, created_at, owner_id) VALUES (?, ?, NULL)')
    .run(COURSE, now).lastInsertRowid);

  const rosterIds = new Map();
  for (const [extId, first, last, email] of STUDENTS) {
    const dropped = DROPPED.has(extId);
    rosterIds.set(extId, Number(db.prepare(
      `INSERT INTO roster (course_id, period, student_ext_id, first, last, parent_email, status, dropped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(courseId, PERIOD, extId, first, last, email, dropped ? 'dropped' : 'active',
      dropped ? now : null).lastInsertRowid));
  }

  // Who has an account, and who has a code. Three states, because the progress
  // page distinguishes them and each needs a different action from the teacher.
  const active = STUDENTS.filter(([id]) => !DROPPED.has(id));
  const registered = active.slice(0, 15);          // have accounts
  const withCode = registered.slice(0, 12);        // ...and codes issued
  const accountIds = new Map();

  for (const [extId, first, last] of registered) {
    const hasCode = withCode.some(([id]) => id === extId);
    // The school address, which is what registration asks for now.
    // Keyed off the ID, not the name. Names collide once they are generic --
    // "A Student" exists in both seeded classes -- and accounts.username is
    // UNIQUE, so a name-derived address made the second class fail to seed.
    const username = `student${extId}@student.example.com`;
    accountIds.set(extId, Number(db.prepare(
      `INSERT INTO accounts (roster_id, username, code_hash, code_issued_at, parent_email, created_at,
                             student_code_hash, student_code_issued_at, code_enc, student_code_enc)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    ).run(rosterIds.get(extId), username,
      hasCode ? await hashCode(demoCode(extId)) : null,
      hasCode ? now : null, now,
      // Everyone who registered has their own code -- registration is what
      // mints it, so "has an account" and "has a student code" are the same
      // state. The parent's is separate and is the one the teacher issues.
      await hashCode(demoStudentCode(extId)), now,
      // Sealed as well as hashed, so /admin/codes/ can show the demo class the
      // way it shows a real one.
      hasCode ? await seal(demoCode(extId)) : null,
      await seal(demoStudentCode(extId))).lastInsertRowid));
  }

  const syllabusId = Number(db.prepare('INSERT INTO syllabi (course_id, title, slug) VALUES (?, ?, ?)')
    .run(courseId, 'Biology 1 — Course Syllabus (demo)', 'biology-1-demo').lastInsertRowid);

  const writeVersion = (num, blocks, publishedAt) => {
    const versionId = Number(db.prepare('INSERT INTO versions (syllabus_id, num, published_at) VALUES (?, ?, ?)')
      .run(syllabusId, num, publishedAt).lastInsertRowid);
    const ids = blocks.map(([type, html, needs, level], i) => Number(db.prepare(
      'INSERT INTO blocks (version_id, ord, type, html, needs_initials, level) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(versionId, i, type, html, needs, level).lastInsertRowid));
    return { versionId, blockIds: ids, blocks };
  };

  const v1 = writeVersion(1, VERSION_1, now - 60 * 60 * 24 * 14);
  writeVersion(2, VERSION_2, null);                 // the open draft

  // Signatures against version 1, spread so the progress page shows every
  // state at once rather than one row repeated fifteen times.
  //
  // The hash is computed the same way /api/sign/initial computes it, and that
  // is not tidiness. A signature is matched to a section by this hash, so that
  // unchanged sections keep their initials across a republish -- seeded rows
  // carrying a placeholder string ('demo-not-a-real-hash', which is what these
  // used to hold) match no section at all, and the demo class opens with every
  // signature apparently missing.
  const shaped = v1.blocks.map(([type, html, needs]) => ({ type, html, needs_initials: needs }));
  const promptIndexes = v1.blocks.map((b, i) => (b[2] === 1 ? i : -1)).filter((i) => i >= 0);
  const hashOf = new Map();
  for (const i of promptIndexes) hashOf.set(v1.blockIds[i], await attestationHash(shaped, i));

  const prompts = v1.blockIds.filter((_, i) => v1.blocks[i][2] === 1);
  const initials = (first, last) => (first[0] + last[0]).toUpperCase();
  let signed = 0;

  for (const [i, [extId, first, last]] of withCode.entries()) {
    // 0-3 complete, 4-8 partway through, 9-11 not started.
    const howMany = i < 4 ? prompts.length : i < 9 ? 1 + (i % 3) : 0;
    for (const blockId of prompts.slice(0, howMany)) {
      db.prepare(
        `INSERT INTO signatures (account_id, version_id, block_id, role, initials, block_hash, signed_at, ip, user_agent)
         VALUES (?, ?, ?, 'parent', ?, ?, ?, '198.51.100.7', 'demo seed')`,
      ).run(accountIds.get(extId), v1.versionId, blockId, initials(first, last),
        hashOf.get(blockId), now - 60 * 60 * 24 * (10 - (i % 7)));
      signed++;
    }
  }

  return {
    added: true, courseId, course: COURSE, syllabusId,
    students: STUDENTS.length, active: active.length, dropped: DROPPED.size,
    registered: registered.length, codes: withCode.length, signatures: signed,
    sample: withCode.slice(0, 2).map(([extId, first, last]) =>
      ({ extId, who: `${first} ${last}`, code: demoCode(extId), studentCode: demoStudentCode(extId) })),
  };
}
