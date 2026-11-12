// Shared test harness: a real SQLite database behind the D1 client surface.
//
// D1 is SQLite, so the schema and every query the handlers run are the same
// ones production executes. Only the client API shape is stood in for.
// node:sqlite is stdlib (Node 22+), so this costs no dependency.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { hashCode } from '../functions/_lib/codes.js';
import { seal, blindIndex } from '../functions/_lib/vault.js';

// Every migration, in filename order -- not just the initial one. Pinning this
// to 0001 meant a new migration was invisible to the whole suite, so tests
// passed against a schema production did not have.
const MIGRATIONS = new URL('../migrations/', import.meta.url);
const SCHEMA = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS), 'utf8'))
  .join('\n');

export function d1(db) {
  return {
    prepare(sql) {
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        run() {
          const r = db.prepare(sql).run(...args);
          return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
        },
        first() { return db.prepare(sql).get(...args) ?? null; },
        all() { return { results: db.prepare(sql).all(...args) }; },
      };
      return api;
    },
  };
}

export function freshEnv(extra = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return {
    DB: d1(db),
    ADMIN_EMAILS: 'teacher@school.edu',
    SESSION_SECRET: 'test-secret-not-used-anywhere-real',
    // Every roster row now carries a sealed surname and a keyed digest
    // (migration 0017), so the vault is part of the baseline environment
    // rather than something only the code-vault tests switch on. A test that
    // wants it absent passes `{ CODE_SECRET: undefined }`.
    CODE_SECRET: 'test-code-secret-not-used-anywhere-real',
    _raw: db,
    ...extra,
  };
}

export const ADMIN_HEADERS = { 'Cf-Access-Authenticated-User-Email': 'teacher@school.edu' };

/** Insert a course with one student, and return the ids.
 *
 *  Takes the whole env, not the raw handle: seeding a roster row now needs
 *  CODE_SECRET to seal the surname and compute its lookup digest, exactly as
 *  the import endpoint does. Async for the same reason -- WebCrypto has no
 *  synchronous form. */
export async function seedStudent(env, { course = 'Algebra I', extId = '904511', last = 'Alvarez', period = '3', parentEmail = null } = {}) {
  const db = env._raw;
  let courseId = db.prepare('SELECT id FROM courses WHERE name = ?').get(course)?.id;
  if (!courseId) {
    courseId = Number(db.prepare('INSERT INTO courses (name, created_at) VALUES (?, ?)').run(course, 1000).lastInsertRowid);
  }
  const rosterId = Number(
    db.prepare(
      "INSERT INTO roster (course_id, period, student_ext_id, last_enc, last_idx, parent_email, status) VALUES (?, ?, ?, ?, ?, ?, 'active')",
    ).run(courseId, period, extId, await seal(env, last), await blindIndex(env, last, extId), parentEmail).lastInsertRowid,
  );
  return { courseId, rosterId, extId };
}

/** Insert a school, a teacher who owns it, a course that teacher owns, and one
 *  roster row in it -- for tests that exercise the school-scoped join
 *  (roster -> courses -> teachers -> schools), which seedStudent's UNOWNED
 *  course cannot reach. Reuses an existing school/course by name so two calls
 *  can share one school or one course, the way two teachers at a real school
 *  would. */
export async function seedSchoolRoster(env, {
  school, course, extId = '904511', last = 'Alvarez', period = '3', parentEmail = null,
} = {}) {
  const db = env._raw;
  let schoolId = db.prepare('SELECT id FROM schools WHERE name = ?').get(school)?.id;
  if (!schoolId) {
    schoolId = Number(db.prepare('INSERT INTO schools (name) VALUES (?)').run(school).lastInsertRowid);
  }
  const teacherEmail = `${course}-${extId}@${school}`.toLowerCase().replace(/[^a-z0-9@.]+/g, '-');
  const teacherId = Number(
    db.prepare('INSERT INTO teachers (email, password_hash, created_at, school_id) VALUES (?, ?, ?, ?)')
      .run(teacherEmail, 'x', 1000, schoolId).lastInsertRowid,
  );
  let courseId = db.prepare('SELECT id FROM courses WHERE name = ? AND owner_id IS NOT NULL').get(course)?.id;
  if (!courseId) {
    courseId = Number(
      db.prepare('INSERT INTO courses (name, created_at, owner_id) VALUES (?, ?, ?)')
        .run(course, 1000, teacherId).lastInsertRowid,
    );
  }
  const rosterId = Number(
    db.prepare(
      "INSERT INTO roster (course_id, period, student_ext_id, last_enc, last_idx, parent_email, status) VALUES (?, ?, ?, ?, ?, ?, 'active')",
    ).run(courseId, period, extId, await seal(env, last), await blindIndex(env, last, extId), parentEmail).lastInsertRowid,
  );
  return { schoolId, teacherId, courseId, rosterId, extId };
}

