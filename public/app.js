// The public side is one document with four views.
//
// Why one document: switching views is then a same-document change, which means
// the transition is fully under our control -- no waiting on a new page to
// paint, no snapshot of a document that is on its way out, and no flash. The
// cross-document version had to photograph the old page and hope the new one
// rendered in time; this one just moves elements it already owns.
//
// The URLs are real. /sign/ is what a teacher mails out and /register/ is what
// a printed QR code points at, so the server hands back this same file for
// those paths (functions/_middleware.js, scripts/dev.mjs) and the router picks
// the view from location.pathname. Links in the nav stay ordinary hrefs: with
// JS they are intercepted, without it they are a full navigation to a document
// that still knows which view it is.
//
// A path added here must be added to SHELL_PATHS in functions/_middleware.js
// AND to REWRITES in scripts/dev.mjs, or it serves in one environment and 404s
// in the other.

import { createBook, sections, sectionTitle } from './book.js';
import { keepSnapped } from './snap.js';
import { buildFlags, clearFlags } from './shared/flags.js';

const $ = (id) => document.getElementById(id);
const views = () => [...document.querySelectorAll('.view')];
const pathOf = (p) => (p.replace(/\/+$/, '') || '/');

/**
 * fetch with a ceiling on how long it may hang.
 *
 * A phone on cellular can leave a request neither succeeding nor failing: the
 * connection stalls and the promise never settles. Every button on this side
 * disables itself while it waits, so a stall left the control dead with no way
 * out but closing the tab -- worst on the Initial button, where the parent has
 * already typed and has no idea whether it went.
 *
 * A bare fetch has no timeout of its own; the browser will wait out its own
 * much longer TCP limits. AbortSignal.timeout REJECTS, which drops into the
 * catch every one of these calls already has, so the existing "could not reach
 * the server" path handles it with no new branching.
 *
 * 12s is chosen to be longer than a slow-but-working request on a bad 3G
 * connection, and shorter than a parent's patience with a dead button.
 */
const NET_TIMEOUT_MS = 12_000;
const netFetch = (url, opts = {}) =>
  fetch(url, { ...opts, signal: AbortSignal.timeout(NET_TIMEOUT_MS) });

