// The public side is one document served at three URLs.
//
// Two things this has to get right, both learned the hard way against the real
// platform:
//
//   1. Fetch '/', not '/index.html'. The asset server normalises /index.html to
//      / with a 308, and that redirect reaches the browser -- so asking for the
//      file by name lands the reader on the home page with the address bar
//      changed. Returning a fresh Response makes sure no redirect leaks either
//      way.
//   2. Match the trailing slash. A route file only claims its exact path, so
//      functions/sign/index.js answers /sign and lets /sign/ fall through to a
//      404. /sign/ is the form a teacher's email actually contains, so these
//      are [[path]] catch-alls.
//
// It is a rewrite, never a redirect: the address bar has to keep saying /sign/,
// because app.js reads which view to show from location.pathname.
export async function serveApp(context) {
  const url = new URL(context.request.url);
  url.pathname = '/';
  const res = await context.env.ASSETS.fetch(new Request(url, { headers: context.request.headers }));
  const headers = new Headers(res.headers);
  headers.delete('location');
  return new Response(res.body, { status: 200, headers });
}
