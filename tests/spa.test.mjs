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
