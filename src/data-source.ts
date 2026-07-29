import 'dotenv/config';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { resolvePostgresSsl } from './config/database-ssl';

// This data source backs the TypeORM CLI in BOTH environments:
//   - dev:  `typeorm-ts-node-commonjs -d src/data-source.ts`  (__filename ends .ts)
//   - prod: `typeorm -d dist/data-source.js`                  (__filename ends .js)
// Globs are anchored to __dirname (not cwd), so `pnpm run migration:run` works
// from source and `pnpm run migration:run:prod` works from the compiled output.
const ext = __filename.endsWith('.js') ? 'js' : 'ts';

export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [join(__dirname, '**', `*.entity.${ext}`)],
  migrations: [join(__dirname, 'migrations', `*.${ext}`)],
  namingStrategy: new SnakeNamingStrategy(),
  synchronize: false,
  // Run each pending migration in its own transaction instead of TypeORM's
  // default single all-or-nothing transaction. Required because some migrations
  // create indexes with `CREATE INDEX CONCURRENTLY`, which Postgres forbids
  // inside ANY transaction block (error 25001). Under the default `all` mode,
  // TypeORM wraps the whole batch in one transaction AND rejects any migration
  // that sets `transaction = false` (ForbiddenTransactionModeOverrideError), so
  // `each` is the only mode where a CONCURRENTLY migration can opt out of the
  // transaction per-migration (see those migrations' `transaction = false`).
  // Trade-off: a batch is no longer atomic across migrations — each commits
  // independently, so a mid-batch failure leaves earlier migrations applied.
  migrationsTransactionMode: 'each',
  // Shared with DatabaseModule — the CLI and the app MUST negotiate TLS
  // identically, or `migration:run:prod` succeeds against a connection the app
  // then cannot open. See src/config/database-ssl.ts.
  ssl: resolvePostgresSsl(),
  // Turn an undefined value in a `where` clause into an error instead of a
  // silently-dropped predicate (which would match/mutate an unintended row).
  invalidWhereValuesBehavior: { undefined: 'throw' },
});
