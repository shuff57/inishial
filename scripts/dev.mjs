// Local dev server. `npm run local` -- no wrangler, no Cloudflare account,
// no dependencies.
//
// Runs the real Function handlers against a real SQLite file behind the same
// D1 shim the tests use, and serves public/ statically. It is a convenience
// for looking at the UI, not a substitute for `wrangler pages dev`: the
// Workers runtime is the thing that ships, and platform differences only show
// up there. Deploy early enough to find them.
//
// Dev-only shortcut, called out because it would be a hole in production:
// admin requests are stamped with an Access identity so /api/admin/* works
// without Cloudflare Access in front of it.

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { d1 } from '../tests/helpers.mjs';
import { hashCode } from '../functions/_lib/codes.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8788);
const DB_FILE = join(ROOT, '.dev.sqlite');
const DEV_ADMIN = 'teacher@school.edu';
const DEMO_CODE = 'DEMO2345';

// ---- database ----

const fresh = !existsSync(DB_FILE);
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON;');
if (fresh) db.exec(readFileSync(join(ROOT, 'migrations/0001_init.sql'), 'utf8'));

const env = {
  DB: d1(db),
  SESSION_SECRET: 'local-dev-secret-do-not-use-in-production',
  ADMIN_EMAILS: DEV_ADMIN,
  OLLAMA_HOST: process.env.OLLAMA_HOST || 'https://ollama.com',
  OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || '',
};

