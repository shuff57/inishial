// Fixed-window rate limiter over D1.
//
// Load-bearing, not defensive: the syllabus URL is public, so an 8-character
// access code is the only thing between a stranger and signing as someone's
// parent. Without this an attacker walks the keyspace at request speed.
//
// ponytail: fixed window, not sliding. A burst can straddle a boundary and get
// ~2x the limit. Irrelevant at 5/15min against a 31^8 keyspace. Swap for a
// sliding window only if that ever stops being true.

const WINDOW_SEC = 15 * 60;
const MAX_ATTEMPTS = 5;

/**
 * Count one attempt against `key`. Returns { allowed, remaining, retryAfter }.
 * Call BEFORE verifying the code, so failures and successes both cost quota.
 */
export async function hit(db, key, nowSec, { windowSec = WINDOW_SEC, max = MAX_ATTEMPTS } = {}) {
  const windowStart = Math.floor(nowSec / windowSec) * windowSec;

  // Upsert: reset the counter when the row belongs to an older window.
  await db
    .prepare(
      `INSERT INTO auth_attempts (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count        = CASE WHEN auth_attempts.window_start = ?2 THEN auth_attempts.count + 1 ELSE 1 END,
         window_start = ?2`,
    )
    .bind(key, windowStart)
    .run();

  const row = await db.prepare('SELECT count FROM auth_attempts WHERE key = ?1').bind(key).first();
  const count = row?.count ?? 1;

  return {
    allowed: count <= max,
    remaining: Math.max(0, max - count),
    retryAfter: windowStart + windowSec - nowSec,
  };
}

/** Clear the counter after a successful login so honest users aren't punished
 *  for a few typos earlier in the window. */
export async function reset(db, key) {
  await db.prepare('DELETE FROM auth_attempts WHERE key = ?1').bind(key).run();
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0].trim()
    || 'unknown';
}
