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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { d1 } from '../tests/helpers.mjs';
import { hashCode } from '../functions/_lib/codes.js';
import { sealCode } from '../functions/_lib/vault.js';
import { seedDemo } from './demo.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8788);
// DEV_DB lets several servers run at once on different ports without fighting
// over one file. The recorders in scripts/record/ each get their own.
const DB_FILE = process.env.DEV_DB ? join(ROOT, process.env.DEV_DB) : join(ROOT, '.dev.sqlite');
const DEV_ADMIN = 'teacher@school.edu';
const DEMO_CODE = 'DEMO2345';

// ---- database ----

const fresh = !existsSync(DB_FILE);
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON;');
migrate();

/**
 * Apply every migration not yet applied to .dev.sqlite.
 *
 * The old version ran 0001 on a fresh file and nothing otherwise, so adding a
 * migration silently skipped every developer who already had a database --
 * including one holding a real imported syllabus, which is exactly the file
 * nobody wants to delete to pick up a schema change.
 */
function migrate() {
  const dir = join(ROOT, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  db.exec('CREATE TABLE IF NOT EXISTS dev_migrations (file TEXT PRIMARY KEY, applied_at INTEGER)');
  // A database from before this bookkeeping existed already has the initial
  // schema in it; recording that is what stops the loop re-running it.
  if (!fresh && !db.prepare('SELECT COUNT(*) AS n FROM dev_migrations').get().n) {
    db.prepare('INSERT INTO dev_migrations VALUES (?, ?)').run(files[0], 0);
  }

  for (const file of files) {
    if (db.prepare('SELECT 1 FROM dev_migrations WHERE file = ?').get(file)) continue;
    db.exec(readFileSync(join(dir, file), 'utf8'));
    db.prepare('INSERT INTO dev_migrations VALUES (?, ?)').run(file, Math.floor(Date.now() / 1000));
    if (!fresh) console.log(`  applied migration ${file}`);
  }
}

// ---- local secrets ----
//
// `.secrets.local` is gitignored and is where a key goes for local testing:
//
//   OLLAMA_API_KEY=sk-...
//
// A real environment variable still wins, so CI and one-off runs can override
// without editing the file. Nothing here is ever echoed -- the startup banner
// reports only whether a key was found.
function localSecrets() {
  const file = join(ROOT, '.secrets.local');
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const at = line.indexOf('=');
    if (at < 1) continue;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const secrets = localSecrets();

/** TEACHER_DOMAINS as configured for production. A regex rather than a TOML
 *  parser: this is one flat string in a file we control, and a dependency to
 *  read it would cost more than the whole dev server. */
function configuredDomains() {
  const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');
  return (toml.match(/^\s*TEACHER_DOMAINS\s*=\s*"([^"]*)"/m) || [])[1] || '';
}

const env = {
  DB: d1(db),
  SESSION_SECRET: 'local-dev-secret-do-not-use-in-production',
  // Seals access codes so /admin/codes/ can read them back. Fixed in dev so a
  // restart does not orphan every code in .dev.sqlite -- in production this is
  // a `wrangler secret put CODE_SECRET`, and changing it makes every existing
  // code unreadable (still valid for sign-in, just no longer displayable).
  CODE_SECRET: process.env.CODE_SECRET || 'local-dev-code-vault-do-not-use-in-production',
  ADMIN_EMAILS: DEV_ADMIN,
  // Self-service teacher sign-up. The real domain is read out of wrangler.toml
  // rather than repeated here, so testing sign-up locally exercises the same
  // allowlist production enforces -- a second copy of it would drift, and the
  // failure would be "it worked on my machine" for the one check whose whole
  // job is to refuse people.
  //
  // school.edu is appended because the seeded DEV_ADMIN lives there.
  TEACHER_DOMAINS: [configuredDomains(), 'school.edu'].filter(Boolean).join(','),
  // `.secrets.local` wins over the ambient environment for these three, which is
  // the opposite of the usual precedence and deliberate: a machine-wide
  // OLLAMA_HOST pointing at somebody's local daemon (0.0.0.0:11434) otherwise
  // silently overrides this project's key and the failure looks like a network
  // fault rather than a config one.
  OLLAMA_HOST: secrets.OLLAMA_HOST || process.env.OLLAMA_HOST || 'https://ollama.com',
  OLLAMA_API_KEY: secrets.OLLAMA_API_KEY || process.env.OLLAMA_API_KEY || '',
  OLLAMA_MODEL: secrets.OLLAMA_MODEL || process.env.OLLAMA_MODEL || '',
};

async function seed() {
  if (db.prepare('SELECT COUNT(*) AS n FROM courses').get().n) return;

  const courseId = Number(db.prepare('INSERT INTO courses (name, created_at) VALUES (?, ?)')
    .run('Algebra I', Math.floor(Date.now() / 1000)).lastInsertRowid);

  // Deliberately not people.
  //
  // These names, ID numbers and addresses appear on screen in the recordings on
  // /how/, which are public and long-lived. Anything that reads like a real
  // student invites the question of whether it is one, and a plausible name
  // beside a plausible ID beside a plausible school address is a worse thing to
  // publish than an obviously fake one -- so every field here is visibly
  // synthetic. example.com is reserved for exactly this by RFC 2606.
  //
  // Parent emails come from the roster export, as they would in reality.
  // Student C has none on file, so /register's fallback path is exercisable.
  const students = [
    ['123456', 'A', 'Student', '3', 'parent.a@example.com'],
    ['123457', 'B', 'Student', '3', 'parent.b@example.com'],
    ['123458', 'C', 'Student', '4', null],
  ];
  const rosterIds = students.map(([extId, first, last, period, parentEmail]) =>
    Number(db.prepare(
      "INSERT INTO roster (course_id, period, student_ext_id, first, last, parent_email, status) VALUES (?, ?, ?, ?, ?, ?, 'active')",
    ).run(courseId, period, extId, first, last, parentEmail).lastInsertRowid));

  // All three registered, with both codes, so /admin/codes/ has a full small
  // class to look at the moment you sign in. Student A keeps the fixed DEMO2345
  // the banner prints; the other two get codes derived from their student ID the
  // same way the demo class does, so every one of them is typeable from here
  // without looking anything up.
  //
  // /register is still exercisable -- the Biology demo class leaves three
  // students unregistered for exactly that, and the Access codes page shows
  // them as rows saying so.
  const devParent = (extId) => 'PAR' + String(extId).slice(-5);
  const devStudent = (extId) => 'STU' + String(extId).slice(-5);
  for (const [i, [extId, first, last]] of students.entries()) {
    const parentCode = i === 0 ? DEMO_CODE : devParent(extId);
    const studentCode = devStudent(extId);
    db.prepare(
      `INSERT INTO accounts (roster_id, username, code_hash, code_issued_at, parent_email, created_at,
                             student_code_hash, student_code_issued_at, code_enc, student_code_enc)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    ).run(rosterIds[i], `student${extId}@student.example.com`,
      await hashCode(parentCode), 1000, 1000,
      await hashCode(studentCode), 1000,
      await sealCode(env, parentCode), await sealCode(env, studentCode));
  }

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
  '/api/admin/structure': () => import('../functions/api/admin/structure.js'),
  '/api/admin/progress': () => import('../functions/api/admin/progress.js'),
  '/api/admin/login': () => import('../functions/api/admin/login.js'),
  '/api/admin/signup': () => import('../functions/api/admin/signup.js'),
  '/api/admin/models': () => import('../functions/api/admin/models.js'),
  '/admin/signed': () => import('../functions/admin/signed.js'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
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

  res.writeHead(response.status, headers);
  if (!response.body) { res.end(); return; }

  // Piped, not buffered. arrayBuffer() waits for the last byte, which turned the
  // Ollama log into a minute of nothing followed by the whole answer at once --
  // locally indistinguishable from streaming being broken.
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

// The same rewrites functions/sign/index.js and functions/register/index.js do
// in production. This server routes /api/* to the Functions but serves
// everything else off disk, so a Function whose whole job is to serve an asset
// has to be mirrored here. If a public URL is ever added it goes in both places
// or it 404s in one of them -- which is exactly how the _redirects version got
// as far as a deploy before anyone noticed it did not work.
const REWRITES = new Map([
  ['/register', '/index.html'], ['/register/', '/index.html'],
  ['/sign', '/index.html'], ['/sign/', '/index.html'],
]);

function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  rel = REWRITES.get(rel) ?? rel;
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

// A fake class to click around in, added beside whatever is already here
// rather than instead of it -- a real imported syllabus in this database must
// survive a dev restart. DEMO_RESET=1 rebuilds it.
const demo = await seedDemo(db, {
  hashCode,
  seal: (code) => sealCode(env, code),
  reset: process.env.DEMO_RESET === '1',
});

// Built as lines rather than inline in the banner: nesting a .map().join() with
// its own newline inside a template literal is how the last two escaping bugs
// in this file happened.
const demoLines = (demo.added
  ? [
    `    ${demo.active} active students, ${demo.dropped} dropped, ${demo.codes} with codes, ${demo.signatures} signatures`,
    '    version 1 is PUBLISHED; version 2 is an open draft, ready to publish',
    // Both codes, because which one is typed is what decides whose signature
    // the session can write. Signing in twice with the same student ID and the
    // two different codes is the whole demonstration.
    '    sign in at /sign/ with a student ID and ONE of its two codes:',
    ...demo.sample.flatMap((s) => [
      `      ${s.extId}  ${s.code}  -> parent   (${s.who})`,
      `      ${s.extId}  ${s.studentCode}  -> student  (${s.who})`,
    ]),
  ]
  : ['    already present — DEMO_RESET=1 npm run local  to rebuild it']
).join('\n');

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
  http://localhost:${PORT}/register/     student sign-up   (Biology has three unregistered: 100016, 100017, 100018)
  http://localhost:${PORT}/sign/         parent or student (ID 123456 -- ${DEMO_CODE} = parent, STU23456 = student)
  http://localhost:${PORT}/admin/login/  teacher sign-in   (password ${DEV_PASSWORD})
  http://localhost:${PORT}/admin/signup/ teacher sign-up   (any @school.edu address)

  Demo class: ${demo.course}
${demoLines}

  Database: ${process.env.DEV_DB || '.dev.sqlite'}  (delete it to reseed)
  Ollama:   ${env.OLLAMA_API_KEY ? 'key loaded from .secrets.local (' + (env.OLLAMA_MODEL || 'default model') + ')' : 'no key — AI steps stay disabled, everything else works'}
`);
});
