// Parent self-signup: POST /api/sign/request-code mails the parent's access
// code to an address they supply, so the teacher no longer has to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, seedStudent, seedSchoolRoster, seedAccount, seedSyllabus, jsonRequest, cookieFrom } from './helpers.mjs';
import { onRequestPost as requestCode } from '../functions/api/sign/request-code.js';
import { onRequestPost as register } from '../functions/api/register.js';
import { onRequestPost as login } from '../functions/api/sign/login.js';

// In-memory mail capture: stand in for Stalwart by intercepting fetch. mail.js
// bootstraps against the JMAP session document, then posts Email/set +
// EmailSubmission/set to the API URL; this mock answers both and records what
// the send actually contained.
const MAIL_HOST = 'https://smtp.test:8443';
const MAIL_FROM = 'no-reply@mail.huffpalmer.fyi';
const MAIL_REPLY_TO = 'support@mail.huffpalmer.fyi';

function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

function mailEnv(extra = {}) {
  const sent = [];
  const env = freshEnv({
    MAIL_FROM,
    MAIL_REPLY_TO,
    STALWART_URL: MAIL_HOST,
    STALWART_API_KEY: 'test-api-key',
    CODE_SECRET: 'test-code-secret-at-least-16-chars',
    ...extra,
  });

  // Stash the real fetch so the test can restore it. The mock covers the mail
  // host only; everything else falls through to the real one.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u === `${MAIL_HOST}/.well-known/jmap`) {
      // Advertise an apiUrl WITHOUT the port, exactly as a Stalwart that does
      // not know it is published on :8443 does. The client must ignore this
      // origin and keep using STALWART_URL.
      return json({
        apiUrl: 'https://smtp.test/jmap/',
        primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a1' },
      });
    }
    if (u === 'https://smtp.test/jmap/') {
      throw new Error('client followed the advertised origin instead of STALWART_URL');
    }
    if (u.startsWith(`${MAIL_HOST}/jmap`)) {
      const calls = JSON.parse(opts.body).methodCalls;
      const answer = (name, args, id) => {
        if (name === 'Identity/get') {
          // Two identities, so the "pick the one that owns MAIL_FROM" branch is
          // exercised rather than passing by luck of ordering.
          return ['Identity/get', { list: [
            { id: 'id-other', email: 'someone-else@mail.huffpalmer.fyi' },
            { id: 'id-noreply', email: MAIL_FROM },
          ] }, id];
        }
        if (name === 'Mailbox/get') {
          return ['Mailbox/get', { list: [{ id: 'mb-drafts', role: 'drafts' }] }, id];
        }
        if (name === 'Email/set') {
          const e = args.create.e1;
          sent.push({
            to: e.to.map((a) => a.email).join(', '),
            from: e.from.map((a) => a.email).join(', '),
            replyTo: e.replyTo.map((a) => a.email).join(', '),
            subject: e.subject,
            body: Object.values(e.bodyValues).map((v) => v.value).join('\n'),
          });
          return ['Email/set', { created: { e1: { id: 'em-' + sent.length } } }, id];
        }
        if (name === 'EmailSubmission/set') {
          const s = args.create.s1;
          if (sent.length) Object.assign(sent[sent.length - 1], {
            identityId: s.identityId,
            mailFrom: s.envelope.mailFrom.email,
            rcptTo: s.envelope.rcptTo.map((a) => a.email).join(', '),
          });
          return ['EmailSubmission/set', { created: { s1: { id: 'sub-' + sent.length } } }, id];
        }
        return ['error', { type: 'unknownMethod' }, id];
      };
      return json({ methodResponses: calls.map(([n, a, id]) => answer(n, a, id)) });
    }
    return realFetch(url, opts);
  };

  return { env, sent, restore: () => { globalThis.fetch = realFetch; } };
}

const post = (env, body, headers) =>
  requestCode({ request: jsonRequest('https://x/api/sign/request-code', body, headers), env });

