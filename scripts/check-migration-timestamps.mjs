#!/usr/bin/env node
// Fails when two migration files share a leading <timestamp> prefix.
//
// TypeORM runs pending migrations in timestamp order and identifies each solely
// by the `name` string on its class. A NEW accidental collision is almost
// always a copy-paste mistake and makes run-order between the two files
// ambiguous. A handful of collisions already exist in FROZEN history and are
// deliberate — renaming an applied migration makes it look pending and re-runs
// its `up()` (see CLAUDE.md) — so those are allowlisted rather than "fixed".
//
// BUILD-TIME ONLY. This reads the TypeScript sources in src/migrations, which
// exist in the Docker *build* stage but NOT in the runtime image (that copies
// only package.json, node_modules, dist and scripts). Do not chain it into a
// deploy step such as `migration:preflight`: it ENOENTs on /app/src/migrations
// and takes the whole preDeployCommand chain down with it. `pnpm build` already
// gates on it, and no migration file can appear between build and deploy.
//
// Run: node scripts/check-migration-timestamps.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = join(scriptDirectory, '..', 'src', 'migrations');

// Timestamps that are ALREADY duplicated in frozen migration history. Do NOT
// add to this to turn a red build green for a brand-new migration — give the
// new file a unique timestamp instead.
// Each entry below was audited on 2026-08-21: for every colliding pair the two
// files touch disjoint tables/enums, so their relative order cannot change the
// resulting schema. The single pair that shares an object
// (1790700000000: AddVolunteerApplicationNotificationTypes +
// AddWriterApplicationNotificationTypes) only appends four DISTINCT values to
// `notifications_type_enum`, and appending distinct enum values commutes.
// Re-run that audit before adding anything here (you should not need to).
//
// The 1794700000000-1794740000000 block was audited on 2026-08-26 under the
// same rule. Those seven collisions arose because two parallel work streams
// picked the same timestamp band; BOTH files in every pair had already been
// applied by the time the clash was noticed, so neither one could be
// renumbered — see CLAUDE.md, "an applied migration's name is frozen history".
// Pairs and the objects they touch, disjoint in every case:
//   1794700000000  events + event_rsvps        | topics.archived_at
//   1794701000000  event_announcements/bans    | topics rows (seed)
//   1794710000000  listings index              | forum_thread_subscription
//   1794720000000  conversation_participants   | housing/notification enums
//   1794730000000  notification_delivery_prefs | safe_space_nominations/flags
//   1794731000000  notifications               | safe_space_nominations rows
//   1794740000000  group_listings/notif enums  | saved_lists rows (backfill)
const allowedDuplicateTimestamps = new Set([
  '1782800650000',
  '1785003000000',
  '1785005000000',
  '1785900000000',
  '1786600000000',
  '1786800000000',
  '1787700100000',
  '1788600000000',
  '1790100000000',
  '1790600000000',
  '1790700000000',
  '1791900000000',
  '1792000000000',
  '1792700000000',
  '1793000000000',
  '1794700000000',
  '1794701000000',
  '1794710000000',
  '1794720000000',
  '1794730000000',
  '1794731000000',
  '1794740000000',
]);

let migrationFileNames;
try {
  migrationFileNames = readdirSync(migrationsDirectory).filter((fileName) =>
    fileName.endsWith('.ts'),
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  // Say what actually went wrong. A bare ENOENT here reads as a broken script,
  // and the one place it happens is the runtime image, where this has no
  // business running at all: chained into `migration:preflight` it took down
  // the whole preDeployCommand before `migration:run:prod` ever started, and
  // the only symptom downstream was a live app querying columns whose
  // migrations had silently never run.
  console.error(
    `No migration sources at ${migrationsDirectory}.\n` +
      'This script lints the TypeScript sources and only runs where they ' +
      'exist (the repo, CI, and the Docker BUILD stage). The runtime image ' +
      'carries only package.json, node_modules, dist and scripts.\n' +
      'If this ran during a deploy, remove it from that step: `pnpm build` ' +
      'already gates on it, and no migration file can appear between build ' +
      'and deploy.',
  );
  process.exit(1);
}

const fileNamesByTimestamp = new Map();
const malformedFileNames = [];

for (const fileName of migrationFileNames) {
  const timestampMatch = /^(\d+)-/.exec(fileName);
  if (!timestampMatch) {
    malformedFileNames.push(fileName);
    continue;
  }
  const timestamp = timestampMatch[1];
  const existingFileNames = fileNamesByTimestamp.get(timestamp) ?? [];
  existingFileNames.push(fileName);
  fileNamesByTimestamp.set(timestamp, existingFileNames);
}

const unexpectedDuplicates = [];
for (const [timestamp, fileNames] of fileNamesByTimestamp) {
  if (fileNames.length > 1 && !allowedDuplicateTimestamps.has(timestamp)) {
    unexpectedDuplicates.push({ timestamp, fileNames });
  }
}

let hasFailure = false;

if (malformedFileNames.length > 0) {
  hasFailure = true;
  console.error(
    'Migration file(s) without a <timestamp>-<Name>.ts prefix:\n',
  );
  for (const fileName of malformedFileNames) {
    console.error(`    - ${fileName}`);
  }
  console.error('');
}

if (unexpectedDuplicates.length > 0) {
  hasFailure = true;
  console.error('Duplicate migration timestamp(s) detected:\n');
  for (const { timestamp, fileNames } of unexpectedDuplicates) {
    console.error(`  ${timestamp}:`);
    for (const fileName of fileNames) {
      console.error(`    - ${fileName}`);
    }
  }
  console.error(
    '\nGive the NEW migration a unique timestamp. Never renumber an ' +
      'already-applied migration, and do not add it to the allowlist.',
  );
}

// A migration that executes `CREATE INDEX CONCURRENTLY` inside TypeORM's
// default transaction aborts with "CREATE INDEX CONCURRENTLY cannot run inside
// a transaction block", which breaks a from-scratch `migration:run` (CI, a new
// developer, a restore-from-backup rehearsal) even though it may have been
// applied by hand in an existing database. Opting the file out with
// `transaction = false` is the fix. Comments are stripped first so that a file
// merely EXPLAINING why it avoids CONCURRENTLY does not trip the check.
const concurrentlyWithoutOptOut = [];
for (const fileName of migrationFileNames) {
  const source = readFileSync(join(migrationsDirectory, fileName), 'utf8');
  const executableSource = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  if (!/CONCURRENTLY/i.test(executableSource)) continue;
  if (/transaction\s*=\s*false/.test(executableSource)) continue;
  concurrentlyWithoutOptOut.push(fileName);
}

if (concurrentlyWithoutOptOut.length > 0) {
  hasFailure = true;
  console.error(
    'Migration(s) running CONCURRENTLY inside a transaction:\n',
  );
  for (const fileName of concurrentlyWithoutOptOut) {
    console.error(`    - ${fileName}`);
  }
  console.error(
    '\nAdd `transaction = false as const;` to the class, and keep the ' +
      'concurrent index in its own migration so the rest stays atomic.',
  );
}

if (hasFailure) {
  process.exit(1);
}

console.log(
  `Checked ${migrationFileNames.length} migration file(s): no unexpected ` +
    `duplicate timestamps, no CONCURRENTLY inside a transaction.`,
);
