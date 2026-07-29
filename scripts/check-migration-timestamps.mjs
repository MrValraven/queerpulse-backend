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
// Run: node scripts/check-migration-timestamps.mjs

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = join(scriptDirectory, '..', 'src', 'migrations');

// Timestamps that are ALREADY duplicated in frozen migration history. Do NOT
// add to this to turn a red build green for a brand-new migration — give the
// new file a unique timestamp instead.
const allowedDuplicateTimestamps = new Set(['1782800650000']);

const migrationFileNames = readdirSync(migrationsDirectory).filter((fileName) =>
  fileName.endsWith('.ts'),
);

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

if (hasFailure) {
  process.exit(1);
}

console.log(
  `Checked ${migrationFileNames.length} migration file(s); no unexpected duplicate timestamps.`,
);
