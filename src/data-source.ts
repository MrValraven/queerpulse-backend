import 'dotenv/config';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

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
  // Turn an undefined value in a `where` clause into an error instead of a
  // silently-dropped predicate (which would match/mutate an unintended row).
  invalidWhereValuesBehavior: { undefined: 'throw' },
});
