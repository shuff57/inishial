/*
 * Buy Me a Coffee: the in-page invite, and the height cap on BMC's panel.
 *
 * One file rather than a copy per page. This began inline in index.html, and
 * the moment the widget was wanted on the teacher side as well that would have
 * been six copies of eighty lines drifting apart. The page supplies only BMC's
 * own <script data-name="BMC-Widget" ...> tag; everything else is here.
 *
 * The invite panel is built in JS rather than written into each page's markup
 * for the same reason. Nothing is lost without JS: the widget it invites you to
 * is itself script-injected, so with scripts off there is nothing to invite.
 */
(function () {
  'use strict';

  // BMC's own loader has to be on the page for any of this to mean anything.
  if (!document.querySelector('script[data-name="BMC-Widget"]')) return;

  /* ---- the in-page invitation ---- */

  // The chip BMC draws is tiny and wordless. This carries the sentence its
  // iframe would otherwise have to open to show, so the ask reads without the
  // page having to host a payment surface. Clicking it forwards to the chip:
  // one prompt, one payment surface.
  var panel = document.createElement('aside');
  panel.id = 'bmc-invite';
  panel.className = 'bmc-invite';
  panel.setAttribute('aria-label', 'Buy the teacher a coffee');
  panel.innerHTML = '<p class="bmc-invite-msg">If iniSHial saved you time, '
    + 'please consider buying me a coffee. Thank you.</p>';
  document.body.appendChild(panel);

  var dismissed = false;
  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    panel.hidden = true;
  }

  panel.addEventListener('click', function () {
    // BMC's loader is async: the chip may not exist yet on a fast click. Poll
    // briefly, then drive it. 50 tries x 100ms = a 5s ceiling; BMC injects the
    // chip inside a second on a typical page.
    var n = 0;
    (function openWhenReady() {
      var chip = document.getElementById('bmc-wbtn');
      if (chip) chip.click();
      else if (++n < 50) setTimeout(openWhenReady, 100);
    })();
    dismiss();
  });
  setTimeout(dismiss, 10000);

  /* ---- the height cap ---- */

  /*
   * BMC re-sets `iframe.style.height` from `window.innerHeight - 120` on every
   * open, so the height has to be re-applied rather than set once.
   *
   * The real ceiling is the max-height in app.css, and that one had to release
   * `min-height` first -- BMC ships `min-height: 680px`, and min-height always
   * beats max-height, which is why an earlier cap here appeared to do nothing.
   * This function sets the SIZE we actually want; the CSS stops it running off
   * the bottom of the screen if these numbers are ever wrong.
   */
  function capIframe() {
    var f = document.getElementById('bmc-iframe');
    if (!f) return;
    var cap = Math.min(560, Math.floor(window.innerHeight * 0.70));
    if (parseInt(f.style.height, 10) !== cap) f.style.height = cap + 'px';
  }

  /*
   * Re-apply for a few frames after the chip is clicked, so the cap lands in
   * the same frame as BMC's open animation and survives any late re-assignment.
   *
   * BOUNDED, deliberately. The version this replaced also had a `forceCap()`
   * that called requestAnimationFrame on itself with no exit condition, so from
   * the first click onward the page ran a callback every frame for the rest of
   * the session -- on a phone that is the browser being kept awake to do
   * nothing. Ten frames covers the animation; the observer below covers the
   * rest, and costs nothing while idle.
   */
  function hookChip() {
    var chip = document.getElementById('bmc-wbtn');
    if (!chip) return setTimeout(hookChip, 200);
    chip.addEventListener('click', function () {
      var n = 0;
      (function tick() {
        capIframe();
        if (++n < 10) requestAnimationFrame(tick);
      })();
    });
  }
  hookChip();

  // And for anything that changes the height later -- a resize, a re-open.
  var mo = new MutationObserver(capIframe);
  (function watch() {
    var f = document.getElementById('bmc-iframe');
    if (f) mo.observe(f, { attributes: true, attributeFilter: ['style'] });
    else setTimeout(watch, 200);
  })();
})();