const TITLES = {
  '/': 'iniSHial',
  '/register': 'Set up your account · iniSHial',
  '/register/code': 'Get your access code · iniSHial',
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
  const at = pathOf(location.pathname);
  for (const a of document.querySelectorAll('header.site .nav-main a')) {
    const here = pathOf(new URL(a.getAttribute('href'), location.origin).pathname);
    // Prefix as well as exact, so /register/code/ -- the parent tab of
    // /register/ -- keeps "Set up my account" lit. Without it a parent on that
    // tab sees nothing marked in the nav, which reads as being nowhere.
    // `here !== '/'` or Start would claim every page on the site.
    const on = here === at || (here !== '/' && at.startsWith(here + '/'));
    a.toggleAttribute('aria-current', on);
    if (on) a.setAttribute('aria-current', 'page');
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

  // Arriving at /sign/ without having loaded the syllabus yet. This is a
  // same-document change, so nothing re-runs on its own -- and the session may
  // well have been minted since the last check.
  //
  // The case this exists for is the student who has just registered: they hold
  // a session cookie, and the button on the confirmation card brought them here
  // without a navigation. Before this they were shown the sign-in form and
  // asked for the access code they had been told to write down thirty seconds
  // earlier, which reads as the registration not having counted.
  if (target.id === 'view-sign') ensureSyllabus();
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

// The unsent initials boxes currently on the page. Rebuilt by render(), which
// throws the old ones away with the DOM they lived in.
let pendingInputs = new Set();

function notice(el, text, kind) {
  el.hidden = false;
  el.className = 'notice ' + kind;
  el.textContent = text;
}

// ---- the school field on /register/ and /register/code/ ----
//
// Both are <select>s populated from /api/schools, and both only ever SELECT an
// existing school. Hidden until that endpoint reports more than one school in
// use, so the common single-school install never sees the field at all.
//
// /sign/ is deliberately NOT in this list. Since migrations/0013 the school id
// is baked into the username, so sign-in needs no school field to disambiguate
// -- and the one it used to have was the only one of the three whose value was
// never checked before submitting.
const SCHOOL_FIELDS = [
  { label: 'reg-school-label', input: 'reg-school-name', list: 'reg-school-list', hidden: 'reg-school' },
  { label: 'rc-school-label', input: 'rc-school-name', list: 'rc-school-list', hidden: 'rc-school' },
];

// Below this many characters the list stays empty, so the field opens blank
// instead of unrolling fifty schools at anyone who clicks it. Two is enough to
// cut the list to a handful and short enough that nobody has to think.
const SCHOOL_MIN_CHARS = 2;
// A menu longer than this is not a menu. Keep typing narrows it.
const SCHOOL_MAX_OPTIONS = 8;

let schools = [];

/** Type-ahead: fill the datalist from what has been typed, and resolve an
 *  exact name to the id the form actually submits.
 *
 *  A <datalist> rather than a <select> because the list is a reference set --
 *  migration 0011 seeded ~50 area schools -- and a fifty-item select asks a
 *  fifteen-year-old to scroll for a value they can type in four keystrokes.
 *  Native, so the filtering, keyboard handling and mobile presentation are the
 *  browser's rather than ours.
 *
 *  The visible field is a NAME and the submitted field is an ID: only a typed
 *  name that matches a real school resolves, so this form can only ever SELECT
 *  a school, never invent one. The server checks the answer against the
 *  student's roster row regardless (api/register.js).
 */
function resolveSchool(f) {
  const q = $(f.input).value.trim().toLowerCase();
  const list = $(f.list);

  // Resolve first: the id is what the form submits, and it is set by an exact
  // name whether that name was typed out or clicked from the list.
  const match = schools.find((s) => s.name.toLowerCase() === q);
  $(f.hidden).value = match ? match.id : '';

  // Nothing to choose once the name is exact -- keeping the list open would
  // cover the next field with one row repeating what is already in the box.
  const hits = q.length < SCHOOL_MIN_CHARS || match
    ? []
    : schools.filter((s) => s.name.toLowerCase().includes(q)).slice(0, SCHOOL_MAX_OPTIONS);

  list.innerHTML = hits
    .map((s) => `<button type="button" class="school-result" role="option" data-id="${s.id}">`
      + `<span class="sr-name">${escAttr(s.name)}</span></button>`)
    .join('');
  list.hidden = !hits.length;
  $(f.input).setAttribute('aria-expanded', String(!!hits.length));
}

/** Take a row: fill the visible name, keep the id, put the list away. */
function pickSchool(f, id) {
  const school = schools.find((s) => String(s.id) === String(id));
  if (!school) return;
  $(f.input).value = school.name;
  $(f.hidden).value = school.id;
  $(f.list).hidden = true;
  $(f.input).setAttribute('aria-expanded', 'false');
}

const escAttr = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Safe to submit: the field is still hidden (we never got a list, so the
 *  server falls back to the roster's own school), or a typed name resolved to
 *  a real id. */
const schoolFieldOk = (f) => $(f.input).hidden || !!$(f.hidden).value;

for (const f of SCHOOL_FIELDS) {
  $(f.input).addEventListener('input', () => resolveSchool(f));

  // pointerdown, not click: a click on a row blurs the input first, and the
  // blur handler below hides the list before the click can land on it.
  $(f.list).addEventListener('pointerdown', (event) => {
    const row = event.target.closest('[data-id]');
    if (!row) return;
    event.preventDefault();
    pickSchool(f, row.dataset.id);
  });

  // Keyboard: the rows are real buttons, so Tab reaches them and Enter fires
  // this. Escape puts the list away without choosing.
  $(f.list).addEventListener('click', (event) => {
    const row = event.target.closest('[data-id]');
    if (row) pickSchool(f, row.dataset.id);
  });
  $(f.input).addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { $(f.list).hidden = true; $(f.input).setAttribute('aria-expanded', 'false'); }
  });

  // Leaving the field entirely closes the list -- but not when focus moved
  // INTO the list, or picking with the keyboard would never get the chance.
  $(f.input).addEventListener('blur', () => {
    setTimeout(() => {
      if ($(f.list).contains(document.activeElement)) return;
      $(f.list).hidden = true;
      $(f.input).setAttribute('aria-expanded', 'false');
    }, 120);
  });
}

(async () => {
  let required = false;
  try {
    ({ schools = [], required = false } = await (await netFetch('/api/schools')).json());
  } catch { schools = []; }

  // No list, no field. If /api/schools could not be reached there is nothing
  // to type against, and a required field nobody can satisfy is a locked door:
  // left hidden, the form submits without a school and the server falls back
  // to the roster row's own -- which is where the value comes from anyway.
  if (!schools.length) return;

  // ALWAYS shown, on both forms, whatever `required` says.
  //
  // School is one of the three things that identify a student here -- school,
  // last name, student ID -- and the parent form asks the same three plus the
  // address to mail to. That is the design, not an optimisation to make: this
  // was briefly hidden at one-school installs on the grounds that picking from
  // a list of one is friction, which quietly dropped a field the flow is
  // specified around.
  //
  // `required` from /api/schools is still worth having and is deliberately not
  // consulted here: it reports whether the SERVER will scope by school, which
  // is a different question from whether the form should ask. The server now
  // validates the answer against the roster row either way (see
  // api/register.js), so a wrong pick is refused rather than ignored.
  void required;

  // The options themselves are filled in by resolveSchool() as the reader
  // types -- nothing is listed before then, which is the point of the field
  // opening blank rather than unrolling the whole seeded reference list.
  for (const f of SCHOOL_FIELDS) {
    $(f.label).hidden = false;
    $(f.input).hidden = false;
  }
})();

/** Rebuild the class switcher buttons to highlight the active course. */
function rebuildSwitcher() {
  const switcher = $('courseSwitcher');
  if (!state || !state.courses || state.courses.length <= 1) return;
  for (const btn of switcher.querySelectorAll('button')) {
    const c = state.courses.find((x) => x.name === btn.textContent);
    btn.className = 'secondary' + (c && c.id === state.course_id ? ' active' : '');
  }
}

// ---- registering ----

$('registerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const msg = $('registerMsg');
  const submit = $('registerBtn');
  msg.hidden = true;

  if (!schoolFieldOk(SCHOOL_FIELDS[0])) {
    notice(msg, 'Select your school from the list.', 'error');
    return;
  }

  submit.disabled = true;
  submit.textContent = 'Checking…';

  try {
    const res = await netFetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(form).entries())),
    });
    const body = await res.json();

    // 409: this student already has an account, so signing in is /sign/'s job.
    // Shown as a card with a way forward rather than a red bar under a field --
    // nothing they typed is wrong, they simply already have what this page
    // makes, and the useful response is a door rather than a correction.
    if (res.status === 409 && body.registered) {
      $('registerExistsMsg').textContent = body.error;
      form.hidden = true;
      $('registerExists').hidden = false;
      return;
    }
    if (!res.ok) { notice(msg, body.error || 'Something went wrong. Try again.', 'error'); return; }

    $('doneWho').textContent =
      [body.student, body.course, body.period && ('Period ' + body.period)].filter(Boolean).join(' · ');
    $('doneMsg').textContent = body.message;
    $('doneUsername').textContent = body.username;
    // No code when an existing student is added to a second class -- there is
    // no new one to show, and the card printed the string "null" under "write
    // it down" before this. body.message says which case it is.
    $('doneCode').hidden = !body.student_code;
    $('doneCodeValue').textContent = body.student_code ?? '';
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
    const res = await netFetch('/api/sign/login', {
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

// ---- /register/code/ : have the access codes emailed ----
//
// Its own view now rather than a panel folded into the sign-in form. One
// submit, no toggles. On success the form is replaced by a "check your inbox"
// card with a button to /sign/, and the student ID is copied into the sign-in
// form so that when they get there only the code is left to type.
//
// The endpoint mails BOTH codes, so this is the student's recovery path too --
// but the address is always a family one, whoever is typing. See the comment on
// the view in index.html.

const requestCodeForm = $('requestCodeForm');
const requestCodeSent = $('requestCodeSent');

requestCodeForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const msg = $('requestCodeMsg');
  const btn = $('requestCodeBtn');
  msg.hidden = true;

  if (!schoolFieldOk(SCHOOL_FIELDS[1])) {
    notice(msg, 'Select your school from the list.', 'error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    const res = await netFetch('/api/sign/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(event.target).entries())),
    });
    const body = await res.json();
    if (!res.ok) { notice(msg, body.error || 'Could not send the code.', 'error'); return; }

    // Replace the form with the confirmation. Nothing is carried over to the
    // sign-in form any more: it asks for a username and a code, and both of
    // those are in the email rather than on this page.
    requestCodeForm.hidden = true;
    $('requestCodeNote').hidden = true;
    requestCodeSent.hidden = false;
    $('requestCodeSentMsg').textContent =
      `We sent your username and access code to ${body.email_preview}, along with the `
      + "student's own code. Open it, then go to the syllabus and sign in.";
  } catch {
    notice(msg, 'Could not reach the server. Check your connection and try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send the code';
  }
});

