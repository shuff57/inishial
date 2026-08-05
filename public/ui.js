/* Shared chrome: theme, nav state, and the marker swipe.
 *
 * DEFERRED on every page. It used to be render-blocking so the stored theme
 * landed before first paint, but that cost ~36ms of first contentful paint and
 * a cross-document view transition cannot start until the new page paints --
 * the delay showed up as a pause-then-flash on every page turn. The six lines
 * that genuinely must run before paint are inlined in each page's <head>
 * instead; everything here waits for DOMContentLoaded.
 *
 * applyTheme() still runs at module scope. It is idempotent with the inline
 * bootstrap, and it keeps this file correct on its own if a page ever forgets
 * the inline copy.
 */

// ---- theme ----
//
// Three states, one stored key: "light", "dark", or absent = follow the OS.
// The CSS carries both palettes in light-dark(), so all this has to do is set
// `color-scheme` via a data attribute. It never names a colour.

const THEME_KEY = 'inishial:theme';

function storedTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;  // Safari private mode throws on localStorage. Follow the OS.
  }
}

function applyTheme(theme) {
  if (theme) document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
}

applyTheme(storedTheme());

/** What a click on the toggle should produce: whichever theme is not on now.
 *  Resolved against what is actually RENDERED, not against what is stored --
 *  otherwise the first click on a system-dark page stores "dark" and appears to
 *  do nothing. */
function nextTheme() {
  const stored = storedTheme();
  if (stored) return stored === 'dark' ? 'light' : 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark';
}

function setTheme(theme) {
  applyTheme(theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* not fatal */ }
  document.querySelectorAll('.theme-toggle').forEach(labelToggle);
}

function labelToggle(button) {
  const going = nextTheme();
  const label = `Switch to ${going} mode`;
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
}

// ---- school picker ----
//
// Custom dropdown for the teacher-facing school fields (admin signup, the
// placeholder-rename banner). Replaces the native <datalist>, whose popup a
// page cannot reposition or scroll, with a list drawn UNDER the field:
// seeded schools filter instantly as you type (no network -- that is what
// makes it feel fast), and when the typed name matches nothing on the
// install a Nominatim-backed search of the region joins below. Picking a
// row fills the field; typing something new and submitting still works and
// creates the school, same as the server always allowed.
//
// Markup contract:
//   <input data-school-picker data-school-panel="schoolSearch">
//   <div id="schoolSearch" hidden>
//     <p class="muted small" data-role="note"></p>
//     <div data-role="list"></div>
//     <p class="small muted" data-role="attribution"></p>
//   </div>

// Shared with inline page scripts, which already declare their own `esc` --
// so this one is named distinctly to avoid a global redeclaration error.
const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function initSchoolPicker() {
  const input = document.querySelector('input[data-school-picker]');
  if (!input) return;
  const panel = document.getElementById(input.dataset.schoolPanel);
  if (!panel) return;
  const note = panel.querySelector('[data-role="note"]');
  const list = panel.querySelector('[data-role="list"]');
  const attribution = panel.querySelector('[data-role="attribution"]');
  if (!note || !list || !attribution) return;

  let seeded = [];
  try {
    const { schools } = await (await fetch('/api/schools')).json();
    seeded = (schools || []).map((s) => s.name);
  } catch { /* free text still works */ }

  const renderRows = (rows) => {
    list.innerHTML = rows.map((s, i) =>
      `<button type="button" class="school-result" data-idx="${i}">` +
        `<span class="sr-name">${escHtml(s.name)}</span>` +
        (s.place ? `<span class="sr-place">${escHtml(s.place)}</span>` : '') +
        (s.existing_id ? `<span class="sr-already">On this install</span>` : '') +
      `</button>`).join('');
    for (const btn of list.querySelectorAll('.school-result')) {
      btn.addEventListener('click', () => {
        const row = rows[Number(btn.dataset.idx)];
        input.value = row.name;
        panel.hidden = true;
      });
    }
  };

  // A click on a result must not blur the input first (blur hides the panel
  // before the click registers). preventDefault on pointerdown keeps focus.
  panel.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.school-result')) e.preventDefault();
  });

  const cap = 8;
  let searchTimer = null;
  let searchSeq = 0;

  const showSeeded = (q) => {
    const matches = q ? seeded.filter((n) => n.toLowerCase().includes(q)) : seeded;
    attribution.textContent = '';
    if (!matches.length) { note.textContent = q.length < 3 ? 'Keep typing, or search the area.' : ''; list.innerHTML = ''; return matches; }
    note.textContent = 'Schools on this install';
    renderRows(matches.slice(0, cap).map((name) => ({ name })));
    if (matches.length > cap) note.textContent += ` — ${matches.length - cap} more, keep typing to narrow.`;
    return matches;
  };

  input.addEventListener('focus', () => {
    if (input.value.trim()) return;
    panel.hidden = false;
    showSeeded('');
  });

  input.addEventListener('input', () => {
    const q = input.value.trim();
    const lq = q.toLowerCase();
    // Typing an exact seed name is a done deal -- nothing to suggest.
    if (seeded.some((n) => n.toLowerCase() === lq)) { panel.hidden = true; return; }
    panel.hidden = false;
    attribution.textContent = '';
    const matches = showSeeded(lq);

    // Only when a school name has actually been typed and nothing on the
    // install matches it, go out to OpenStreetMap for the region.
    if (q.length < 3 || matches.length) return;
    note.textContent = `No "${q}" on this install. Searching the area…`;
    clearTimeout(searchTimer);
    const seq = ++searchSeq;
    searchTimer = setTimeout(async () => {
      if (seq !== searchSeq) return;
      try {
        const res = await fetch('/api/admin/schools/search?q=' + encodeURIComponent(q));
        const body = await res.json();
        if (seq !== searchSeq) return;
        if (!res.ok) { note.textContent = body.error || 'Search unavailable — type the school name and it will be created.'; return; }
        if (!body.schools.length) { note.textContent = `No "${q}" found nearby. You can still type the school name and it will be created.`; return; }
        note.textContent = 'Not listed? A nearby school?';
        renderRows(body.schools);
        attribution.textContent = body.attribution;
      } catch {
        if (seq === searchSeq) note.textContent = 'Search unavailable — type the school name and it will be created.';
      }
    }, 300);
  });

  input.addEventListener('blur', () => {
    clearTimeout(searchTimer);
    searchSeq++;
    panel.hidden = true;
  });
}

