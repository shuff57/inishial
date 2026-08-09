// POST /api/sign/initial   -- record initials against one section
//
// Body: { block_id, initials }
//
// The signature row is the legal artifact, so everything recorded here is
// derived server-side. The client supplies only which block and what initials;
// the block text, its hash, the timestamp, the account, and the role all come
// from the session and the database.
//
// claims.sub is now an identity id. The block determines the course, and
// identity + course determines the account. A tampered/foreign block id
// resolves to nothing, never to someone else's account.

import { json, badRequest, unauthorized, serverMisconfigured, readJson } from '../../_lib/http.js';
import { currentSigner } from '../../_lib/session.js';
import { blocksOf, attestationHash } from '../../_lib/syllabus.js';

// Initials, not a name: letters, optional dots, 1-6 characters.
const INITIALS_RE = /^[\p{L}][\p{L}.]{0,5}$/u;

export async function onRequestPost({ request, env }) {
  if (!env.DB) return serverMisconfigured('the DB binding');

  const nowSec = Math.floor(Date.now() / 1000);
  // Authentic, unexpired, a signer rather than a teacher, and not signed out.
  const claims = await currentSigner(request, env, nowSec);
  if (!claims) return unauthorized();

  const body = await readJson(request);
  if (!body) return badRequest('Expected a JSON body.');

  const blockId = Number(body.block_id);
  const initials = String(body.initials ?? '').trim().toUpperCase();
  if (!Number.isInteger(blockId)) return badRequest('block_id is required.');
  if (!INITIALS_RE.test(initials)) return badRequest('Enter your initials (letters only).');

  // One query establishes all of: the block exists, it belongs to a PUBLISHED
  // version, that version's syllabus belongs to a course this identity is
  // enrolled in, and the block actually asks for initials. A block id from
  // another class fails here because identity + course resolves to no account.
  const block = await env.DB.prepare(
    `SELECT b.id, b.html, b.needs_initials, v.id AS version_id, a.id AS account_id
       FROM blocks b
       JOIN versions v ON v.id = b.version_id AND v.published_at IS NOT NULL
       JOIN syllabi  s ON s.id = v.syllabus_id
       JOIN roster   r ON r.course_id = s.course_id
       JOIN accounts a ON a.roster_id = r.id AND a.identity_id = ?1
      WHERE b.id = ?2
      LIMIT 1`,
  ).bind(claims.sub, blockId).first();

  if (!block) return json({ error: 'That section is not part of your syllabus.' }, 404);
  if (!block.needs_initials) return badRequest('That section does not ask for initials.');

  // Hash the stored text, never anything the client sent, and hash the whole
  // SECTION rather than the prompt sentence -- see attestedBlocks(). Initialing
  // "I have read the late work policy" is an attestation about the paragraph
  // above it, so that paragraph is what the signature has to pin.
  const versionBlocks = await blocksOf(env.DB, block.version_id);
  const blockHash = await attestationHash(versionBlocks, versionBlocks.findIndex((b) => b.id === blockId));

  const existing = await env.DB.prepare(
    `SELECT initials, signed_at FROM signatures
      WHERE account_id = ?1 AND version_id = ?2 AND block_id = ?3 AND role = ?4`,
  ).bind(block.account_id, block.version_id, blockId, claims.role).first();

  // Signatures are append-only: a second submission reports the first rather
  // than overwriting it. Re-initialing happens by publishing a new version.
  if (existing) {
    return json({ ok: true, already_signed: true, initials: existing.initials, signed_at: existing.signed_at });
  }

  await env.DB.prepare(
    `INSERT INTO signatures
       (account_id, version_id, block_id, role, initials, block_hash, signed_at, ip, user_agent)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(
    block.account_id,
    block.version_id,
    blockId,
    claims.role,
    initials,
    blockHash,
    nowSec,
    request.headers.get('CF-Connecting-IP') || null,
    (request.headers.get('User-Agent') || '').slice(0, 400) || null,
  ).run();

  const progress = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM blocks WHERE version_id = ?1 AND needs_initials = 1) AS required,
       (SELECT COUNT(*) FROM signatures
          WHERE account_id = ?2 AND version_id = ?1 AND role = ?3)                AS signed`,
  ).bind(block.version_id, block.account_id, claims.role).first();

  return json({
    ok: true,
    initials,
    signed_at: nowSec,
    progress: { signed: progress?.signed ?? 0, required: progress?.required ?? 0 },
    complete: (progress?.signed ?? 0) >= (progress?.required ?? 0),
  }, 201);
}
