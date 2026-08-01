// Apply migrations, in order, by reading the migrations directory.
//
//   node scripts/migrate.mjs --local             everything, local D1
//   node scripts/migrate.mjs --remote            everything, production
//   node scripts/migrate.mjs --remote --from 6   only 0006 and later
//
// The list used to live inline in three npm scripts, hand-maintained, and it
// went stale exactly the way a hand-maintained list does: 0006 and 0007 were on
// disk and in none of them, so a deployed database was missing a column the
// Classes page selects and the page answered "Could not load classes" for a
// teacher whose classes were all still there. Reading the directory removes the
// step somebody has to remember.
//
// NOT idempotent, deliberately. `CREATE TABLE courses` fails on a database that
// already has one, and that failure is information -- it says this database was
// set up already and wants --from, not a full replay. Swallowing those errors
// would mean never being able to tell "already applied" from "did not apply".
//
// Cloudflare ships `wrangler d1 migrations apply`, which tracks what it has run
// in a d1_migrations table and would make --from unnecessary. Adopting it on a
// database created before it means seeding that table with the migrations
// already applied, by hand, once. Worth doing; not worth doing blind.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = new URL('../migrations/', import.meta.url);
const argv = process.argv.slice(2);

const target = argv.includes('--remote') ? '--remote' : argv.includes('--local') ? '--local' : null;
if (!target) {
  console.error('\n  Say which database:\n\n    node scripts/migrate.mjs --local\n    node scripts/migrate.mjs --remote [--from 6]\n');
  process.exit(1);
}

// `--from 6` rather than `--from 0006`: the padding is a filename detail.
const fromArg = argv[argv.indexOf('--from') + 1];
const from = argv.includes('--from') ? Number(fromArg) : 0;
if (argv.includes('--from') && !Number.isInteger(from)) {
  console.error(`\n  --from wants a migration number, got "${fromArg}".\n`);
  process.exit(1);
}

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()                                   // zero-padded, so lexical order is numeric order
  .filter((f) => Number(f.slice(0, 4)) >= from);

if (!files.length) {
  console.log(`  Nothing to apply${from ? ` from ${String(from).padStart(4, '0')} onward` : ''}.`);
  process.exit(0);
}

console.log(`\n  ${target.slice(2)} · applying ${files.length} migration${files.length === 1 ? '' : 's'}\n`);

for (const file of files) {
  process.stdout.write(`  ${file} ... `);
  const res = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'd1', 'execute', 'inishial', target, '--yes', `--file=migrations/${file}`],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (res.status !== 0) {
    console.log('failed\n');
    process.stderr.write(String(res.stderr || res.stdout || res.error?.message || ''));
    // Stop rather than carry on. Migrations after a failed one assume it ran,
    // and applying them anyway is how a schema ends up half-shaped.
    console.error(`\n  Stopped at ${file}. Nothing after it was applied.`);
    console.error('  If this database already has the earlier ones, re-run with'
      + ` --from ${Number(file.slice(0, 4))}.\n`);
    process.exit(1);
  }
  console.log('ok');
}

console.log('\n  Done.\n');