test('mints both codes at registration, so the parent code is ready to mail', async () => {
  const { env } = mailEnv();
  seedStudent(env._raw, { parentEmail: 'family@example.com' });

  await register({ request: jsonRequest('https://x/api/register', {
    student_ext_id: '904511', last: 'Alvarez', username: 'malvarez@chicousd.org',
  }), env });

  const row = env._raw.prepare('SELECT code_hash, code_enc, student_code_hash FROM student_identities').get();
  assert.ok(row.code_hash, 'the parent code is hashed at registration');
  assert.ok(row.code_enc, 'and sealed so the self-signup page can mail it');
  assert.ok(row.student_code_hash, 'the student code is still there');
});

test('a valid request emails the parent code and returns a masked preview', async () => {
  const { env, sent, restore } = mailEnv();
  try {
    seedStudent(env._raw, { parentEmail: 'family@example.com' });
    // Registration mints BOTH codes and seals the parent code in the vault, so
    // the self-signup page can read it back here. This is the normal path.
    await register({ request: jsonRequest('https://x/api/register', {
      student_ext_id: '904511', last: 'Alvarez', username: 'malvarez@chicousd.org',
    }), env });

    const res = await post(env, { student_ext_id: '904511', email: 'family@example.com' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.email_preview, 'f•••@example.com');

    // The mail was sent with the parent code in the body. `sent[0].body` is
    // the text and HTML parts joined; the code appears in both.
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'family@example.com');
    assert.equal(sent[0].from, MAIL_FROM);
    assert.equal(sent[0].replyTo, MAIL_REPLY_TO,
      'replies go to a mailbox a human reads, not to the no-reply sender');
    assert.match(sent[0].body, /\b[2-9A-HJ-NP-Z]{8}\b/);

    // The submission must use the identity that owns MAIL_FROM, and an envelope
    // sender on the mail subdomain -- SPF and DKIM are published there, so an
    // apex MailFrom would fail alignment and land in spam.
    assert.equal(sent[0].identityId, 'id-noreply');
    assert.equal(sent[0].mailFrom, MAIL_FROM);
    assert.equal(sent[0].rcptTo, 'family@example.com');
  } finally { restore(); }
});

test('the code that was mailed opens a parent session at sign-in', async () => {
  const { env, sent, restore } = mailEnv();
  try {
    seedStudent(env._raw, { parentEmail: 'family@example.com' });
    await register({ request: jsonRequest('https://x/api/register', {
      student_ext_id: '904511', last: 'Alvarez', username: 'malvarez@chicousd.org',
    }), env });

    const res = await post(env, { student_ext_id: '904511', email: 'family@example.com' });
    assert.equal(res.status, 200);

    // Pull the code out of the captured mail body and sign in with it.
    const code = sent[0].body.match(/\b([2-9A-HJ-NP-Z]{8})\b/)[1];
    const loginRes = await login({
      request: jsonRequest('https://x/api/sign/login', { student_ext_id: '904511', email: 'family@example.com', code }),
      env,
    });
    assert.equal(loginRes.status, 200);
    assert.equal((await loginRes.json()).role, 'parent');
  } finally { restore(); }
});