async function seed() {
  if (db.prepare('SELECT COUNT(*) AS n FROM courses').get().n) return;

  const courseId = Number(db.prepare('INSERT INTO courses (name, created_at) VALUES (?, ?)')
    .run('Algebra I', Math.floor(Date.now() / 1000)).lastInsertRowid);

  // Parent emails come from the roster export, as they would in reality.
  // Robert has none on file, so /register's fallback path is exercisable.
  const students = [
    ['904511', 'Maria', 'Alvarez', '3', 'alvarez.family@example.com'],
    ['904512', 'Kevin', 'Chen', '3', 'k.chen.parent@example.com'],
    ['904513', 'Robert', 'Doyle', '4', null],
  ];
  const rosterIds = students.map(([extId, first, last, period, parentEmail]) =>
    Number(db.prepare(
      "INSERT INTO roster (course_id, period, student_ext_id, first, last, parent_email, status) VALUES (?, ?, ?, ?, ?, ?, 'active')",
    ).run(courseId, period, extId, first, last, parentEmail).lastInsertRowid));

  // Maria is already registered and has a code, so the sign flow is clickable
  // immediately. Kevin and Robert are left unregistered to exercise /register.
  db.prepare(
    'INSERT INTO accounts (roster_id, username, code_hash, code_issued_at, parent_email, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(rosterIds[0], 'malvarez', await hashCode(DEMO_CODE), 1000, null, 1000);

  const syllabusId = Number(db.prepare('INSERT INTO syllabi (course_id, title, slug) VALUES (?, ?, ?)')
    .run(courseId, 'Algebra I — Course Syllabus', 'algebra-i').lastInsertRowid);
  const versionId = Number(db.prepare('INSERT INTO versions (syllabus_id, num, published_at) VALUES (?, 1, ?)')
    .run(syllabusId, Math.floor(Date.now() / 1000)).lastInsertRowid);

  const blocks = [
    ['heading', '<h2>Welcome to Algebra I</h2>', 0],
    ['text', '<p>This course covers linear equations, systems, quadratics, and an introduction to functions. We meet daily and most work is completed in class.</p>', 0],
    ['heading', '<h2>Late work</h2>', 0],
    ['text', '<p>Assignments turned in after the due date lose 10% per school day, to a floor of 50%. Work more than two weeks late is not accepted without a documented absence.</p>', 0],
    ['initial', 'I have read and understand the late work policy.', 1],
    ['heading', '<h2>Attendance</h2>', 0],
    ['text', '<p>Attendance is taken daily. Three unexcused tardies equal one absence. Students are responsible for work missed during any absence.</p>', 0],
    ['initial', 'I have read and understand the attendance policy.', 1],
    ['heading', '<h2>Academic honesty</h2>', 0],
    ['text', '<p>Work submitted must be your own. Copying, sharing answers, and unattributed AI use are all handled as academic dishonesty and reported to administration.</p>', 0],
    ['initial', 'I have read and understand the academic honesty policy.', 1],
    ['heading', '<h2>Materials</h2>', 0],
    ['text', '<ul><li>A charged Chromebook, daily</li><li>Pencil and lined paper</li><li>A scientific calculator (borrowing one from the classroom set is fine)</li></ul>', 0],
    ['agree', 'I have read this syllabus in full and agree to its terms.', 1],
  ];
  blocks.forEach(([type, html, needs], i) => {
    db.prepare('INSERT INTO blocks (version_id, ord, type, html, needs_initials) VALUES (?, ?, ?, ?, ?)')
      .run(versionId, i, type, html, needs);
  });
}

// ---- routes ----

const ROUTES = {
  '/api/register': () => import('../functions/api/register.js'),
  '/api/sign/login': () => import('../functions/api/sign/login.js'),
  '/api/sign/syllabus': () => import('../functions/api/sign/syllabus.js'),
  '/api/sign/initial': () => import('../functions/api/sign/initial.js'),
  '/api/admin/roster': () => import('../functions/api/admin/roster.js'),
  '/api/admin/credentials': () => import('../functions/api/admin/credentials.js'),
  '/api/admin/syllabus': () => import('../functions/api/admin/syllabus.js'),
  '/api/admin/suggest': () => import('../functions/api/admin/suggest.js'),
  '/api/admin/progress': () => import('../functions/api/admin/progress.js'),
  '/api/admin/login': () => import('../functions/api/admin/login.js'),
  '/admin/signed': () => import('../functions/admin/signed.js'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function toRequest(req) {
  const url = `http://localhost:${PORT}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v) headers.set(k, String(v));
  // Access is NOT faked by default any more: the app has its own teacher login,
  // so a local run exercises the same gate production uses. Set
  // DEV_FAKE_ACCESS=1 to simulate Cloudflare Access sitting in front instead.
  if (process.env.DEV_FAKE_ACCESS === '1' && /^\/(api\/)?admin\//.test(req.url)) {
    headers.set('Cf-Access-Authenticated-User-Email', DEV_ADMIN);
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Promise((resolve) => {
    if (!hasBody) return resolve(new Request(url, { method: req.method, headers }));
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(new Request(url, { method: req.method, headers, body: Buffer.concat(chunks) })));
  });
}

async function send(res, response) {
  const headers = {};
  for (const [k, v] of response.headers) {
    if (k.toLowerCase() === 'set-cookie') continue;  // handled below, unfolded
    headers[k] = v;
  }
  // Set-Cookie must not be comma-joined like other headers, and every header
  // has to be in place before writeHead -- setHeader after it throws.
  //
  // Secure cookies are accepted on localhost by current browsers, so the
  // production cookie attributes are left untouched here.
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers['Set-Cookie'] = cookies;

  const body = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, headers);
  res.end(body);
}

function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  // normalize() collapses any ../ before it can escape PUBLIC.
  const file = join(PUBLIC, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC) || !existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}

await seed();

// Local admin password. Obvious on purpose -- production uses a generated one
// held in the ADMIN_PASSWORD_HASH secret.
const DEV_PASSWORD = process.env.DEV_PASSWORD || 'localdev';
env.ADMIN_PASSWORD_HASH = await hashCode(DEV_PASSWORD);

createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  const route = ROUTES[path];

  if (!route) return serveStatic(res, req.url);

  try {
    const mod = await route();
    const handler = mod[`onRequest${req.method[0]}${req.method.slice(1).toLowerCase()}`];
    if (!handler) {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `${req.method} not allowed on ${path}` }));
      return;
    }
    await send(res, await handler({ request: await toRequest(req), env }));
  } catch (err) {
    console.error(`${req.method} ${path} failed:`, err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
}).listen(PORT, () => {
  console.log(`
  iniSHial — No backpack required.

  http://localhost:${PORT}/              landing
  http://localhost:${PORT}/register/     student sign-up   (try ID 904512, last name Chen)
  http://localhost:${PORT}/sign/         parent signing    (ID 904511, code ${DEMO_CODE})
  http://localhost:${PORT}/admin/login/  teacher sign-in   (password ${DEV_PASSWORD})

  Database: .dev.sqlite  (delete it to reseed)
`);
});