/** loadSyllabus, made safe to call on every arrival at /sign/.
 *
 *  Two guards. `state` means it is already loaded, and re-fetching would throw
 *  away the page the reader was on. `inFlight` means a request is out: without
 *  it, a reader clicking between nav items faster than the network answers
 *  would stack requests whose responses could then land out of order.
 *
 *  Anonymous arrivals do re-check, and that is deliberate -- a session can be
 *  minted in another tab, and a 401 is cheap. */
let inFlight = null;
function ensureSyllabus() {
  if (state || inFlight) return;
  inFlight = loadSyllabus()
    .catch(() => notice($('loginMsg'),
      'Could not reach the server. Check your connection and try again.', 'error'))
    .finally(() => { inFlight = null; });
}

async function loadSyllabus() {
  const res = await netFetch('/api/sign/syllabus');
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
    body.student + (body.role === 'parent' ? ' · parent or guardian' : ' · student');

  // Class switcher: shown only when the identity has more than one course.
  const switcher = $('courseSwitcher');
  if (body.courses && body.courses.length > 1) {
    switcher.hidden = false;
    switcher.textContent = '';
    for (const c of body.courses) {
      const btn = document.createElement('button');
      btn.textContent = c.name;
      btn.className = 'secondary' + (c.id === body.course_id ? ' active' : '');
      btn.addEventListener('click', async () => {
        if (c.id === state.course_id) return;
        btn.disabled = true;
        try {
          const res = await netFetch(`/api/sign/syllabus?course=${c.id}`);
          if (res.status === 401) return;
          const newBody = await res.json();
          if (!res.ok) return;
          state = newBody;
          render();
          rebuildSwitcher();
        } catch { /* network error, stay put */ }
        finally { btn.disabled = false; }
      });
      switcher.appendChild(btn);
    }
  } else {
    switcher.hidden = true;
  }

  // A returning family whose syllabus has been amended. Said once, at the top,
  // with a count -- so the answer to "what am I being asked to do again" is on
  // screen before any scrolling, and the sections themselves carry the detail.
  const amended = body.amended ?? 0;
  const banner = $('amendedBanner');
  banner.hidden = amended === 0;
  if (amended) {
    banner.textContent = amended === 1
      ? 'One section has changed since you last signed. It is marked below and needs your initials again; everything else you have already signed still stands.'
      : `${amended} sections have changed since you last signed. They are marked below and need your initials again; everything else you have already signed still stands.`;
  }

  render();
}