test('a wrong student ID gives the same no-oracle message as login', async () => {
  const { env, restore } = mailEnv();
  try {
    const res = await post(env, { student_ext_id: '0000000', email: 'x@example.com' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /doesn't match our class roster/);
  } finally { restore(); }
});

test('no account yet tells the parent the student must register first', async () => {
  const { env, restore } = mailEnv();
  try {
    seedStudent(env._raw, { parentEmail: 'family@example.com' });
    // No seedAccount: the student has not registered.

    const res = await post(env, { student_ext_id: '904511', email: 'family@example.com' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /student needs to set up/);
  } finally { restore(); }
});

test('a parent-supplied email that differs from the roster is stored as override', async () => {
  const { env, sent, restore } = mailEnv();
  try {
    seedStudent(env._raw, { parentEmail: 'roster@example.com' });
    await seedAccount(env._raw, (await env.DB.prepare('SELECT id FROM roster').first()).id, { code: 'ABCD2345', parentEmail: null });

    const res = await post(env, { student_ext_id: '904511', email: 'new@example.com' });
    assert.equal(res.status, 200);

    const stored = env._raw.prepare('SELECT si.parent_email FROM student_identities si JOIN accounts a ON a.identity_id = si.id').get().parent_email;
    assert.equal(stored, 'new@example.com', 'the override is written so the parent can fix a roster typo');
    assert.equal(sent[0].to, 'new@example.com', 'the mail went to the parent-supplied address');
  } finally { restore(); }
});

test('a request whose email matches the roster does NOT write an override', async () => {
  const { env, restore } = mailEnv();
  try {
    seedStudent(env._raw, { parentEmail: 'family@example.com' });
    await seedAccount(env._raw, (await env.DB.prepare('SELECT id FROM roster').first()).id, { code: 'ABCD2345', parentEmail: null });

    await post(env, { student_ext_id: '904511', email: 'family@example.com' });
    const stored = env._raw.prepare('SELECT si.parent_email FROM student_identities si JOIN accounts a ON a.identity_id = si.id').get().parent_email;
    assert.equal(stored, null, 'no override when the roster is already right');
  } finally { restore(); }
});

test('an invalid email is rejected before any mail is sent', async () => {
  const { env, sent, restore } = mailEnv();
  try {
    seedStudent(env._raw, { parentEmail: 'family@example.com' });
    await seedAccount(env._raw, (await env.DB.prepare('SELECT id FROM roster').first()).id, { code: 'ABCD2345', parentEmail: null });

    const res = await post(env, { student_ext_id: '904511', email: 'not-an-email' });
    assert.equal(res.status, 400);
    assert.equal(sent.length, 0);
  } finally { restore(); }
});

test('rate-limits after three attempts per student', async () => {
  const { env, sent, restore } = mailEnv();
  try {
    seedStudent(env._raw, { parentEmail: 'family@example.com' });
    await seedAccount(env._raw, (await env.DB.prepare('SELECT id FROM roster').first()).id, { code: 'ABCD2345', parentEmail: null });

    let refused = false;
    for (let i = 0; i < 5; i++) {
      const res = await post(env, { student_ext_id: '904511', email: 'family@example.com' });
      if (res.status === 429) { refused = true; break; }
    }
    assert.ok(refused, 'repeated requests must hit the per-student limit');
    // The limit is 3/15min and there is no reset on success, so exactly 3 sends
    // go through before the 4th 429s.
    assert.equal(sent.length, 3, 'three sends, then the limit fires');
  } finally { restore(); }
});

test('ten teachers of forty on one IP in one window are not limited', async () => {
  // Ten teachers of forty share one public address on a back-to-school night,
  // and mobile carriers put many parents behind one CGNAT address anyway. The
  // per-IP cap must not fire for parents each requesting their OWN student's
  // code from the same address -- that was a 429 after three under the old 3/IP
  // limit, which reads to a parent as if they had done something wrong.
  const { env, sent, restore } = mailEnv();
  try {
    for (let i = 0; i < 120; i++) {
      const extId = `9060${String(i).padStart(3, '0')}`;
      const { rosterId } = seedStudent(env._raw, { extId, first: `Kid${i}`, last: `Fam${i}`, parentEmail: `fam${i}@example.com` });
      await seedAccount(env._raw, rosterId, { username: `kid${i}@chicousd.org`, code: `ABCD${String(1000 + i)}`, parentEmail: null });
    }

    const codes = [];
    for (let i = 0; i < 120; i++) {
      const res = await post(env, { student_ext_id: `9060${String(i).padStart(3, '0')}`, email: `fam${i}@example.com` });
      codes.push(res.status);
    }
    assert.deepEqual([...new Set(codes)], [200], 'every parent on the shared IP gets their code');
    assert.equal(sent.length, 120);
  } finally { restore(); }
});

test('redirecting codes to new addresses is capped tightly per IP', async () => {
  // The loose per-IP cap is safe only because THIS path is held tight: handing
  // a code to an address that is not the one on file is the actual attack, and
  // it is what someone walking a list of student IDs would have to do.
  const { env, sent, restore } = mailEnv();
  try {
    for (let i = 0; i < 10; i++) {
      const extId = `90700${String(i).padStart(2, '0')}`;
      const { rosterId } = seedStudent(env._raw, { extId, first: `Kid${i}`, last: `Fam${i}`, parentEmail: `onfile${i}@example.com` });
      await seedAccount(env._raw, rosterId, { username: `k${i}@chicousd.org`, code: `WXYZ23${String(i).padStart(2, '0')}`, parentEmail: null });
    }

    let refusedAt = -1;
    for (let i = 0; i < 10; i++) {
      // A different address every time -> every request is a redirect.
      const res = await post(env, { student_ext_id: `90700${String(i).padStart(2, '0')}`, email: `attacker+${i}@example.com` });
      if (res.status === 429) { refusedAt = i; break; }
    }
    assert.equal(refusedAt, 5, 'five redirects allowed from one IP, the sixth refused');
    assert.equal(sent.length, 5, 'and no mail went out for the refused one');
  } finally { restore(); }
});

test('the mail carries a link to the sign page, on the configured host', async () => {
  // A message containing a credential and no destination reads like phishing to
  // a filter, and leaves the parent holding a code with nowhere to type it.
  const { env, sent, restore } = mailEnv({ APP_URL: 'https://syllabus.example.org/' });
  try {
    seedStudent(env._raw, { parentEmail: 'family@example.com' });
    await register({ request: jsonRequest('https://x/api/register', {
      student_ext_id: '904511', last: 'Alvarez', username: 'malvarez@chicousd.org',
    }), env });

    await post(env, { student_ext_id: '904511', email: 'family@example.com' });
    // Trailing slash on APP_URL must not produce a double slash.
    assert.match(sent[0].body, /https:\/\/syllabus\.example\.org\/sign\b/);
    assert.ok(!sent[0].body.includes('//sign'), 'no doubled slash from a trailing-slash APP_URL');
    assert.ok(sent[0].body.includes('href="https://syllabus.example.org/sign"'),
      'the HTML part links it, not just the text part');
  } finally { restore(); }
});

test('honest failure when no mail server creds are configured and not in dry-run', async () => {
  const env = freshEnv({ MAIL_FROM: 'no-reply@mail.huffpalmer.fyi', CODE_SECRET: 'test-code-secret-at-least-16-chars' });
  seedStudent(env._raw, { parentEmail: 'family@example.com' });
  await seedAccount(env._raw, (await env.DB.prepare('SELECT id FROM roster').first()).id, { code: 'ABCD2345', parentEmail: null });

  const res = await post(env, { student_ext_id: '904511', email: 'family@example.com' });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /Could not send/);
});

test('dry-run logs instead of sending and still reports success', async () => {
  const env = freshEnv({ MAIL_FROM: 'no-reply@mail.huffpalmer.fyi', MAIL_DRY_RUN: '1', CODE_SECRET: 'test-code-secret-at-least-16-chars' });
  seedStudent(env._raw, { parentEmail: 'family@example.com' });
  await seedAccount(env._raw, (await env.DB.prepare('SELECT id FROM roster').first()).id, { code: 'ABCD2345', parentEmail: null });

  const res = await post(env, { student_ext_id: '904511', email: 'family@example.com' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.dry_run, true);
});

test('a legacy account with no parent code mints one on demand and mails it', async () => {
  const { env, sent, restore } = mailEnv();
  try {
    seedStudent(env._raw, { parentEmail: 'family@example.com' });
    // Seed an account with NO parent code (the pre-this-change shape).
    const rosterId = (await env.DB.prepare('SELECT id FROM roster').first()).id;
    await seedAccount(env._raw, rosterId, { code: null, studentCode: 'STU45678', parentEmail: null });

    const res = await post(env, { student_ext_id: '904511', email: 'family@example.com' });
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1, 'a code was minted and mailed');

    // The minted code now signs in as a parent.
    const code = sent[0].body.match(/\b([2-9A-HJ-NP-Z]{8})\b/)[1];
    const loginRes = await login({
      request: jsonRequest('https://x/api/sign/login', { student_ext_id: '904511', email: 'family@example.com', code }),
      env,
    });
    assert.equal(loginRes.status, 200);
    assert.equal((await loginRes.json()).role, 'parent');
  } finally { restore(); }
});

test('the masked preview does not leak the full address to a stranger', async () => {
  const { env, restore } = mailEnv();
  try {
    seedStudent(env._raw, { parentEmail: 'jennifer.alvarez@example.com' });
    await seedAccount(env._raw, (await env.DB.prepare('SELECT id FROM roster').first()).id, { code: 'ABCD2345', parentEmail: null });

    const res = await post(env, { student_ext_id: '904511', email: 'jennifer.alvarez@example.com' });
    const body = await res.json();
    assert.ok(!body.email_preview.includes('jennifer'));
    assert.ok(!body.email_preview.includes('alvarez'));
    assert.match(body.email_preview, /@example\.com$/);
  } finally { restore(); }
});

// ---- school scoping: the Reyes/Whitaker cross-school leak ----
//
// Two unrelated students can share a student_ext_id once a second school
// joins the install -- SIS ids are only unique within a school. See the
// school-scoping-and-identity plan, "Why: the leak, reproduced".

test('a stranger requesting a shared student ID from the wrong school never reaches the other family', async () => {
  const { env, sent, restore } = mailEnv();
  try {
    // Ana Reyes at Northside and Ben Whitaker at Southside share ID 123456.
    const reyes = seedSchoolRoster(env._raw, {
      school: 'Northside High', course: 'Algebra I', extId: '123456',
      first: 'Ana', last: 'Reyes', parentEmail: 'reyes.family@example.com',
    });
    const whitaker = seedSchoolRoster(env._raw, {
      school: 'Southside High', course: 'Geometry', extId: '123456',
      first: 'Ben', last: 'Whitaker', parentEmail: 'whitaker.family@example.com',
    });
    await seedAccount(env._raw, reyes.rosterId, { username: 'areyes@chicousd.org', code: 'REYS2345', studentCode: 'RSTU2345', parentEmail: null });
    await seedAccount(env._raw, whitaker.rosterId, { username: 'bwhitaker@chicousd.org', code: 'WHIT2345', studentCode: 'WSTU2345', parentEmail: null });

    // The Whitaker parent requests their own code, with their own correct
    // address, scoped to their own school.
    const res = await post(env, {
      student_ext_id: '123456', email: 'whitaker.family@example.com', school_id: whitaker.schoolId,
    });
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1, 'exactly one mail, to the Whitaker family');
    assert.equal(sent[0].to, 'whitaker.family@example.com');
    assert.match(sent[0].body, /Ben Whitaker/, "the mail must name Whitaker, not Reyes");
    assert.ok(!sent[0].body.includes('Ana Reyes'), 'the mail must never name the other family\'s student');

    // The code that arrived opens a session as WHITAKER's parent.
    const code = sent[0].body.match(/\b([2-9A-HJ-NP-Z]{8})\b/)[1];
    const loginRes = await login({
      request: jsonRequest('https://x/api/sign/login', { student_ext_id: '123456', email: 'whitaker.family@example.com', code }),
      env,
    });
    assert.equal(loginRes.status, 200);
    assert.equal((await loginRes.json()).role, 'parent');

    // The write that corrupted Reyes's contact address in the reproduction
    // must never fire against her account: it was never a candidate.
    const reyesEmail = env._raw.prepare('SELECT si.parent_email FROM student_identities si JOIN accounts a ON a.identity_id = si.id WHERE a.roster_id = ?').get(reyes.rosterId).parent_email;
    assert.equal(reyesEmail, null, "a stranger targeting Whitaker's school must never touch Reyes's account");
  } finally { restore(); }
});

test('the same shared ID from the OTHER school reaches the other family, symmetrically', async () => {
  const { env, sent, restore } = mailEnv();
  try {
    const reyes = seedSchoolRoster(env._raw, {
      school: 'Northside High', course: 'Algebra I', extId: '123456',
      first: 'Ana', last: 'Reyes', parentEmail: 'reyes.family@example.com',
    });
    const whitaker = seedSchoolRoster(env._raw, {
      school: 'Southside High', course: 'Geometry', extId: '123456',
      first: 'Ben', last: 'Whitaker', parentEmail: 'whitaker.family@example.com',
    });
    await seedAccount(env._raw, reyes.rosterId, { username: 'areyes@chicousd.org', code: 'REYS2345', studentCode: 'RSTU2345', parentEmail: null });
    await seedAccount(env._raw, whitaker.rosterId, { username: 'bwhitaker@chicousd.org', code: 'WHIT2345', studentCode: 'WSTU2345', parentEmail: null });

    const res = await post(env, {
      student_ext_id: '123456', email: 'reyes.family@example.com', school_id: reyes.schoolId,
    });
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /Ana Reyes/);

    const whitakerEmail = env._raw.prepare('SELECT si.parent_email FROM student_identities si JOIN accounts a ON a.identity_id = si.id WHERE a.roster_id = ?').get(whitaker.rosterId).parent_email;
    assert.equal(whitakerEmail, null, "the Northside request must never touch Whitaker's account");
  } finally { restore(); }
});

