// The shared harness behind every clip on /how/.
//
//   npm i playwright --no-save    <- required, and deliberately NOT a dependency
//   ffmpeg on PATH                <- optional; without it clips are ~3x larger
//
// DEPLOY.md step 1 is `npm install`. Making everyone who deploys a static site
// download Chromium first is a real cost for no benefit, so the recorders ask
// for Playwright by hand and say so when it is missing. Nothing the app serves
// depends on it; these scripts only regenerate artefacts already committed.
//
// ---------------------------------------------------------------------------
//
// Playwright records one video PER PAGE, per context. That is what makes a
// multi-clip walkthrough possible: the context holds the cookies, so a teacher
// signs in once and every later clip inherits the session, while each clip is
// still its own file. One page = one clip = one .mp4.
//
// Two things a raw recording gets wrong for a tutorial, both fixed here:
//
//   no cursor     CDP moves the pointer and nothing paints it, so a viewer
//                 sees fields fill themselves. A dot is injected that tracks
//                 mousemove and pulses on mousedown.
//   machine speed clicks and keystrokes land instantly. point() travels to a
//                 target over 25 frames, type() is paced, beat() pauses long
//                 enough to read what just happened.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, renameSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const MEDIA = join(ROOT, 'public', 'how', 'media');
export const STEPS = join(ROOT, 'public', 'how', 'steps');

// 16:10. Wide enough for the two-column admin tables without shrinking text to
// nothing, and it is the aspect the /how/ page reserves grid space for.
export const SIZE = { width: 1280, height: 800 };

async function playwright() {
  try {
    return await import('playwright');
  } catch {
    console.error('\n  The recorders need Playwright:\n\n    npm i playwright --no-save\n');
    process.exit(1);
  }
}

// ---- the dev server ----

/**
 * A dev server of this recorder's own, on its own port, against its own
 * database. Recorders run in parallel and a shared .dev.sqlite would have them
 * reissuing each other's access codes mid-clip.
 *
 * The database is deleted first: a clip is only reproducible if the seed it
 * starts from is.
 */