// One sheet per section, so the syllabus is turned rather than scrolled. The
// section split is shared/sections.js -- the same definition the editor drags
// by and the same one a signature is hashed against, because a parent must
// initial exactly the span of text they were shown.
let stopSnapping = null;

function render() {
  const wasOn = book?.at() ?? 0;
  const host = $('blocks');
  host.textContent = '';
  host.className = 'book';
  // The inputs tracked here belong to the DOM about to be discarded.
  pendingInputs = new Set();
  clearFlags();
  // Release the previous book's key bindings before building another.
  book?.destroy();

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

  const flags = buildFlags(host, { onPick: (i) => book?.go(i) });

  book = createBook(host, {
    onTurn: (i, n) => {
      $('where').textContent = `Page ${i + 1} of ${n}`;
      $('prevPage').disabled = i === 0;
      $('nextPage').disabled = i === n - 1;
      // One source of truth for which page is showing: the book. The flags
      // report it, they do not keep their own idea of it -- which is what stops
      // "Next page" and a flag click from ever disagreeing.
      for (const [at, flag] of flags) flag.setAttribute('aria-current', String(at === i));
    },
  });
  $('bookBar').hidden = !book;
  // Imported .docx content is not the app's to control, so its fit to the ruled
  // lines is measured rather than assumed. A document already on the grid --
  // which is the normal case -- gets no correction at all.
  stopSnapping?.();
  stopSnapping = keepSnapped(host);
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

  // A table is the one thing in here whose width the teacher controls and the
  // page cannot. A grading-weights table imported from a .docx can carry five
  // columns, and at 360px that pushed <main> wider than the viewport, so the
  // whole signed document scrolled sideways -- the parent's own sheet, not
  // some widget. The admin tables were given a stacking fix for exactly this;
  // the page a parent actually signs never got one.
  //
  // Wrapped rather than restyled: `display: block` on the table itself would
  // make it scroll but would also stop it being a table for layout, so the
  // columns would stop lining up. The wrapper scrolls; the table inside keeps
  // its own geometry, and the rest of the page stops moving.
  for (const table of div.querySelectorAll('table')) {
    const scroller = document.createElement('div');
    scroller.className = 'table-scroll';
    table.replaceWith(scroller);
    scroller.appendChild(table);
  }
  return div;
}

