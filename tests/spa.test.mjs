// The public side is one document served at three URLs. If these rewrites stop
// working, /sign/ 404s -- and /sign/ is the link a teacher mails to every
// parent, so it is the one URL in the app that must never break. It shipped
// broken twice before these tests existed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as middleware } from '../functions/_middleware.js';

/** A stand-in for the Pages asset server. Records what was asked for, and 308s
 *  /index.html to / exactly as the real one does -- that redirect reaching the
 *  browser is what sent readers to the home page with the address bar wrong. */
function assetEnv(seen) {
  return {
    ASSETS: {
      fetch(request) {
        const path = new URL(request.url).pathname;
        seen.push(path);
        if (path === '/index.html') {
          return new Response('', { status: 308, headers: { location: '/' } });
        }
        return new Response('<!doctype html><html><body>the app</body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html' } });
      },
    },
  };
}

const FELL_THROUGH = 599;

async function run(url, method = 'GET') {
  const seen = [];
  const res = await middleware({
    request: new Request(url, { method }),
    env: assetEnv(seen),
    next: () => new Response('fell through', { status: FELL_THROUGH }),
  });
  return { res, seen };
}

// Both slash forms: /sign/ is what a teacher's email contains, /sign is what a
// browser or a link shortener may normalise it to. A route file answered one
// and 404'd the other, which is why this is middleware.
for (const path of ['/sign', '/sign/', '/register', '/register/',
                    '/register/code', '/register/code/']) {
  test(`${path} serves the single-page app`, async () => {
    const { res, seen } = await run('https://x' + path);
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ['/'], 'must fetch / — asking for /index.html gets a 308 to /');
    assert.match(await res.text(), /the app/);
  });

  test(`${path} rewrites rather than redirecting`, async () => {
    const { res } = await run('https://x' + path);
    assert.equal(res.status, 200,
      'a 3xx would change the address bar, and app.js reads the view from the URL');
    assert.equal(res.headers.get('location'), null);
    assert.match(res.headers.get('Content-Type') ?? '', /text\/html/);
  });
}

test('the query string survives the rewrite', async () => {
  const { res, seen } = await run('https://x/sign/?from=email');
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ['/']);
});

// Everything else must be untouched. Middleware runs on every request, so a
// greedy match here would swallow the API and the admin pages.
for (const path of ['/', '/404.html', '/app.css', '/admin/', '/admin/login/',
  '/api/sign/syllabus', '/api/admin/roster', '/signature', '/registered']) {
  test(`${path} falls through to the normal handler`, async () => {
    const { res, seen } = await run('https://x' + path);
    assert.equal(res.status, FELL_THROUGH, `${path} was swallowed by the shell rewrite`);
    assert.deepEqual(seen, [], 'the asset server should not have been touched');
  });
}

test('HEAD gets the same answer as GET', async () => {
  // Link checkers, chat previews and crawlers send HEAD. Gating the rewrite on
  // GET alone made HEAD /sign a 404, so the link in a teacher's email looked
  // broken to everything except a browser.
  const { res } = await run('https://x/sign/', 'HEAD');
  assert.equal(res.status, 200);
});

test('a POST to /sign/ is not rewritten', async () => {
  // Only GET renders a page. Rewriting a POST would silently turn a form
  // submission into a 200 HTML response and lose the request.
  const { res } = await run('https://x/sign/', 'POST');
  assert.equal(res.status, FELL_THROUGH);
});

// ---- dev server / production routing parity ----

test('every Function file is reachable in the dev server too', async () => {
  // Cloudflare Pages routes Functions by FILE PATH. scripts/dev.mjs cannot --
  // it is a plain node server with a hand-written ROUTES table -- so a new
  // endpoint works in production and 404s locally until someone remembers to
  // add it. That is a bad failure: it looks like the code is broken when the
  // routing is, and the test suite cannot see it at all because tests import
  // the handlers directly rather than going through either router.
  //
  // Caught exactly once, by hand, when /api/admin/reset returned "Not found"
  // from a dev server while all of its unit tests passed.
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join, relative, sep } = await import('node:path');

  // Windows hands back both a leading-slash drive path and backslash
  // separators; routes are neither.
  const toPosix = (p) => p.split(sep).join('/');
  const root = new URL('../functions/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const found = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      // `_lib`, `_middleware.js` -- Pages treats a leading underscore as
      // "not a route", and so does this.
      if (entry.startsWith('_')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.js')) found.push('/' + toPosix(relative(root, full)).replace(/\.js$/, ''));
    }
  }(root));

  const dev = readFileSync(new URL('../scripts/dev.mjs', import.meta.url), 'utf8');
  const missing = found.filter((route) => !dev.includes(`'${route}':`));
  assert.deepEqual(missing, [],
    `add these to ROUTES in scripts/dev.mjs, or they 404 in local dev only:\n  ${missing.join('\n  ')}`);
});
