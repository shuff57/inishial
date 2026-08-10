# Deploying iniSHial

## Already done

- **D1 database created and migrated.** Name `inishial`, id
  `26a2ff24-a632-4b74-9034-3b40622b15fa`, primary region WNAM. All 9 tables
  exist in production. `wrangler.toml` already points at it.
- **`SESSION_SECRET` generated** — 48 random bytes, base64url. It is sitting in
  `.secrets.local`, which is gitignored. It has never been committed and is not
  in the repo.

## What has to be done by you

Deploying Pages needs an authenticated Cloudflare session. An API token can
only be minted from the dashboard by the account owner, so these steps need
your hands.

### 1. Authenticate

```bash
npm install
npx wrangler login          # opens a browser
```

Or, if you would rather use a scoped token than a browser session, create one
at **dashboard → My Profile → API Tokens → Create Token** with:

| Permission | Scope |
|---|---|
| Account · Cloudflare Pages | Edit |
| Account · D1 | Edit |
| Account · Workers Scripts | Edit |

Then `export CLOUDFLARE_API_TOKEN=...` before the commands below.

### 2. Create the Pages project

```bash
npx wrangler pages project create inishial --production-branch main
```

### 3. Push the session secret

```bash
# reads the value out of .secrets.local without printing it
grep -oP '(?<=SESSION_SECRET=).*' .secrets.local \
  | npx wrangler pages secret put SESSION_SECRET --project-name inishial
```

### 4. Deploy

```bash
npx wrangler pages deploy public --project-name inishial
```

### 5. Lock down admin — do this before uploading a real roster

`requireAdmin` accepts EITHER of two independent credentials, so the admin side
is reachable without Access:

- a signed-up teacher's email + password (`/admin/signup/`, `/admin/login/`)
- the shared `ADMIN_PASSWORD_HASH`

It used to be true that admin "fails closed without Access" — that was written
before teacher accounts existed and is no longer the case. Access is a second
gate in front of those, not the only one. Configure it when you want the admin
side unreachable to anyone who has not already passed an identity check at the
edge, which is worth doing before a real roster is uploaded.

1. **Zero Trust → Access → Applications → Add an application → Self-hosted**
2. Domain: your Pages domain. Path: `/api/admin`
3. Policy: Allow → Emails → your address
4. Add a second application for `/admin` when the dashboard UI lands

Then narrow it in code as well, so a loose Access policy is not the only gate:

```bash
npx wrangler pages secret put ADMIN_EMAILS --project-name inishial
# or set it as a plain var in wrangler.toml — it is not secret
```

### 5a. What the operator can and cannot see

Running this app does not make you able to read other people's students, and
that is enforced rather than promised. Both operator credentials — the shared
`ADMIN_PASSWORD_HASH` and a Cloudflare Access identity — resolve to
`teacherId: null`, and `owns()` in `_lib/http.js` reads that as **unowned
courses only**, never "everything":

```js
admin.teacherId == null ? ownerId == null : ownerId === admin.teacherId
```

