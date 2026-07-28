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
    const models = (Array.isArray(body?.models) ? body.models : [])
      .map((m) => String(m?.name ?? m?.model ?? ''))
      .filter((name) => isModelName(name))
      .sort((a, b) => a.localeCompare(b));

    // The configured default is always offered, even if the host does not list
    // it -- ollama.com's /api/tags and the models it will actually run are not
    // guaranteed to be the same set, and dropping the working default off the
    // list would look like it had stopped existing.
    if (!models.includes(configured)) models.unshift(configured);

    return json({ available: models.length > 0, models, configured });
  } catch {
    return json({ available: false, models: [], configured });
  }
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
