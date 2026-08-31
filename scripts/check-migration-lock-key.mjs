#!/usr/bin/env node
// Fails when the Postgres advisory-lock key drifts between its TypeScript home
// and the standalone deploy script that has to hard-code a copy.
//
// WHY THIS GATE EXISTS. Three processes in this repo take the same advisory
// lock so that no two of them build or drop an index at the same time: the
// boot-time catch-up run (src/database/apply-pending-migrations.ts), the
// pre-deploy ledger reconcile (src/database/reconcile-renamed-migrations-cli.ts)
// and the pre-deploy invalid-index sweep (scripts/migration-preflight.mjs). The
// first two import MIGRATION_LOCK_KEY from src/database/migration-lock.ts. The
// third cannot: it runs standalone against a container that carries no compiled
// dist/, so it hard-codes the number.
//
// An advisory lock is only an agreed-upon integer. Two processes exclude each
// other if and only if they pick the same one, and Postgres says NOTHING when
// they do not: both calls succeed, both think they hold the lock, and the
// mutual exclusion is simply gone. The failure is invisible until the day a
// deploy drops an index another runner is mid-way through building.
//
// So the duplication is load-bearing and cannot be removed. This gate makes it
// loud instead: change the key in one file and the build stops.
//
// Run: node scripts/check-migration-lock-key.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, '..');

const sources = [
  {
    path: join(repositoryRoot, 'src', 'database', 'migration-lock.ts'),
    label: 'src/database/migration-lock.ts',
    pattern: /export const MIGRATION_LOCK_KEY\s*=\s*([0-9_]+)/,
  },
  {
    path: join(repositoryRoot, 'scripts', 'migration-preflight.mjs'),
    label: 'scripts/migration-preflight.mjs',
    pattern: /const MIGRATION_LOCK_KEY\s*=\s*([0-9_]+)/,
  },
];

const found = [];
for (const source of sources) {
  const contents = readFileSync(source.path, 'utf8');
  const match = source.pattern.exec(contents);
  if (!match) {
    console.error(
      `Could not find a MIGRATION_LOCK_KEY declaration in ${source.label}. ` +
        'Either it was renamed or the declaration no longer matches the ' +
        'pattern this gate looks for. Update scripts/check-migration-lock-key.mjs ' +
        'so the two keys stay compared.',
    );
    process.exit(1);
  }
  // Numeric separators are legal in both files and mean nothing to the value.
  found.push({ label: source.label, key: match[1].replaceAll('_', '') });
}

const [first, ...rest] = found;
const drifted = rest.filter((entry) => entry.key !== first.key);

if (drifted.length > 0) {
  console.error('Migration advisory-lock key has drifted:');
  for (const entry of found) {
    console.error(`  ${entry.label}: ${entry.key}`);
  }
  console.error(
    '\nEvery process that takes this lock must use the same integer or they ' +
      'stop excluding each other, silently. Make the values identical.',
  );
  process.exit(1);
}

console.log(
  `Migration advisory-lock key matches across ${found.length} file(s): ${first.key}.`,
);