So a course belonging to a signed-up teacher is invisible to both. Asking for
one answers "No such course" — the same words as a course that does not exist,
so the boundary cannot be used to enumerate what other teachers have.
`tests/adminauth.test.mjs` pins all three cases (shared password, Access
identity, and a teacher reaching for a colleague's class).

Two things this does NOT cover, stated plainly because it would be easy to read
the above as more than it is:

- **Direct database access.** Anyone who can query D1 reads everything, and no
  amount of in-app authorisation changes that. Names, student IDs and parent
  addresses are stored in the clear; only access codes and passwords are hashed,
  and the codes are additionally sealed under `CODE_SECRET` so the teacher can
  read them back — which means whoever holds the database AND that secret can
  read every code. Encrypting the PII columns would not close this either: the
  Worker must decrypt to display, so the key has to be reachable from the same
  account that can read the database.
- **`adoptUnownedCourses`.** The first teacher to sign up (or any address in
  `ADMIN_EMAILS`) absorbs every course with no owner. That is how legacy classes
  find a home, but it does mean the first account can end up owning a class
  somebody else imported under the shared password. Set `ADMIN_EMAILS` before
  anyone else signs up.

### 5b. Who can sign themselves up

Sign-up at `/admin/signup/` is **open by default**: anyone who finds the site
can create a teacher account. Each account sees only its own classes, rosters
and syllabus.

To restrict it to one school, set `TEACHER_DOMAINS` in `wrangler.toml`:

```toml
TEACHER_DOMAINS = ""                    # any address (the default)
TEACHER_DOMAINS = "yourschool.org"      # that domain exactly
TEACHER_DOMAINS = ".yourschool.org"     # and its subdomains
```

Empty means **anybody**. That is a reversal of how this used to work, so if you
are upgrading and were relying on an unset value to keep sign-up closed, set the
variable explicitly.

Two things to be clear-eyed about:

- **This does not verify identity.** Nothing emails the address, so an account
  proves only that someone typed a plausible string. With sign-up open, that
  means a stranger can reach the admin side and create their own classes. What
  still holds: an account sees only its own courses, its address is recorded
  against every roster import it makes, and sign-ups are rate limited to five
  per hour per IP. If you need real proof, put Cloudflare Access in front of
  `/admin/*`, which `requireAdmin` already accepts an identity from.
- **Set `ADMIN_EMAILS` first.** The first account to sign up adopts every class
  that predates teacher accounts. With `ADMIN_EMAILS` set, only an address on
  that list can, so a colleague signing up ahead of you cannot walk off with
  your roster.

Upgrading a database that already has data:

```bash
npm run db:upgrade      # applies migrations/0006 onward to production
```

`db:upgrade` starts at 0006 because that is what a database deployed before
those migrations is missing. If yours is older, say where to start:

```bash
node scripts/migrate.mjs --remote --from 4
```

**Every migration on disk has to reach production.** The commands above read
the `migrations/` directory rather than a list, because the list they replaced
went stale: 0006 and 0007 shipped while all three db: scripts still stopped at
0005, so a deployment ran without a column the Classes page selects. The
symptom was not obviously a schema problem — the page reported "Could not load
classes", and every class was still in the table. After adding a migration,
deploy it and run the upgrade; the page failing to list classes is worth
checking here first.

**Migrate BEFORE you deploy the code, not after.** The two steps are separate
commands and nothing enforces the order, so it is worth stating: new code reads
columns the migration adds, and a Function that selects a column the database
does not have fails the whole request rather than degrading. Running 0014's
code against a pre-0014 database does not produce a missing session feature —
it produces `no such column: si.parent_session_gen` on every attempt to sign
in, which is the whole sign-in surface down.

How long that gap is safe depends on the migration, and the two shipped
together here are not the same:

- **0014, 0015 and 0016 are additive.** They only add columns with defaults, so
  the old code neither knows nor cares. Migrate whenever; deploy whenever
  after. Sessions issued before the deploy keep working — a token with no
  generation claim reads as generation 0, which is what every untouched row
  holds, so nobody is signed out by the deploy itself.
- **0013 (school-scoped usernames) REWRITES values**, and the old code derives
  the old shape. Between running it and deploying, `904511@s` is what the
  running code builds and looks for while `904511@s1` is what the database
  holds — so sign-in fails for everyone until the deploy lands. Run it as close
  to the deploy as you can, and do not roll the code back past it without
  reversing the rewrite.

One thing that is NOT a migration and is worth knowing: rotating
`ADMIN_PASSWORD_HASH` is the only way to end a shared-password admin session.
Teacher accounts carry a session generation and can be signed out (0016), but
the shared password is deliberately tied to no account, so there is no row to
mark. Rotate the secret if you ever need those sessions gone.

The tests cover the migrated schema only, since the suite applies every
migration in `migrations/` before it runs. The half-migrated state is not
covered by anything and is not meant to last longer than the deploy.

### 6. Optional, for the AI authoring pass

```bash
npx wrangler pages secret put OLLAMA_API_KEY --project-name inishial
```

Not needed until the editor exists.

### 7. Optional, for the donation button

The `Buy Steven a coffee` card uses BMC's hosted widget loaded from
`cdnjs.buymeacoffee.com`. No backend, no secrets, no Stripe keys.

It runs on the public pages and on the teacher pages (sign-in, sign-up,
Classes, access codes, Who has signed). Not the syllabus editor: BMC pins its
chip at `--nav-h + 24px`, which on that page lands inside the sticky toolbar.

To switch handles later, edit `data-id="shuff57"` in the BMC `<script>` tag on
each page that carries it — `grep -rl 'BMC-Widget' public/` lists them — plus
`data-slug` in the loader tag in `public/index.html`. Behaviour and the panel's
height cap live in `public/bmc.js`, which every page shares.

The suggested amounts on the panel (`+10 / +25 / +50`) are NOT set here. They
come back from BMC's server against the account: the embed can only send
`description` and `color`. Change them in the Buy Me a Coffee dashboard, in the
setting their API calls `suggested_amounts`.

## Verifying the deploy

```bash
curl -s https://inishial.pages.dev/api/sign/syllabus            # expect 401
curl -s https://inishial.pages.dev/api/admin/roster             # expect 401
curl -s -o /dev/null -w '%{http_code}\n' https://inishial.pages.dev/   # expect 200
```

Two 401s and a 200 is the correct shape: nothing readable without a session,
nothing administrable without Access, and the landing page public.

## Rotating the session secret

Rotating invalidates every open signing session — parents mid-syllabus will be
asked to re-enter their code. Signatures already recorded are unaffected.

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))" \
  | npx wrangler pages secret put SESSION_SECRET --project-name inishial
```

## Note on production data

The production database is **empty**. The demo roster and seeded Algebra I
syllabus exist only in the local `.dev.sqlite` and were never uploaded. Nothing
in production contains student data until you upload a real roster.
