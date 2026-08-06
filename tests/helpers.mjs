// Shared test harness: a real SQLite database behind the D1 client surface.
//
// D1 is SQLite, so the schema and every query the handlers run are the same
// ones production executes. Only the client API shape is stood in for.
// node:sqlite is stdlib (Node 22+), so this costs no dependency.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { hashCode } from '../functions/_lib/codes.js';

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
    _raw: db,
    ...extra,
  };
}

export const ADMIN_HEADERS = { 'Cf-Access-Authenticated-User-Email': 'teacher@school.edu' };

/** Insert a course with one student, and return the ids. */
export function seedStudent(db, { course = 'Algebra I', extId = '904511', first = 'Maria', last = 'Alvarez', period = '3', parentEmail = null } = {}) {
  let courseId = db.prepare('SELECT id FROM courses WHERE name = ?').get(course)?.id;
  if (!courseId) {
    courseId = Number(db.prepare('INSERT INTO courses (name, created_at) VALUES (?, ?)').run(course, 1000).lastInsertRowid);
  }
  const rosterId = Number(
    db.prepare(
      "INSERT INTO roster (course_id, period, student_ext_id, first, last, parent_email, status) VALUES (?, ?, ?, ?, ?, ?, 'active')",
    ).run(courseId, period, extId, first, last, parentEmail).lastInsertRowid,
  );
  return { courseId, rosterId, extId };
}

/** Insert a school, a teacher who owns it, a course that teacher owns, and one
 *  roster row in it -- for tests that exercise the school-scoped join
 *  (roster -> courses -> teachers -> schools), which seedStudent's UNOWNED
 *  course cannot reach. Reuses an existing school/course by name so two calls
 *  can share one school or one course, the way two teachers at a real school
 *  would. */
export function seedSchoolRoster(db, {
  school, course, extId = '904511', first = 'Maria', last = 'Alvarez', period = '3', parentEmail = null,
} = {}) {
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
      "INSERT INTO roster (course_id, period, student_ext_id, first, last, parent_email, status) VALUES (?, ?, ?, ?, ?, ?, 'active')",
    ).run(courseId, period, extId, first, last, parentEmail).lastInsertRowid,
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
  username = '904511@s',
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

  // Find or create the student_identities row.
  let identityId = db.prepare(
    'SELECT id FROM student_identities WHERE school_id = ? AND student_ext_id = ?',
  ).get(schoolId, extId)?.id;

  if (!identityId) {
    identityId = Number(
      db.prepare(
        `INSERT INTO student_identities (school_id, student_ext_id, username, code_hash, code_issued_at, parent_email, created_at,
                                         student_code_hash, student_code_issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(schoolId, extId, username, code ? await hashCode(code) : null, code ? 1000 : null,
        parentEmail, 1000,
        studentCode ? await hashCode(studentCode) : null, studentCode ? 1000 : null).lastInsertRowid,
    );
  }

  const accountId = Number(
    db.prepare(
      'INSERT INTO accounts (roster_id, identity_id, created_at) VALUES (?, ?, ?)',
    ).run(rosterId, identityId, 1000).lastInsertRowid,
  );
  return { accountId, identityId, code, studentCode };
}

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
