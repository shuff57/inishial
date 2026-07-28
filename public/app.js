// The public side is one document with three views.
//
// Why one document: switching views is then a same-document change, which means
// the transition is fully under our control -- no waiting on a new page to
// paint, no snapshot of a document that is on its way out, and no flash. The
// cross-document version had to photograph the old page and hope the new one
// rendered in time; this one just moves elements it already owns.
//
// The URLs are real and unchanged. /register/ and /sign/ are what a teacher
// mails out, so the server hands back this same file for those paths (see
// public/_redirects and scripts/dev.mjs) and the router picks the view from
// location.pathname. Links in the nav stay ordinary hrefs: with JS they are
// intercepted, without it they are a full navigation to a document that still
// knows which view it is.

import { createBook, sections, sectionTitle } from './book.js';

const $ = (id) => document.getElementById(id);
const views = () => [...document.querySelectorAll('.view')];
const pathOf = (p) => (p.replace(/\/+$/, '') || '/');

const TITLES = {
  '/': 'iniSHial',
  '/register': 'Set up your account · iniSHial',
  '/sign': 'Course syllabus · iniSHial',
};

// ---- the router ----

function viewFor(path) {
  const want = pathOf(path);
  return views().find((v) => pathOf(v.dataset.path) === want) || views()[0];
}

function swap(target) {
  for (const view of views()) {
    const on = view === target;
    view.hidden = !on;
    view.inert = !on;
  }
  document.title = TITLES[pathOf(location.pathname)] || 'iniSHial';
  // The progress spine belongs to the syllabus and nothing else.
  $('progress').hidden = target.id !== 'view-sign' || !state;
  for (const a of document.querySelectorAll('header.site .nav-main a')) {
    const here = pathOf(new URL(a.getAttribute('href'), location.origin).pathname);
    a.toggleAttribute('aria-current', here === pathOf(location.pathname));
    if (here === pathOf(location.pathname)) a.setAttribute('aria-current', 'page');
  }
}

function show(path, { push = true } = {}) {
  const target = viewFor(path);
  if (push && pathOf(location.pathname) !== pathOf(path)) {
    history.pushState({}, '', path);
  }

  // No animation between views. A page turn belongs where there is a sequence
  // to turn through, and these three are not one -- they are separate tasks a
  // reader arrives at directly. Turning between them was motion for its own
  // sake, and it read as a glitch rather than a page.
  //
  // The syllabus itself still turns section by section; see book.js. That IS a
  // sequence, and it is the one a parent actually works through.
  swap(target);
  focusMain();
}

/** Move focus to the page after a view change, the way a real navigation would.
 *  Without this a keyboard user stays on the link they just followed and the
 *  next Tab continues through the nav rather than into the new view. */
function focusMain() { $('main')?.focus({ preventScroll: true }); scrollTo(0, 0); }

addEventListener('popstate', () => show(location.pathname, { push: false }));

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href]');
  if (!link || event.defaultPrevented) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  if (link.target && link.target !== '_self') return;
  const url = new URL(link.getAttribute('href'), location.origin);
  if (url.origin !== location.origin) return;
  // Only paths this document actually holds. Everything else -- /admin/, the
  // API, a download -- is a real navigation and must stay one.
  if (!views().some((v) => pathOf(v.dataset.path) === pathOf(url.pathname))) return;
  event.preventDefault();
  show(url.pathname);
});

// ---- shared ----

let state = null;
let book = null;

function notice(el, text, kind) {
  el.hidden = false;
  el.className = 'notice ' + kind;
  el.textContent = text;
}

// ---- registering ----

$('registerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const msg = $('registerMsg');
  const submit = $('registerBtn');
  msg.hidden = true;
  submit.disabled = true;
  submit.textContent = 'Checking…';

  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(form).entries())),
    });
    const body = await res.json();
    if (!res.ok) { notice(msg, body.error || 'Something went wrong. Try again.', 'error'); return; }

    $('doneWho').textContent =
      [body.student, body.course, body.period && ('Period ' + body.period)].filter(Boolean).join(' · ');
    $('doneTitle').textContent = body.returning ? 'Welcome back' : "You're registered";
    $('doneMsg').textContent = body.message;
    const next = $('doneNext');
    next.textContent = body.returning ? 'Back to the syllabus' : 'Read and initial the syllabus';
    next.href = '/sign/';
    form.hidden = true;
    $('registerDone').hidden = false;
  } catch {
    notice(msg, 'Could not reach the server. Check your connection and try again.', 'error');
  } finally {
    submit.disabled = false;
    submit.textContent = 'Continue';
  }
});

