// Draft/version helpers shared by the authoring endpoints.
//
// The model, restated because everything here depends on it:
//   - Exactly one draft per syllabus: the version row with published_at NULL.
//   - Publishing stamps published_at on that draft. From that moment the row
//     and its blocks are immutable -- nothing updates them, ever.
//   - Publishing then clones the frozen version into a fresh draft, so editing
//     always has somewhere to go and never touches signed content.

import { sha256Hex } from './codes.js';

/** The syllabus for a course, creating it on first use. */
export async function ensureSyllabus(db, courseId, title) {
  const found = await db.prepare('SELECT id, title FROM syllabi WHERE course_id = ?1').bind(courseId).first();
  if (found) return found.id;

  // Slug is derived from the course id so two courses cannot collide on title.
  const slug = `${String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'syllabus'}-${courseId}`;
  const ins = await db.prepare('INSERT INTO syllabi (course_id, title, slug) VALUES (?1, ?2, ?3)')
    .bind(courseId, title, slug).run();
  return ins.meta.last_row_id;
}

/** The open draft for a syllabus, creating an empty one if none exists. */
export async function ensureDraft(db, syllabusId) {
  const draft = await db.prepare(
    'SELECT id, num FROM versions WHERE syllabus_id = ?1 AND published_at IS NULL ORDER BY num DESC LIMIT 1',
  ).bind(syllabusId).first();
  if (draft) return draft;

  const max = await db.prepare('SELECT MAX(num) AS n FROM versions WHERE syllabus_id = ?1').bind(syllabusId).first();
  const num = (max?.n ?? 0) + 1;
  const ins = await db.prepare('INSERT INTO versions (syllabus_id, num, published_at) VALUES (?1, ?2, NULL)')
    .bind(syllabusId, num).run();
  return { id: ins.meta.last_row_id, num };
}

export async function latestPublished(db, syllabusId) {
  return db.prepare(
    'SELECT id, num, published_at FROM versions WHERE syllabus_id = ?1 AND published_at IS NOT NULL ORDER BY num DESC LIMIT 1',
  ).bind(syllabusId).first();
}

export async function blocksOf(db, versionId) {
  const { results } = await db.prepare(
    'SELECT id, ord, type, html, needs_initials, level, per_block FROM blocks WHERE version_id = ?1 ORDER BY ord',
  ).bind(versionId).all();
  return (results ?? []).map((b) => ({
    ...b,
    needs_initials: !!b.needs_initials,
    per_block: !!b.per_block,
    level: b.level ?? 2,
  }));
}

const TYPES = new Set(['heading', 'text', 'list', 'initial', 'agree']);

/**
 * Replace a draft's blocks wholesale.
 *
 * Safe precisely because it is a DRAFT: published blocks are never touched, so
 * no signature can be orphaned by this. Callers must refuse to call it with a
 * published version id.
 */
export async function replaceDraftBlocks(db, versionId, blocks) {
  await db.prepare('DELETE FROM blocks WHERE version_id = ?1').bind(versionId).run();
  let ord = 0;
  for (const raw of blocks) {
    const type = TYPES.has(raw.type) ? raw.type : 'text';
    // Only prompts can carry initials -- a heading or a bare paragraph asking
    // for initials would render without anything to sign against.
    const needs = (type === 'initial' || type === 'agree') ? 1 : 0;
    // Only a heading has a level, and only 2 or 3. Anything else is 2, because
    // a stray level on a paragraph would be silently meaningless -- and a bad
    // level on a heading changes where a section starts, which changes what a
    // parent is held to have agreed to.
    const level = type === 'heading' && Number(raw.level) === 3 ? 3 : 2;
    await db.prepare(
      'INSERT INTO blocks (version_id, ord, type, html, needs_initials, level, per_block) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
    ).bind(versionId, ord++, type, String(raw.html ?? ''), needs, level, raw.per_block ? 1 : 0).run();
  }
  return ord;
}