// ---- the rest ----

document.addEventListener('DOMContentLoaded', () => {
  wireThemeToggles();
  markCurrentPage();
  carryCourseId();
  wireSignOut();
  trackNavHeight();
  swipeMarks();
  initSchoolPicker();
});

/** Publish the nav's height as --nav-h so the OTHER sticky bars (the editor
 *  toolbar, the signing progress spine) can park directly under it.
 *
 *  Measured rather than hard-coded because the nav wraps to two rows on a
 *  phone: a fixed offset would either leave a gap or hide the toolbar behind
 *  the nav, and the editor toolbar holds Publish. */
function trackNavHeight() {
  const header = document.querySelector('header.site');
  if (!header) return;
  const publish = () =>
    document.documentElement.style.setProperty('--nav-h', `${header.offsetHeight}px`);
  publish();
  if ('ResizeObserver' in window) new ResizeObserver(publish).observe(header);
  else addEventListener('resize', publish);
}

/** Sign-out lives in the nav on every admin page, so its handler does too. */
function wireSignOut() {
  const button = document.getElementById('navSignout');
  if (!button) return;
  button.addEventListener('click', async () => {
    // Clears the cookie server-side. An Access session is ended by Access itself.
    await fetch('/api/admin/login', { method: 'DELETE' });
    location.href = '/admin/login/';
  });
}

function wireThemeToggles() {
  document.querySelectorAll('.theme-toggle').forEach((button) => {
    labelToggle(button);
    button.addEventListener('click', () => setTheme(nextTheme()));
  });
  // If the reader never picked a side, follow the OS when it changes -- macOS
  // and Windows both flip on a schedule, and a page left open overnight should
  // come with it.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!storedTheme()) document.querySelectorAll('.theme-toggle').forEach(labelToggle);
  });
}

/** aria-current on the nav link for the page you are on. Compared on pathname
 *  only: the editor and the progress page both carry ?course_id, and a query
 *  string is not a different page. */
function markCurrentPage() {
  const here = location.pathname.replace(/\/+$/, '') || '/';
  document.querySelectorAll('header.site .nav-main a').forEach((a) => {
    const there = new URL(a.getAttribute('href'), location.origin)
      .pathname.replace(/\/+$/, '') || '/';
    if (there === here) a.setAttribute('aria-current', 'page');
  });
}

/** Keep ?course_id across the admin nav.
 *
 * Without this, "Who has signed" from inside the editor drops you on a page
 * with no course selected -- which reads as a dead end even though the link
 * worked. The teacher is always working on ONE class at a time; the nav should
 * stay in it. */
function carryCourseId() {
  const id = new URLSearchParams(location.search).get('course_id');
  if (!id) return;
  document.querySelectorAll('header.site a[data-keep-course]').forEach((a) => {
    const url = new URL(a.getAttribute('href'), location.origin);
    url.searchParams.set('course_id', id);
    a.setAttribute('href', url.pathname + url.search);
  });
}

/** Draw the highlighter bands as they scroll in.
 *
 * The band is decoration over text that is already readable, so the failure
 * mode that matters is it never arriving. Anything without IntersectionObserver
 * -- and anything still unobserved when the page is printed -- gets `.swiped`
 * outright rather than an invisible highlight. */
function swipeMarks() {
  const marks = document.querySelectorAll('.mark, .tape');
  if (!marks.length) return;

  if (!('IntersectionObserver' in window)) {
    marks.forEach((el) => el.classList.add('swiped'));
    return;
  }

  const io = new IntersectionObserver((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('swiped');
      observer.unobserve(entry.target);   // a highlighter stroke happens once
    }
  }, { rootMargin: '0px 0px -8% 0px' });

  marks.forEach((el) => io.observe(el));
  addEventListener('beforeprint', () => marks.forEach((el) => el.classList.add('swiped')));
}
