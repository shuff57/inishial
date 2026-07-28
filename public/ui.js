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

// ---- the rest ----

document.addEventListener('DOMContentLoaded', () => {
  wireThemeToggles();
  markCurrentPage();
  carryCourseId();
  wireSignOut();
  trackNavHeight();
  swipeMarks();
});

/**
 * Shade the crease just before the page is photographed for the turn.
 *
 * The idea is turn.js's -- it paints a linear-gradient across the fold so the
 * paper reads as bending rather than pivoting flat. None of its code is used
 * (it is non-commercial licensed); this is the technique, not the source.
 *
 * It has to happen HERE rather than in the transition itself: a
 * ::view-transition-old() pseudo-element is a replaced element showing a
 * snapshot, so nothing can be layered inside it. `pageswap` fires on the
 * outgoing document BEFORE that snapshot is taken, which is the one moment the
 * shading can still be painted into the page it belongs to.
 */
addEventListener('pageswap', (event) => {
  // No transition (unsupported browser, reduced motion, cross-origin) means no
  // snapshot, and shading a page nobody is about to photograph would just be a
  // dark flash on the way out.
  if (event.viewTransition) document.documentElement.classList.add('turning');
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