/**
 * The blocks an initials prompt actually attests to.
 *
 * A section is a heading plus every block up to the next heading (blocks before
 * the first heading are a preamble section of their own). The model is lifted
 * from bookSHelf's page editor, where an h2 delimits a section the same way.
 *
 * This exists because the prompt sentence is NOT the thing being agreed to. A
 * parent initialing "I have read the late work policy" is attesting to the
 * paragraph above it. Hashing only the prompt let the policy change from 10% to
 * 5% a day while the signature silently carried over -- exactly the failure the
 * whole versioning design exists to prevent.
 *
 *   - `initial` attests to its own section.
 *   - `initial` with `per_block: true` attests to its own section too -- the
 *     "per-block" refers to where the prompt is anchored (a single heading
 *     rather than one prompt per section), not to what it covers. A parent
 *     reading the prompt and signing it is still signing the whole section
 *     it sits in, heading included.
 *   - `agree` attests to the WHOLE document, because that is what its wording
 *     claims ("I have read this syllabus in full"). Strict on purpose: any
 *     change anywhere stales it. If that proves too noisy in a real term, narrow
 *     it to the sections that ask for initials rather than dropping it.
 *   - anything else attests only to itself.
 */
export function attestedBlocks(blocks, index) {
  const block = blocks[index];
  if (!block) return [];
  if (block.type === 'agree') return blocks;
  if (block.type !== 'initial') return [block];

  // Per-block OR section-wide: the prompt attests to the heading that opens
  // the section and everything underneath it, up to the next heading. The
  // difference between the two is placement (one per section vs. one per
  // heading), not scope -- a parent reading "I have read and understand
  // Late Work" is signing the whole late-work section either way.
  let start = index;
  while (start > 0 && blocks[start - 1].type !== 'heading') start--;
  if (start > 0) start--;                    // the heading opens the section
  let end = index + 1;
  while (end < blocks.length && blocks[end].type !== 'heading') end++;
  return blocks.slice(start, end);
}

/**
 * The hash recorded against a signature: every block the prompt covers, in
 * order, type included so a prompt and a paragraph with identical text cannot
 * collide.
 */
export function attestationHash(blocks, index) {
  return sha256Hex(attestedBlocks(blocks, index).map((b) => `${b.type}:${b.html}`).join('\n'));
}

/** Attestation hashes of every prompt in a version, as a set. */
async function promptAttestations(blocks) {
  const out = new Set();
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].needs_initials) out.add(await attestationHash(blocks, i));
  }
  return out;
}

/**
 * What changed between two versions, by block text.
 *
 * Matching is on content hash rather than block id: publishing clones rows, so
 * ids never survive a version boundary, but the text is exactly what a parent
 * agreed to. Sections whose text is unchanged keep their signatures; the ones
 * listed here are the only ones worth re-requesting initials on.
 */
export async function diffVersions(db, fromVersionId, toVersionId) {
  const [before, after] = await Promise.all([
    fromVersionId ? blocksOf(db, fromVersionId) : Promise.resolve([]),
    blocksOf(db, toVersionId),
  ]);

  const hash = async (b) => `${b.type}:${await sha256Hex(b.html)}`;
  const beforeHashes = new Set(await Promise.all(before.map(hash)));
  const afterHashes = new Set(await Promise.all(after.map(hash)));

  const added = [];
  for (const b of after) {
    if (!beforeHashes.has(await hash(b))) added.push({ type: b.type, html: b.html, needs_initials: b.needs_initials });
  }
  const removed = [];
  for (const b of before) {
    if (!afterHashes.has(await hash(b))) removed.push({ type: b.type, html: b.html });
  }

  // Re-signing is judged on what each prompt ATTESTS TO, not on the prompt's
  // own text. A prompt whose wording is untouched still goes stale when the
  // policy above it is rewritten -- that is the whole point of the section
  // model above.
  const beforeAttestations = await promptAttestations(before);
  let resignRequired = 0;
  for (let i = 0; i < after.length; i++) {
    if (after[i].needs_initials && !beforeAttestations.has(await attestationHash(after, i))) resignRequired++;
  }

  return {
    added,
    removed,
    unchanged: after.length - added.length,
    resign_required: resignRequired,
  };
}

