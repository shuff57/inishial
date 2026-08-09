// GET /api/admin/progress?course_id=N[&format=csv]   (Access gated)
//
// Who has signed, who hasn't, and who signed something you have since
// replaced. The three things actually worth chasing.
//
// Reported against the CURRENTLY published version. A parent who completed
// version 1 is not "done" once version 2 is live if the sections they signed
// changed -- `stale` exists to make that visible instead of quietly counting
// them as complete.

import { json, badRequest, unauthorized, serverMisconfigured, requireAdmin, ownedCourse, csvResponse, csvRow } from '../../_lib/http.js';
import { attestationKey, attestedBlocks, blocksOf, promptKeys } from '../../_lib/syllabus.js';

const STATUS = {
  not_registered: 'Not registered',
  no_code: 'No code issued',
  not_started: 'Not started',
  partial: 'Partly signed',
  stale: 'Signed an older version',
  complete: 'Complete',
};

export async function onRequestGet({ request, env }) {
  const admin = await requireAdmin(request, env);
  if (!admin) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  const url = new URL(request.url);
  const courseId = Number(url.searchParams.get('course_id'));
  if (!Number.isInteger(courseId) || courseId < 1) return badRequest('course_id is required.');

  const course = await ownedCourse(env, courseId, admin);
  if (!course) return badRequest('No such course.');

  const published = await env.DB.prepare(
    `SELECT v.id, v.num FROM versions v
       JOIN syllabi s ON s.id = v.syllabus_id
      WHERE s.course_id = ?1 AND v.published_at IS NOT NULL
      ORDER BY v.num DESC LIMIT 1`,
  ).bind(courseId).first();

  // The attestation hash of every prompt on the live version -- the same key
  // the parent's own view is answered with. Counting signatures by
  // `version_id = published` instead would report a family who signed in August
  // and re-initialed only an amended section as "1 of 6" forever, because
  // publishing clones blocks and their earlier five signatures sit on rows the
  // new version has no ids in common with. See attestedByAccount().
  const liveBlocks = published ? await blocksOf(env.DB, published.id) : [];
  const liveKeys = published
    ? new Set((await promptKeys(liveBlocks)).filter(Boolean))
    : new Set();
  const required = liveKeys.size;

  // The version before this one, so the page can say WHAT was amended rather
  // than only that something was. Null on a first publish, which is not an
  // amendment and should not be described as one.
  const previous = published
    ? await env.DB.prepare(
      `SELECT v.id, v.num FROM versions v
         JOIN syllabi s ON s.id = v.syllabus_id
        WHERE s.course_id = ?1 AND v.published_at IS NOT NULL AND v.num < ?2
        ORDER BY v.num DESC LIMIT 1`,
    ).bind(courseId, published.num).first()
    : null;

  // Which sections a family who signed the previous version now has to read
  // again: the prompts whose key is not one the old version offered. Named by
  // their heading, because "Late Work" is what a parent will look for on the
  // page -- a block id or a prompt sentence is not.
  let changedSections = [];
  if (previous) {
    const wasKeys = new Set((await promptKeys(await blocksOf(env.DB, previous.id))).filter(Boolean));
    const keys = await promptKeys(liveBlocks);
    const titles = liveBlocks.map((b, i) => {
      if (!b.needs_initials || wasKeys.has(keys[i])) return null;
      // An `agree` block attests to the whole document, so ANY edit anywhere
      // re-stales it and attestedBlocks() hands back every block -- whose first
      // heading is whatever opens the syllabus. Left in, the email told families
      // that "T. Teacher — Biology 1, Period 6" had changed when nothing in it
      // had. It is still re-initialed, and the page still marks it; it is just
      // not a section that changed.
      if (b.type === 'agree') return null;
      const heading = attestedBlocks(liveBlocks, i).find((x) => x.type === 'heading');
      // Tags stripped rather than escaped: this is a label the page prints as
      // text and the client puts into an email body.
      return heading ? String(heading.html).replace(/<[^>]*>/g, '').trim() : null;
    });
    changedSections = [...new Set(titles.filter(Boolean))];
  }

  const { results } = await env.DB.prepare(
    `SELECT r.student_ext_id, r.first, r.last, r.period,
            a.id AS account_id, si.username,
            COALESCE(si.parent_email, r.parent_email) AS email,
            CASE WHEN si.code_hash IS NOT NULL THEN 1 ELSE 0 END AS code_issued,
            (SELECT MAX(v2.num) FROM signatures s2
               JOIN versions v2 ON v2.id = s2.version_id
              WHERE s2.account_id = a.id AND s2.role = 'parent') AS last_signed_version
       FROM roster r
       LEFT JOIN accounts a ON a.roster_id = r.id
       LEFT JOIN student_identities si ON si.id = a.identity_id
      WHERE r.course_id = ?1 AND r.status = 'active'
      ORDER BY r.period, r.last, r.first`,
  ).bind(courseId).all();

  // Every signature in the class, once, and the tallying done here rather than
  // in SQL. The key is span + prompt sentence (see attestationKey), which is
  // not a column and would have to be assembled with string concatenation
  // inside an IN list of one entry per prompt per student. A class is thirty
  // families and a syllabus a dozen sections; this is a few hundred rows and a
  // Set, and it is the same rule the parent's own page is answered with rather
  // than a second copy of it written in SQL.
  const { results: sigRows } = await env.DB.prepare(
    `SELECT s.account_id, s.role, s.block_hash, s.signed_at, b.html AS prompt
       FROM signatures s
       JOIN blocks   b ON b.id = s.block_id
       JOIN accounts a ON a.id = s.account_id
       JOIN roster   r ON r.id = a.roster_id
      WHERE r.course_id = ?1`,
  ).bind(courseId).all();

  // account_id -> role -> Set of live prompt keys satisfied. A Set, so a family
  // holding two signatures on the same attestation -- signed on v1, signed
  // again on v3 after a change was made and then reverted -- counts once and
  // cannot report 7 of 6.
  const satisfied = new Map();
  const lastAt = new Map();
  for (const s of sigRows ?? []) {
    if (!liveKeys.has(attestationKey(s.block_hash, s.prompt))) continue;
    if (!satisfied.has(s.account_id)) satisfied.set(s.account_id, { parent: new Set(), student: new Set() });
    satisfied.get(s.account_id)[s.role]?.add(attestationKey(s.block_hash, s.prompt));
    lastAt.set(s.account_id, Math.max(lastAt.get(s.account_id) ?? 0, s.signed_at));
  }

  const students = (results ?? []).map((r) => {
    const mine = satisfied.get(r.account_id);
    const parentSigned = mine?.parent.size ?? 0;
    const studentSigned = mine?.student.size ?? 0;
    let status;
    if (!r.account_id) status = 'not_registered';
    else if (!r.code_issued) status = 'no_code';
    else if (required && parentSigned >= required) status = 'complete';
    // Checked BEFORE `partial`, and the order carries the meaning. Both are
    // "some sections outstanding", but they are different asks: a family part
    // way through their first read has simply not finished, while one whose
    // signatures all predate the live version finished once and is now behind
    // an amendment. Only the second is worth an email.
    else if (r.last_signed_version && published && r.last_signed_version < published.num) status = 'stale';
    else if (parentSigned > 0) status = 'partial';
    else status = 'not_started';

    return {
      student: `${r.last}, ${r.first}`,
      student_ext_id: r.student_ext_id,
      period: r.period,
      username: r.username,
      email: r.email,
      account_id: r.account_id,
      code_issued: !!r.code_issued,
      parent_signed: parentSigned,
      student_signed: studentSigned,
      required,
      last_signed_version: r.last_signed_version,
      last_signed_at: lastAt.get(r.account_id) ?? null,
      status,
      status_label: STATUS[status],
    };
  });

  const counts = students.reduce((acc, s) => ({ ...acc, [s.status]: (acc[s.status] ?? 0) + 1 }), {});

  if (url.searchParams.get('format') === 'csv') {
    // Both counts, matching the page. `Sections initialed` was the parent's
    // alone under a name that did not say so.
    const lines = [csvRow(['Student', 'Student ID', 'Period', 'Parent email', 'Status',
      'Parent initialed', 'Student initialed', 'Required', 'Signed on'])];
    for (const s of students) {
      lines.push(csvRow([
        s.student, s.student_ext_id, s.period ?? '', s.email ?? '', s.status_label,
        s.parent_signed, s.student_signed, s.required,
        s.last_signed_at ? new Date(s.last_signed_at * 1000).toISOString() : '',
      ]));
    }
    const slug = course.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
    return csvResponse(`signatures-${slug || courseId}.csv`, lines.join('\r\n') + '\r\n');
  }

  return json({
    course,
    published: published ? { num: published.num, required } : null,
    // What the notify panel is built from. `changed_sections` can be empty on a
    // real amendment -- a syllabus with no headings, or an edit to a section
    // that asks for nothing -- so the page has to read the count, not the list.
    amendment: previous
      ? { version: published.num, previous_version: previous.num, changed_sections: changedSections }
      : null,
    counts,
    total: students.length,
    students,
  });
}