test('more than one school on the install requires a school_id', async () => {
  const { env, sent, restore } = mailEnv();
  try {
    seedSchoolRoster(env._raw, { school: 'Northside High', course: 'Algebra I', extId: '904511' });
    seedSchoolRoster(env._raw, { school: 'Southside High', course: 'Geometry', extId: '904512' });

    const res = await post(env, { student_ext_id: '904511', email: 'x@example.com' });
    assert.equal(res.status, 400);
    assert.equal(sent.length, 0);
  } finally { restore(); }
});

test('a student enrolled in two courses at one school resolves to one identity', async () => {
  // With student_identities, UNIQUE (school_id, student_ext_id) means there is
  // exactly one identity per school per id -- no more ambiguous roster row
  // concern. The old "refuse if more than one roster row" guard is gone.
  const { env, sent, restore } = mailEnv();
  try {
    const a = seedSchoolRoster(env._raw, { school: 'Northside High', course: 'Algebra I', extId: '555555', first: 'Sam', last: 'Kim' });
    seedSchoolRoster(env._raw, { school: 'Northside High', course: 'Trigonometry', extId: '555555', first: 'Sam', last: 'Kim' });

    // No identity yet -- the student hasn't registered.
    const res = await post(env, { student_ext_id: '555555', email: 'x@example.com', school_id: a.schoolId });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /student needs to set up/, 'no identity yet, so the parent is told to have the student register first');
    assert.equal(sent.length, 0);
  } finally { restore(); }
});

test('a single-school install still resolves a roster row behind an unowned legacy course', async () => {
  // seedStudent's course has no owner_id -- the shape every course predating
  // teacher accounts is in (migrations/0002) -- and freshEnv seeds exactly one
  // school (the migration placeholder). Scoping must be a complete no-op here:
  // nothing about this endpoint's behaviour may change for an install that
  // has not yet grown a second school.
  const { env, sent, restore } = mailEnv();
  try {
    assert.equal(env._raw.prepare('SELECT COUNT(*) AS n FROM schools').get().n, 1);
    seedStudent(env._raw, { parentEmail: 'family@example.com' });
    await seedAccount(env._raw, (await env.DB.prepare('SELECT id FROM roster').first()).id, { code: 'ABCD2345', parentEmail: null });

    const res = await post(env, { student_ext_id: '904511', email: 'family@example.com' });
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
  } finally { restore(); }
});