export async function startServer(port, dbName) {
  const db = join(ROOT, dbName);
  for (const f of [db, db + '-journal', db + '-wal', db + '-shm']) {
    if (existsSync(f)) rmSync(f, { force: true });
  }

  const proc = spawn(process.execPath, [join(ROOT, 'scripts', 'dev.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DEV_DB: dbName },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });

  const base = `http://localhost:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`dev server never came up on ${port}:\n${log}`);
    }
    try {
      const res = await fetch(base + '/');
      if (res.ok) break;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }

  return { base, log: () => log, stop: () => proc.kill() };
}

// ---- getting the file down to a sane size ----

/**
 * Re-encode a finished clip from Playwright's webm to H.264 in MP4.
 *
 * Two problems, one pass.
 *
 * Size: Playwright writes for speed, not for size. A ten-second clip lands
 * around 700 KB, and thirty of those is twenty megabytes of binary committed
 * to a repo forever and pushed down an LTE connection to a parent who came
 * here to read a syllabus. This is about a third of that.
 *
 * Codec: the obvious choice was VP9, which is slightly better at this kind of
 * content -- but WebM support on iOS Safari is patchy, and "no backpack
 * required" means a parent watching this on a phone in a car park. H.264 in
 * MP4 plays everywhere there is a browser. It also turned out to be SMALLER
 * here than VP9 at matched quality, so the compatibility came free.
 *
 * CRF 32 was checked at 1:1 against the smallest type the app renders,
 * including the italic margin notes, before it was turned on. faststart moves
 * the index to the front so playback can begin before the file has arrived.
 *
 * ffmpeg is optional. Without it the raw file is kept and a line is printed:
 * losing a recording because a codec was missing would be a much worse
 * outcome than a large one.
 */
function squeeze(from, to) {
  const args = [
    '-y', '-loglevel', 'error', '-i', from,
    '-c:v', 'libx264', '-crf', '32', '-preset', 'slow',
    '-pix_fmt', 'yuv420p',      // some players reject anything else
    '-movflags', '+faststart',
    '-an',                      // there is no audio and an empty track costs a header
    to,
  ];
  const res = spawnSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (res.error || res.status !== 0) {
    renameSync(from, to);
    console.log(`  (kept raw ${to.split(/[\\/]/).pop()} -- ffmpeg ${res.error ? 'not found' : 'failed'})`);
    return;
  }
  rmSync(from, { force: true });
}

// ---- the browser ----

/**
 * Which theme this run records.
 *
 *   THEME=dark node scripts/record/parent.mjs
 *
 * Light is the base and dark is the variant: dark clips are written alongside
 * with a `-dark` suffix and the page swaps to them when the reader's theme is
 * dark. Run light FIRST on a clean tree -- writeSteps() verifies the light file
 * exists for every step, and the dark run alone would have nothing to check.
 */
export const THEME = process.env.THEME === 'dark' ? 'dark' : 'light';
const SUFFIX = THEME === 'dark' ? '-dark' : '';

// Runs before every document, including after navigation. Kept to one function
// with no imports because that is all addInitScript can serialise.
function paintCursor(theme) {
  try { localStorage.setItem('inishial:theme', theme); } catch { /* ignore */ }

  const dot = document.createElement('div');
  dot.style.cssText = [
    'position:fixed', 'left:-80px', 'top:-80px', 'width:20px', 'height:20px',
    'margin:-10px 0 0 -10px', 'border-radius:50%', 'pointer-events:none',
    'z-index:2147483647', 'background:rgba(28,28,30,.34)',
    'border:2px solid rgba(255,255,255,.92)', 'box-shadow:0 1px 5px rgba(0,0,0,.45)',
    'transition:transform 90ms ease-out, background 90ms ease-out',
  ].join(';');

  const attach = () => document.body && !dot.isConnected && document.body.appendChild(dot);
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', attach);
  else attach();

  // Capture phase: a page handler that stops propagation must not blind the
  // cursor. It is chrome painted over the app, not part of it.
  addEventListener('mousemove', (e) => {
    attach();
    dot.style.left = e.clientX + 'px';
    dot.style.top = e.clientY + 'px';
  }, true);
  addEventListener('mousedown', () => {
    dot.style.transform = 'scale(.6)';
    dot.style.background = 'rgba(232,168,42,.85)';
  }, true);
  addEventListener('mouseup', () => {
    dot.style.transform = '';
    dot.style.background = 'rgba(28,28,30,.34)';
  }, true);
}

/**
 * One browser, one context, one video directory. Every clip taken from the
 * returned recorder shares cookies with the ones before it.
 */
export async function open(base, { prefix }) {
  const { chromium } = await playwright();
  const dir = join(tmpdir(), 'inishial-record', prefix);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  mkdirSync(MEDIA, { recursive: true });

  // Old clips for THIS role AND THIS THEME only. A renamed step would otherwise
  // leave an orphan clip in the repo that nothing on the page ever links to --
  // but a light run must not sweep away the dark variants beside it, which is
  // why the suffix is part of the test rather than just of the output name.
  for (const f of readdirSync(MEDIA)) {
    if (f.startsWith(prefix + '-') && f.endsWith(`${SUFFIX}.mp4`)
      && (SUFFIX || !f.endsWith('-dark.mp4'))) rmSync(join(MEDIA, f));
  }

  const browser = await chromium.launch({ args: ['--force-color-profile=srgb'] });
  const context = await browser.newContext({
    viewport: SIZE,
    recordVideo: { dir, size: SIZE },
    deviceScaleFactor: 1,
    colorScheme: THEME,
  });
  // Both, because the app reads its own stored choice and the OS preference is
  // what it falls back to. Setting only one leaves the recording at the mercy
  // of whichever the page happens to consult first.
  await context.addInitScript(paintCursor, THEME);

  const made = [];

  return {
    base,
    made,

    /**
     * One clip. `name` is the bare stem -- the file lands at
     * public/how/media/<prefix>-<name>.mp4, or -dark.mp4 on a dark run.
     *
     * RETURNS THE BASE NAME EITHER WAY, which is not a detail: some recorders
     * feed this return value straight into their manifest, and returning the
     * dark filename on a dark run wrote the dark clips in as the primary ones
     * -- that panel then played dark recordings on a light page. A manifest
     * always names the light clip; writeSteps() attaches the dark variant.
     */
    async clip(name, body) {
      const base = `${prefix}-${name}.mp4`;
      const file = `${prefix}-${name}${SUFFIX}.mp4`;
      const page = await context.newPage();
      page.on('pageerror', (e) => console.log(`  ! page error in ${file}: ${e}`));
      try {
        await body(page);
        await page.waitForTimeout(700);   // let the last frame sit long enough to read
      } finally {
        await page.close();
        const raw = join(dir, 'raw-' + file);
        await page.video().saveAs(raw);
        await page.video().delete();
        squeeze(raw, join(MEDIA, file));
      }
      made.push(file);
      const kb = Math.round(statSync(join(MEDIA, file)).size / 1024);
      console.log(`  recorded ${file}  ${kb} KB`);
      return base;
    },

    /** A page that leaves no clip -- setup, seeding, navigating to a start state. */
    async scratch(body) {
      const page = await context.newPage();
      try {
        await body(page);
      } finally {
        await page.close();
        await page.video()?.delete();
      }
    },

    async close() {
      await context.close();
      await browser.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---- paced interaction ----

/** A pause. The default is about as long as it takes to read a short line. */
export const beat = (page, ms = 900) => page.waitForTimeout(ms);

/** Travel the pointer to the middle of something, visibly. */
export async function point(page, target) {
  const loc = typeof target === 'string' ? page.locator(target) : target;
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  if (!box) throw new Error(`nothing to point at: ${target}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
  await beat(page, 320);
  return loc;
}

/** Travel, then click. Never page.click() in a clip -- it teleports. */
export async function tap(page, target, { after = 550 } = {}) {
  await point(page, target);
  await page.mouse.down();
  await beat(page, 90);
  await page.mouse.up();
  await beat(page, after);
}

/** Click into a field and type at a human rate. */
export async function type(page, target, text, { delay = 65 } = {}) {
  await tap(page, target, { after: 200 });
  await page.keyboard.type(text, { delay });
  await beat(page, 450);
}

/**
 * Move the pointer out of the way.
 *
 * The cursor is painted ON TOP of the page, so leaving it where it last
 * clicked covers whatever is underneath -- which, on the frame a viewer has
 * been asked to stop and read, is exactly the thing they were told to read.
 * Call this before any long beat on a code, a message, or a result.
 *
 * The default corner is not always empty. The editor's page rail runs down the
 * right edge and a long syllabus reaches (1180, 700), so parking there still
 * covered a tab -- pass an x/y clear of whatever that particular page draws.
 */
export async function park(page, { x = 1180, y = 700 } = {}) {
  await page.mouse.move(x, y, { steps: 14 });
  await beat(page, 200);
}

/** Bring something into view smoothly rather than jumping the page. */
export async function reveal(page, selector) {
  await page.evaluate((s) => document.querySelector(s)
    ?.scrollIntoView({ behavior: 'smooth', block: 'center' }), selector);
  await beat(page, 900);
}

// ---- the manifest ----

/**
 * What /how/ renders. Written by the recorder that owns the role so the words
 * and the clips are produced together and cannot drift.
 *
 *   { role, title, blurb, steps: [{ n, title, body, clip, clipDark?, note? }] }
 *
 * `clip` is a bare filename under public/how/media/. Checked here rather than
 * discovered at render time: a typo would otherwise be a silently missing
 * video on a help page, which is worse than a loud failure now.
 *
 * `clipDark` is added only when the dark variant is actually on disk, so a role
 * that has not been recorded in dark yet simply keeps showing its light clips
 * rather than pointing at a file that does not exist. That makes the dark pass
 * an addition rather than a migration -- either theme can be re-recorded on its
 * own without breaking the other.
 */
export function writeSteps(role, manifest) {
  mkdirSync(STEPS, { recursive: true });
  const steps = manifest.steps.map((s, i) => {
    const step = { ...s, n: i + 1 };
    const dark = s.clip?.replace(/\.mp4$/, '-dark.mp4');
    if (dark && existsSync(join(MEDIA, dark))) step.clipDark = dark;
    return step;
  });

  for (const s of steps) {
    if (!s.title || !s.body) throw new Error(`step ${s.n} of ${role} is missing title or body`);
    if (s.clip && !existsSync(join(MEDIA, s.clip))) {
      throw new Error(`step ${s.n} of ${role} points at a clip that was not recorded: ${s.clip}`);
    }
  }

  const out = { role, title: manifest.title, blurb: manifest.blurb, steps };
  writeFileSync(join(STEPS, `${role}.json`), JSON.stringify(out, null, 2) + '\n');
  console.log(`  wrote public/how/steps/${role}.json (${steps.length} steps)`);
}