/** Register the student and issue both known access codes -- `code` is the
 *  parent's, `studentCode` the student's. They are different strings here for
 *  the same reason they are in production: which one is used at sign-in is what
 *  decides whose signature the session may write.
 *
 *  Creates a student_identities row (resolving school_id through the roster's
 *  course -> teacher -> school, falling back to the placeholder school id 1
 *  for an unowned course) plus an accounts row pointing at it. Returns the
 *  same shape as before so existing call sites are untouched. */
export async function seedAccount(db, rosterId, {
  username,
  code = 'ABCD2345',
  studentCode = 'STU45678',
  parentEmail = 'parent@example.com',
} = {}) {
  // Resolve school_id: roster -> course -> teacher -> school, fallback to 1.
  const schoolRow = db.prepare(
    `SELECT COALESCE(t.school_id, 1) AS school_id
       FROM roster r
       JOIN courses c ON c.id = r.course_id
       LEFT JOIN teachers t ON t.id = c.owner_id
      WHERE r.id = ?1`,
  ).get(rosterId);
  const schoolId = schoolRow ? schoolRow.school_id : 1;

  const extId = db.prepare('SELECT student_ext_id FROM roster WHERE id = ?').get(rosterId)?.student_ext_id;

  // The same derivation api/register.js uses. Built here rather than defaulted
  // to a literal so a test seeded against a real school gets that school's id
  // in the username, exactly as production would -- a hardcoded '904511@s'
  // would only ever be right for the placeholder school.
  const studentUsername = username ?? `${String(extId).toLowerCase()}@s${schoolId}`;
  const parentUsername = `${String(extId).toLowerCase()}@p${schoolId}`;

  // Find or create the student_identities row.
  let identityId = db.prepare(
    'SELECT id FROM student_identities WHERE school_id = ? AND student_ext_id = ?',
  ).get(schoolId, extId)?.id;

  if (!identityId) {
    identityId = Number(
      db.prepare(
        `INSERT INTO student_identities (school_id, student_ext_id, username, parent_username, code_hash, code_issued_at, parent_email, created_at,
                                         student_code_hash, student_code_issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(schoolId, extId, studentUsername, parentUsername, code ? await hashCode(code) : null, code ? 1000 : null,
        parentEmail, 1000,
        studentCode ? await hashCode(studentCode) : null, studentCode ? 1000 : null).lastInsertRowid,
    );
  }

  const accountId = Number(
    db.prepare(
      'INSERT INTO accounts (roster_id, identity_id, created_at) VALUES (?, ?, ?)',
    ).run(rosterId, identityId, 1000).lastInsertRowid,
  );
  return { accountId, identityId, code, studentCode, username: studentUsername, parentUsername, schoolId };
}

/** The sign-in body for a seeded student. Sign-in takes a username and a code
 *  and nothing else, so a test that wants to be "the parent of 904511 at the
 *  placeholder school" needs the derived username rather than the ID it came
 *  from. Defaults match seedStudent's unowned course, which resolves to the
 *  placeholder school id 1. */
export const parentLogin = (code, extId = '904511', schoolId = 1) =>
  ({ username: `${String(extId).toLowerCase()}@p${schoolId}`, code });
export const studentLogin = (code, extId = '904511', schoolId = 1) =>
  ({ username: `${String(extId).toLowerCase()}@s${schoolId}`, code });

/**
 * Create a syllabus with blocks.
 * blocks: [{ type, html, needs_initials, per_block }] -- ord follows array order.
 */
export function seedSyllabus(db, courseId, blocks, { title = 'Algebra I Syllabus', num = 1, published = true } = {}) {
  const slug = `${title}-${num}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  let syllabusId = db.prepare('SELECT id FROM syllabi WHERE course_id = ?').get(courseId)?.id;
  if (!syllabusId) {
    syllabusId = Number(db.prepare('INSERT INTO syllabi (course_id, title, slug) VALUES (?, ?, ?)').run(courseId, title, slug).lastInsertRowid);
  }
  const versionId = Number(
    db.prepare('INSERT INTO versions (syllabus_id, num, published_at) VALUES (?, ?, ?)')
      .run(syllabusId, num, published ? 2000 : null).lastInsertRowid,
  );
  const blockIds = blocks.map((b, i) =>
    Number(
      db.prepare('INSERT INTO blocks (version_id, ord, type, html, needs_initials, per_block) VALUES (?, ?, ?, ?, ?, ?)')
        .run(versionId, i, b.type ?? 'text', b.html ?? '', b.needs_initials ? 1 : 0, b.per_block ? 1 : 0).lastInsertRowid,
    ),
  );
  return { syllabusId, versionId, blockIds };
}

/** Pull the session cookie out of a login response, ready to send back. */
export function cookieFrom(response) {
  const setCookie = response.headers.get('Set-Cookie') || '';
  return setCookie.split(';')[0];
}

export const jsonRequest = (url, body, headers = {}) =>
  new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

// ---- mail capture ----
//
// Shared by every test that exercises an outbound email: the parent access
// code and the teacher password reset both go through _lib/mail.js, and a
// second copy of this fake would be a second thing to keep in step with the
// SMTP conversation.
//
// mail.js sends over SMTP submission to Stalwart using Cloudflare's sockets,
// which do not exist under Node. smtp.js therefore opens its socket through env.SMTP_CONNECT
// when it is set, and this file supplies a fake server behind it: it speaks
// enough SMTP (greeting, EHLO, STARTTLS, AUTH LOGIN, MAIL, RCPT, DATA, QUIT) to
// refuse out-of-order commands the way a real server would, decodes the message
// it is handed, and records what the send actually contained.
export const MAIL_FROM = 'inishial-no-reply@lefthanddev.com'; // the mailbox that signs in, and the From address
export const MAIL_REPLY_TO = 'inishial-support@lefthanddev.com';
export const SMTP_PASSWORD = 'abcd efgh ijkl mnop';           // app passwords may be shown in spaced groups

const decodeWord = (s) => s.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi,
  (_, b) => Buffer.from(b, 'base64').toString('utf8'));

/**
 * A fake Stalwart submission server. Returns a `connect` to hand to env.SMTP_CONNECT.
 * Each entry pushed to `calls` records the address, the options (so a test can see
 * secureTransport) and `verbs`, the SMTP commands the client sent, in order.
 * `reject` makes it refuse a step: { auth, mailFrom, rcpt, data }.
 */
export function fakeSmtpConnect(sent, { reject = {}, calls = [] } = {}) {
  return (addr, opts) => {
    const call = { ...addr, ...opts, verbs: [] };
    calls.push(call);
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    let controller;
    let closed = false;
    const readable = new ReadableStream({ start(c) { controller = c; } });
    const say = (s) => { if (!closed) controller.enqueue(enc.encode(s + '\r\n')); };

    // 'on' means the connection is encrypted from the first byte (port 465).
    let tls = opts?.secureTransport === 'on', authed = false, authStep = 0, inData = false, buf = '';
    let mailFrom = '', rcpt = [];

    const finishMessage = (raw) => {
      const [head, ...rest] = raw.split('\r\n\r\n');
      const h = {};
      for (const l of head.split('\r\n')) {
        const m = l.match(/^([A-Za-z-]+):\s*(.*)$/);
        if (m) h[m[1].toLowerCase()] = m[2];
      }
      const boundary = (h['content-type'] || '').match(/boundary="([^"]+)"/)?.[1];
      const body = rest.join('\r\n\r\n');
      const bodies = (boundary ? body.split('--' + boundary) : [body])
        .filter((p) => /Content-Transfer-Encoding: base64/i.test(p))
        .map((p) => Buffer.from(p.split('\r\n\r\n').slice(1).join('').replace(/\s+/g, ''), 'base64').toString('utf8'));
      sent.push({
        to: h.to,
        from: (h.from || '').match(/<([^>]+)>/)?.[1],
        fromName: decodeWord((h.from || '').replace(/\s*<[^>]+>/, '').replace(/^"|"$/g, '')),
        replyTo: h['reply-to'],
        subject: decodeWord(h.subject || ''),
        body: bodies.join('\n'),
        mailFrom,
        rcptTo: rcpt.join(', '),
        messageId: h['message-id'],
        headers: h,
        raw,
      });
    };

    const command = (line) => {
      if (authStep === 1) {
        authStep = 2;
        authed = Buffer.from(line, 'base64').toString() === MAIL_FROM;
        return say('334 UGFzc3dvcmQ6');
      }
      if (authStep === 2) {
        authStep = 0;
        const ok = authed && !reject.auth && Buffer.from(line, 'base64').toString() === SMTP_PASSWORD.replace(/\s/g, '');
        authed = ok;
        // A real server's refusal can be a multi-line reply; sending both exercises the
        // client's multi-line handling ("535-" continues until "535 ").
        return say(ok ? '235 2.7.0 Accepted'
          : '535-5.7.8 Username and Password not accepted. For more information, go to\r\n535 5.7.8 https://support.google.com/mail/?p=BadCredentials - gsmtp');
      }
      const verb = line.split(/[ :]/)[0].toUpperCase();
      call.verbs.push(verb);
      if (verb === 'EHLO') return say('250-smtp.test at your service\r\n250-STARTTLS\r\n250 AUTH LOGIN');
      if (verb === 'STARTTLS') {
        if (tls) return say('503 5.5.1 TLS already active');
        return say('220 2.0.0 Ready to start TLS');
      }
      if (verb === 'AUTH') {
        if (!tls) return say('530 5.7.0 Must issue a STARTTLS command first.');
        authStep = 1;
        return say('334 VXNlcm5hbWU6');
      }
      if (verb === 'MAIL') {
        if (!authed) return say('530 5.7.0 Authentication Required.');
        if (reject.mailFrom) return say('553 5.7.1 Sender not allowed.');
        mailFrom = line.match(/<([^>]*)>/)?.[1] || '';
        rcpt = [];
        return say('250 2.1.0 OK');
      }
      if (verb === 'RCPT') {
        if (reject.rcpt) return say('550 5.1.1 No such user here.');
        rcpt.push(line.match(/<([^>]*)>/)?.[1] || '');
        return say('250 2.1.5 OK');
      }
      if (verb === 'DATA') { inData = true; return say('354 Go ahead'); }
      if (verb === 'QUIT') return say('221 2.0.0 Bye');
      return say('500 5.5.1 Unrecognized command');
    };

    const drain = () => {
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const raw = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          if (reject.data) say('554 5.7.1 Message refused');
          else { finishMessage(raw); say('250 2.0.0 OK queued'); }
        } else {
          const nl = buf.indexOf('\r\n');
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          command(line);
        }
      }
    };

    const writable = new WritableStream({
      write(chunk) { buf += dec.decode(chunk, { stream: true }); drain(); },
    });
    const socket = {
      readable,
      writable,
      startTls() { tls = true; return socket; },
      close() { if (!closed) { closed = true; try { controller.close(); } catch { /* already closed */ } } },
    };
    say('220 smtp.test ESMTP ready');
    return socket;
  };
}

export function mailEnv(extra = {}, smtp = {}) {
  const sent = [];
  const calls = [];
  const env = freshEnv({
    SMTP_HOSTNAME: 'smtp.huffpalmer.fyi',
    SMTP_PORT: '465',
    SMTP_USERNAME: MAIL_FROM,
    SMTP_PASSWORD,
    SMTP_FROM_NAME: 'iniSHial',
    MAIL_REPLY_TO,
    SMTP_CONNECT: fakeSmtpConnect(sent, { ...smtp, calls }),
    CODE_SECRET: 'test-code-secret-at-least-16-chars',
    ...extra,
  });
  // `restore` is kept so existing tests can still call it; nothing global is
  // patched any more, so there is nothing to undo.
  return { env, sent, calls, restore: () => {} };
}