// ---- signing ----

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const msg = $('loginMsg');
  const btn = $('loginBtn');
  msg.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Checking…';

  try {
    const res = await fetch('/api/sign/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(event.target).entries())),
    });
    const body = await res.json();
    if (!res.ok) { notice(msg, body.error || 'Could not sign in.', 'error'); return; }
    await loadSyllabus();
  } catch {
    notice(msg, 'Could not reach the server. Check your connection and try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Open the syllabus';
  }
});

async function loadSyllabus() {
  const res = await fetch('/api/sign/syllabus');
  if (res.status === 401) return;          // not signed in; stay on the form
  const body = await res.json();
  if (!res.ok) { notice($('loginMsg'), body.error || 'Nothing to show yet.', 'error'); return; }

  state = body;
  $('loginView').hidden = true;
  $('docView').hidden = false;
  $('progress').hidden = pathOf(location.pathname) !== '/sign';

  $('docTitle').textContent = body.title;
  $('docMeta').textContent =
    [body.course, body.period && ('Period ' + body.period), 'Version ' + body.version].filter(Boolean).join(' · ');
  $('progressWho').textContent =
    body.student + (body.role === 'parent' ? ' — parent or guardian' : ' — student');

  render();
}

// One sheet per section, so the syllabus is turned rather than scrolled. The
// section split is shared/sections.js -- the same definition the editor drags
// by and the same one a signature is hashed against, because a parent must
// initial exactly the span of text they were shown.
function render() {
  const wasOn = book?.at() ?? 0;
  const host = $('blocks');
  host.textContent = '';
  host.className = 'book';

  for (const section of sections(state.blocks)) {
    const sheet = document.createElement('section');
    sheet.className = 'sheet';
    const title = sectionTitle(section);
    if (title) sheet.setAttribute('aria-label', title);
    for (const block of section) {
      sheet.appendChild(block.needs_initials ? initialBox(block) : contentBlock(block));
    }
    host.appendChild(sheet);
  }

  book = createBook(host, {
    onTurn: (i, n) => {
      $('where').textContent = `Page ${i + 1} of ${n}`;
      $('prevPage').disabled = i === 0;
      $('nextPage').disabled = i === n - 1;
    },
  });
  $('bookBar').hidden = !book;
  // Stay on the page the reader was on. Initialling re-renders the whole
  // syllabus, and sending them back to page 1 each time would be its own bug.
  if (book) book.showSection(Math.min(wasOn, book.count() - 1));

  updateProgress();
}

function contentBlock(block) {
  const div = document.createElement('div');
  div.className = 'block';
  // Teacher-authored HTML from the editor. Not user input.
  div.innerHTML = block.html;
  return div;
}

function initialBox(block) {
  const box = document.createElement('div');
  box.className = 'initial-box' + (block.signed ? ' done' : '');

  const prompt = document.createElement('p');
  prompt.className = 'prompt';
  // The prompt is plain text, so set it as text rather than markup.
  prompt.textContent = block.html;
  box.appendChild(prompt);

  if (block.signed) {
    const stamp = document.createElement('p');
    stamp.className = 'stamp';
    stamp.innerHTML = 'Initialed <b></b> on <span></span>';
    stamp.querySelector('b').textContent = block.signed.initials;
    stamp.querySelector('span').textContent = new Date(block.signed.signed_at * 1000).toLocaleString();
    box.appendChild(stamp);
    return box;
  }

  const row = document.createElement('div');
  row.className = 'row';

  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 6;
  input.placeholder = 'ABC';
  input.setAttribute('aria-label', 'Your initials for this section');

  const button = document.createElement('button');
  button.textContent = 'Initial';

  const error = document.createElement('div');
  error.hidden = true;

  button.addEventListener('click', async () => {
    error.hidden = true;
    button.disabled = true;
    try {
      const res = await fetch('/api/sign/initial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ block_id: block.id, initials: input.value }),
      });
      const body = await res.json();
      if (!res.ok) { notice(error, body.error || 'Could not save.', 'error'); return; }

      block.signed = { initials: body.initials, signed_at: body.signed_at };
      render();
    } catch {
      notice(error, 'Could not reach the server. Try again.', 'error');
    } finally {
      button.disabled = false;
    }
  });

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); button.click(); } });

  row.append(input, button);
  box.append(row, error);
  return box;
}

function updateProgress() {
  const required = state.blocks.filter((b) => b.needs_initials);
  const signed = required.filter((b) => b.signed).length;
  $('progressCount').textContent = signed + ' of ' + required.length + ' sections';
  $('progressBar').style.width = required.length ? (signed / required.length * 100) + '%' : '0%';
  $('doneBanner').hidden = !(required.length && signed === required.length);
}

// ---- turning the notebook ----

$('prevPage').addEventListener('click', () => book?.go(book.at() - 1));
$('nextPage').addEventListener('click', () => book?.go(book.at() + 1));

// ---- start ----

swap(viewFor(location.pathname));   // no transition on first paint
loadSyllabus();                     // an existing session skips the sign-in form