/**
 * What identifies one prompt across a version boundary.
 *
 * The attestation hash alone is not enough, and the reason is in attestedBlocks
 * above: a prompt attests to its whole SECTION, so two prompts sitting in one
 * section -- which per_block exists precisely to allow -- produce the identical
 * hash. Keyed on the hash alone, initialing "I have read the late work policy"
 * would silently satisfy "I have read the attendance policy" beside it, and the
 * teacher's count would read 1 of 2 forever.
 *
 * So the key is the span PLUS the prompt's own sentence. Same words above it
 * and same words in it means the same attestation; either one moving breaks the
 * match and initials are asked for again.
 *
 * The hash is fixed-length hex, so a plain concatenation is unambiguous no
 * matter what the prompt text contains.
 */
export const attestationKey = (hash, promptHtml) => `${hash}:${promptHtml}`;

/**
 * The key of every prompt in a version, in document order.
 *
 * `null` for blocks that ask for nothing, so the array lines up index-for-index
 * with the blocks it was computed from and a caller can ask about block i
 * without keeping a second map.
 */
export async function promptKeys(blocks) {
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    out.push(blocks[i].needs_initials
      ? attestationKey(await attestationHash(blocks, i), blocks[i].html)
      : null);
  }
  return out;
}

/**
 * Everything this account has ever attested to, keyed by attestation hash.
 *
 * THIS IS WHAT MAKES AN AMENDMENT AN AMENDMENT RATHER THAN A RE-SIGNING.
 *
 * Publishing clones every block into a new version, so ids never survive the
 * boundary. Matching a signature by `version_id + block_id` therefore finds
 * nothing the moment a new version goes live, and a parent who was asked to
 * initial one changed paragraph was instead asked to initial the whole syllabus
 * again -- which is both a worse experience and a worse record, because the
 * second signature says nothing the first did not already say.
 *
 * The hash is the right key because it is exactly what was agreed to:
 * `block_hash` on a signature is attestationHash() over the whole section, so
 * an identical hash means identical text, and a signature on it is still a true
 * statement about the new version. Change one word of that section and the hash
 * moves, the carry-forward stops, and initials are asked for again -- which is
 * the entire point of hashing the section rather than the prompt sentence.
 *
 * Returns Map<attestationKey, { initials, signed_at, version_num }> -- the
 * ORIGINAL signing, not a copy of it. Nothing is written here; a carried
 * signature is the same row it always was, read through a different key.
 */
export async function attestedByAccount(db, accountId, role) {
  const { results } = await db.prepare(
    // The FIRST time they agreed to this text, and the rest of that same row.
    //
    // Exactly one MIN() in the query, which is load-bearing: SQLite guarantees
    // that when a query has a single min() or max() aggregate, the bare columns
    // beside it come from the row that produced it. So `initials` and `v.num`
    // are the ones belonging to that original signing, not values picked
    // independently. Adding a second aggregate here would quietly break that
    // and could print one signing's date beside another's initials -- on the
    // page a school hands to a parent who is disputing what they agreed to.
    // `b.html` is the prompt's own sentence, joined back through the block the
    // signature was written against. Those rows outlive their version -- nothing
    // deletes a published version's blocks -- so the sentence is still readable
    // however long ago it was signed.
    `SELECT s.block_hash,
            b.html           AS prompt,
            MIN(s.signed_at) AS signed_at,
            s.initials       AS initials,
            v.num            AS version_num
       FROM signatures s
       JOIN versions v ON v.id = s.version_id
       JOIN blocks   b ON b.id = s.block_id
      WHERE s.account_id = ?1 AND s.role = ?2
      GROUP BY s.block_hash, b.html`,
  ).bind(accountId, role).all();

  return new Map((results ?? []).map((r) => [attestationKey(r.block_hash, r.prompt), {
    initials: r.initials, signed_at: r.signed_at, version_num: r.version_num,
  }]));
}
