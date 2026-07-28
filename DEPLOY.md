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

`/api/admin/*` fails closed today: without Cloudflare Access there is no
identity header, so every admin request returns 401. That means the app is safe
on deploy but the admin routes are also unusable until Access is configured.

1. **Zero Trust → Access → Applications → Add an application → Self-hosted**
2. Domain: your Pages domain. Path: `/api/admin`
3. Policy: Allow → Emails → your address
4. Add a second application for `/admin` when the dashboard UI lands

Then narrow it in code as well, so a loose Access policy is not the only gate:

```bash
npx wrangler pages secret put ADMIN_EMAILS --project-name inishial
# or set it as a plain var in wrangler.toml — it is not secret
```

### 5b. Let other teachers sign themselves up

Set `TEACHER_DOMAINS` in `wrangler.toml` to your school's email domain, and
teachers can create their own account at `/admin/signup/`. Each one sees only
their own classes, rosters and syllabus.

```toml
TEACHER_DOMAINS = "yourschool.org"      # that domain exactly
TEACHER_DOMAINS = ".yourschool.org"     # and its subdomains
TEACHER_DOMAINS = ""                    # sign-up off (the default)
```

Empty means **nobody**, never "anybody" — leaving it unset is safe.

Two things to be clear-eyed about:

- **This does not verify identity.** Nothing emails the address, so anyone who
  knows the domain can claim any name at it. It narrows who can sign up; it
  does not prove who they are. If you need proof, put Cloudflare Access in
  front of `/admin/*` — `requireAdmin` already accepts an Access identity.
- **Set `ADMIN_EMAILS` first.** The first account to sign up adopts every class
  that predates teacher accounts. With `ADMIN_EMAILS` set, only an address on
  that list can, so a colleague signing up ahead of you cannot walk off with
  your roster.

Upgrading a database that already has data:

```bash
npm run db:upgrade      # applies migrations/0002_teachers.sql to production
```

### 6. Optional, for the AI authoring pass

```bash
npx wrangler pages secret put OLLAMA_API_KEY --project-name inishial
```

Not needed until the editor exists.

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