function initialBox(block) {
  const box = document.createElement('div');
  box.className = 'initial-box' + (block.signed ? ' done' : '') + (block.updated ? ' updated' : '');

  // An amendment. This family signed this section before, and the words have
  // changed since -- so the one thing worth saying is which of the twelve
  // sections is not the one they already read. Said above the prompt, because
  // by the time the eye reaches the initials box the reading has been done.
  if (block.updated) {
    const flag = document.createElement('p');
    flag.className = 'updated-flag';
    flag.textContent = 'Updated since you signed — please read this section again.';
    box.appendChild(flag);
  }

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
      const res = await netFetch('/api/sign/initial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ block_id: block.id, initials: input.value }),
      });
      const body = await res.json();
      if (!res.ok) { notice(error, body.error || 'Could not save.', 'error'); return; }

      block.signed = { initials: body.initials, signed_at: body.signed_at };
      // It has just been read and re-initialed, so it is no longer the section
      // that changed. Without this the box comes back stamped AND still flagged
      // "please read this again", which reads as the signature not having
      // counted.
      block.updated = false;
      render();
    } catch {
      notice(error, 'Could not reach the server. Try again.', 'error');
    } finally {
      button.disabled = false;
    }
  });

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); button.click(); } });

  // Registered so signing out can tell whether anything is typed but unsent.
  // Every OTHER piece of a signer's work is already on the server -- an initial
  // is POSTed the moment the button is pressed, there is no draft and no
  // autosave -- so this box is the only thing a sign-out could throw away.
  pendingInputs.add(input);

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

// ---- signing out ----
//
// Everything a signer has done is already on the server: POST /api/sign/initial
// writes the signature when the button is pressed, so there is no draft to
// flush here and no request that could fail and lose one. The single exception
// is a box with initials typed into it whose button was never pressed, and
// that is what the check below is for -- on a shared Chromebook the cost of
// getting it wrong is a section silently unsigned.
//
// The cookie is HttpOnly, so only the server can clear it; this cannot be done
// in the client alone.

/** Initials boxes with something typed in them and nothing sent. */
const unsent = () => [...pendingInputs].filter((i) => i.value.trim() !== '').length;

$('signOut').addEventListener('click', async () => {
  const pending = unsent();
  if (pending) {
    const which = pending === 1
      ? 'One section has initials typed in but not submitted yet.'
      : `${pending} sections have initials typed in but not submitted yet.`;
    if (!confirm(`${which} Signing out now will lose them — everything you have already `
      + 'initialed is saved. Sign out anyway?')) return;
  }

  const btn = $('signOut');
  btn.disabled = true;
  try {
    await netFetch('/api/sign/login', { method: 'DELETE' });
  } catch {
    // The cookie may or may not have been cleared. Fall through and reset the
    // page regardless: leaving someone looking at another family's syllabus
    // because the network hiccupped is the worse of the two failures, and the
    // next request re-checks the session anyway.
  } finally {
    btn.disabled = false;
  }

  // Tear the reading state down rather than hiding it. `state` is what
  // ensureSyllabus() checks, so leaving it set would make a later arrival at
  // /sign/ skip the check and show the previous reader's syllabus from memory.
  state = null;
  book?.destroy();
  book = null;
  pendingInputs = new Set();
  $('blocks').textContent = '';
  $('docView').hidden = true;
  $('bookBar').hidden = true;
  $('progress').hidden = true;
  $('loginView').hidden = false;

  // Nothing of theirs left in the fields for the next person at this machine.
  $('loginForm').reset();
  notice($('loginMsg'), 'You are signed out. Everything you initialed has been saved.', 'ok');
  focusMain();

  // Deliberately NOT show('/sign/'): that routes through ensureSyllabus(), and
  // with `state` now null it would fetch the syllabus again. If the DELETE had
  // failed the session would still be live, the fetch would succeed, and the
  // page would silently undo the sign-out it just told the reader about. The
  // views are already switched above; there is nothing left to route to.
});

// ---- turning the notebook ----

$('prevPage').addEventListener('click', () => book?.go(book.at() - 1));
$('nextPage').addEventListener('click', () => book?.go(book.at() + 1));

// ---- start ----

swap(viewFor(location.pathname));   // no transition on first paint
// An existing session skips the sign-in form. Through ensureSyllabus like every
// other arrival, so the rejection has somewhere to go: unhandled, a dropped
// connection left the parent on a bare sign-in form with no hint that the
// problem was the network rather than them.
ensureSyllabus();
