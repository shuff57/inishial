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
// second copy of this mock would be a second thing to keep in step with the
// JMAP call shape.
// In-memory mail capture: stand in for Stalwart by intercepting fetch. mail.js
// bootstraps against the JMAP session document, then posts Email/set +
// EmailSubmission/set to the API URL; this mock answers both and records what
// the send actually contained.
export const MAIL_HOST = 'https://smtp.test:8443';
export const MAIL_FROM = 'no-reply@mail.huffpalmer.fyi';
export const MAIL_REPLY_TO = 'support@mail.huffpalmer.fyi';

function mailJson(body) {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

export function mailEnv(extra = {}) {
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
      return mailJson({
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
      return mailJson({ methodResponses: calls.map(([n, a, id]) => answer(n, a, id)) });
    }
    return realFetch(url, opts);
  };

  return { env, sent, restore: () => { globalThis.fetch = realFetch; } };
}
