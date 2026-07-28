// Hand back the single-page app shell for a URL that is not its own document.
//
// Fetch '/', not '/index.html'. The asset server 308s /index.html to /, and
// that redirect reaches the browser -- so asking for the file by name lands the
// reader on the home page with the address bar changed. Returning a fresh
// Response with the location header stripped makes sure no redirect can leak
// out either way.
//
// A rewrite, never a redirect: the address bar has to keep saying /sign/,
// because app.js reads which view to show from location.pathname.
export async function serveApp(context) {
  const shell = new URL(context.request.url);
  shell.pathname = '/';
  const res = await context.env.ASSETS.fetch(
    new Request(shell, { headers: context.request.headers }));
  const headers = new Headers(res.headers);
  headers.delete('location');
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(res.body, { status: 200, headers });
}
