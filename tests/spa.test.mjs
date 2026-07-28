// The public side is one document served at three URLs. If these rewrites stop
// working, /sign/ 404s -- and /sign/ is the link a teacher mails to every
// parent, so it is the one URL in the app that must never break.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet as signPage } from '../functions/sign/[[path]].js';
import { onRequestGet as registerPage } from '../functions/register/[[path]].js';

/** A stand-in for the Pages asset server. Records what was asked for. */
function assetEnv(seen) {
  return {
    ASSETS: {
      fetch(request) {
        const path = new URL(request.url).pathname;
        seen.push(path);
        // The real asset server 308s /index.html to /. If the handler ever asks
        // for the file by name again, this makes the test fail the way
        // production did rather than passing quietly.
        if (path === '/index.html') {
          return new Response('', { status: 308, headers: { location: '/' } });
        }
        return new Response('<!doctype html><html><body>the app</body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html' } });
      },
    },
  };
}

for (const [name, handler, path] of [
  ['/sign/', signPage, 'https://x/sign/'],
  ['/register/', registerPage, 'https://x/register/'],
]) {
  test(`${name} serves the single-page app`, async () => {
    const seen = [];
    const res = await handler({ request: new Request(path), env: assetEnv(seen) });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ['/'], 'must fetch / — asking for /index.html gets a 308 to /');
    assert.match(await res.text(), /the app/);
  });

  test(`${name} rewrites rather than redirecting`, async () => {
    const res = await handler({ request: new Request(path), env: assetEnv([]) });
    assert.equal(res.status, 200,
      'a 3xx would change the address bar, and the URL is what app.js reads the view from');
    assert.equal(res.headers.get('location'), null);
  });
}

test('the query string survives the rewrite', async () => {
  const seen = [];
  const res = await signPage({ request: new Request('https://x/sign/?course=2'), env: assetEnv(seen) });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ['/']);
});
