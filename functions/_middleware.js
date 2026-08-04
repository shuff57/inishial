// The public side is one document served at three URLs.
//
// This is root middleware rather than route files because route matching turned
// out to be the unreliable part: functions/sign/index.js answered /sign but let
// /sign/ 404, the [[path]] form behaved differently again, and the two paths
// disagreed with each other across deploys. Middleware runs for every request,
// so the rewrite either happens or it does not -- there is no matching to get
// wrong. Everything else falls through to next() untouched.
//
// /sign/ is the link a teacher mails to every parent. It is the one URL in this
// app that must never 404, and it shipped broken twice before this.

import { serveApp } from './_lib/spa.js';

// The production pages.dev hostname redirects to the custom domain, so parents
// only ever see one address and the link in their access-code email sits on the
// same registrable domain as the address it was sent from.
//
// EXACTLY this hostname, never `.endsWith('.pages.dev')`: preview deployments
// are served at <hash>.inishial.pages.dev, and bouncing those to production
// would make it impossible to check a build before promoting it.
const LEGACY_HOST = 'inishial.pages.dev';

// 302, not 301/308. Browsers cache a permanent redirect indefinitely, and the
// canonical hostname is a day old -- if it changes again, anyone who visited
// the old one is stuck pointing at a name that no longer serves. Tighten to 308
// once the hostname has settled; 308 rather than 301 because this also covers
// POSTs to /api, and 301 would rewrite those to GET.
const REDIRECT_STATUS = 302;

// The path is trailing-slash-stripped before the lookup, so one entry covers
// both /register/code and /register/code/.
const SHELL_PATHS = new Set(['/sign', '/register', '/register/code']);
// HEAD as well as GET. Gating on GET alone made HEAD /sign a 404, which is the
// request link checkers, previews and crawlers actually send -- so the URL in a
// teacher's email would have looked broken to everything except a browser.
const PAGE_METHODS = new Set(['GET', 'HEAD']);

export async function onRequest(context) {
  const url = new URL(context.request.url);

  // Canonical host first, so nothing else answers on the old hostname. The
  // target comes from APP_URL, the same var the mailed link is built from --
  // one place to change, and no way for the two to drift apart.
  if (url.hostname === LEGACY_HOST && context.env.APP_URL) {
    const canonical = new URL(context.env.APP_URL);
    if (canonical.hostname !== LEGACY_HOST) {
      url.hostname = canonical.hostname;
      url.protocol = canonical.protocol;
      url.port = '';
      return Response.redirect(url.toString(), REDIRECT_STATUS);
    }
  }

  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (PAGE_METHODS.has(context.request.method) && SHELL_PATHS.has(path)) return serveApp(context);
  return context.next();
}
