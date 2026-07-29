// GET /api/admin/models   -- what this Ollama host will actually run
//
// So the model is a choice in the editor rather than a redeploy. gpt-oss:120b
// is a reasonable default and a bad thing to be stuck with: it is slow to cold
// start, and a syllabus is short enough that a smaller model often answers as
// well in a fraction of the time.
//
// Fails soft like everything else on this path. No key, no host, a host that
// does not implement /api/tags -- the editor falls back to a free-text box and
// the default still works.

import { json, unauthorized, requireAdmin } from '../../_lib/http.js';
import { MODEL, ollamaBase } from '../../_lib/ollama.js';

const TIMEOUT_MS = 10_000;

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return unauthorized();

  const configured = env.OLLAMA_MODEL || MODEL;
  if (!env.OLLAMA_API_KEY) return json({ available: false, models: [], configured });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ollamaBase(env)}/api/tags`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${env.OLLAMA_API_KEY}` },
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return json({ available: false, models: [], configured });

    const body = await res.json();
    const listed = (Array.isArray(body?.models) ? body.models : [])
      .map((m) => String(m?.name ?? m?.model ?? ''))
      .filter((name) => isModelName(name));

    // The configured default is always offered, even if the host does not list
    // it -- ollama.com's /api/tags and the models it will actually run are not
    // guaranteed to be the same set, and dropping the working default off the
    // list would look like it had stopped existing.
    if (!listed.includes(configured)) listed.push(configured);

    return json({ ...group(listed, configured), configured });
  } catch {
    return json({ available: false, groups: [], configured });
  }
}

/* ---- turning a host's list into a menu ----
 *
 * Nineteen names in one flat alphabetical list is a menu you have to already
 * know the answer to. Two things fix that, and both are done here rather than
 * in the editor so there is one place that decides.
 */

const TIERS = [
  { id: 'smartest', label: 'Smartest — slower, best on messy documents' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'fastest', label: 'Fastest — good enough for most syllabi' },
];

/**
 * Split a name into the three things that matter: what it is, which version,
 * and which variant.
 *
 *   glm-5.2             -> glm            5.2   -        -
 *   kimi-k2.7-code      -> kimi-k         2.7   code     -
 *   nemotron-3-nano:30b -> nemotron       3     nano     30b
 *   gpt-oss:120b        -> gpt-oss        -     -        120b
 */
export function parseModel(name) {
  const [base, tag = ''] = String(name).split(':');
  const m = /^(.*?)-?(\d+(?:\.\d+)*)(?:-(.*))?$/.exec(base);
  return m
    ? { family: m[1], version: m[2], variant: m[3] || '', tag }
    : { family: base, version: '', variant: '', tag };
}

const versionOrder = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  }
  return 0;
};

/**
 * Drop superseded versions -- glm-5.1 once glm-5.2 is there.
 *
 * A version is NOT a variant, and conflating them is the whole difficulty:
 * gpt-oss:20b does not supersede gpt-oss:120b, and deepseek-v4-flash does not
 * supersede deepseek-v4-pro. So models are bucketed by everything EXCEPT the
 * version, and only within a bucket does the highest number win.
 *
 * The configured default always survives, whatever its number: it is what runs
 * when nothing is chosen, and a menu that cannot name the model you are
 * actually using is worse than one carrying an old version.
 */
export function shortlist(names, configured = '') {
  const best = new Map();
  for (const name of names) {
    const p = parseModel(name);
    const key = `${p.family}|${p.variant}|${p.tag}`;
    const held = best.get(key);
    if (!held || versionOrder(p.version, parseModel(held).version) > 0) best.set(key, name);
  }
  const kept = new Set(best.values());
  if (configured) kept.add(configured);
  return names.filter((n) => kept.has(n));
}

/**
 * Which of the three shelves a model belongs on.
 *
 * Read off the NAME -- a parameter count in the tag, or a word the vendor uses
 * to mean small or large. That is a heuristic, not a benchmark, and it is meant
 * to be edited: if a model lands on the wrong shelf, the fix is a word in one
 * of these two lists.
 */
const FAST = /\b(flash|nano|mini|lite|air|small|turbo)\b/;
const SMART = /\b(ultra|pro|max|large|xl|opus)\b/;

export function tierOf(name) {
  const p = parseModel(name);
  const words = `${p.family} ${p.variant}`.replace(/[-_]/g, ' ');
  if (FAST.test(words)) return 'fastest';
  if (SMART.test(words)) return 'smartest';
  const billions = /^(\d+)b$/i.exec(p.tag);
  if (billions) {
    const n = Number(billions[1]);
    if (n <= 40) return 'fastest';
    if (n >= 200) return 'smartest';
  }
  return 'balanced';
}

function group(names, configured) {
  const kept = shortlist(names, configured).sort((a, b) => a.localeCompare(b));
  const groups = TIERS
    .map(({ id, label }) => ({ id, label, models: kept.filter((n) => tierOf(n) === id) }))
    .filter((g) => g.models.length > 0);
  return { available: kept.length > 0, groups };
}

/**
 * A model name, or not.
 *
 * Whatever passes this is interpolated into a URL path by no one and into a
 * JSON body by streamChat, so the risk is low -- but the value arrives from a
 * request, and an unbounded string in a field the server sends onward is worth
 * closing off on principle rather than after someone finds a use for it.
 */
export const isModelName = (name) => /^[a-z0-9][a-z0-9._:\/-]{0,63}$/i.test(name);
