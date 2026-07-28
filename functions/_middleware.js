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

const SHELL_PATHS = new Set(['/sign', '/register']);

export async function onRequest(context) {
  const path = new URL(context.request.url).pathname.replace(/\/+$/, '') || '/';
  if (context.request.method === 'GET' && SHELL_PATHS.has(path)) return serveApp(context);
  return context.next();
}
