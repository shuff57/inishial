// The public side is one document served at three URLs.
//
// public/_redirects with a 200 rewrite was the obvious way to do this and it
// did not work -- a fresh deployment still 404'd on /sign/. Functions are
// deterministic, they run in the same runtime as the rest of the API, and they
// can be exercised by the test suite, so the rewrite lives here instead.
//
// A rewrite, never a redirect: the address bar has to keep saying /sign/,
// because that is the link in a parent's inbox and app.js reads the view from
// location.pathname.
export function serveApp(context) {
  const url = new URL(context.request.url);
  url.pathname = '/index.html';
  return context.env.ASSETS.fetch(new Request(url, context.request));
}
