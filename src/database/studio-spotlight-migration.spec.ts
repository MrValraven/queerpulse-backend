// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { readFileSync } from 'fs';
import { join } from 'path';
import { QueryRunner } from 'typeorm';
import { AddStudioSpotlightArtists1838300000000 } from '../migrations/1838300000000-AddStudioSpotlightArtists';

const MIGRATION_PATH = join(
  __dirname,
  '..',
  'migrations',
  '1838300000000-AddStudioSpotlightArtists.ts',
);

function capturingRunner(): { runner: QueryRunner; statements: string[] } {
  const statements: string[] = [];
  const runner = {
    query: (sql: string) => {
      statements.push(sql.replace(/\s+/g, ' ').trim());
      return Promise.resolve();
    },
  } as unknown as QueryRunner;
  return { runner, statements };
}

async function upSql(): Promise<string> {
  const { runner, statements } = capturingRunner();
  await new AddStudioSpotlightArtists1838300000000().up(runner);
  return statements.join('\n');
}

describe('AddStudioSpotlightArtists1838300000000', () => {
  it('creates the slot type and the table with every contract constraint name', async () => {
    const sql = await upSql();

    expect(sql).toContain(
      `CREATE TYPE "studio_spotlight_slot" AS ENUM ('artist_of_the_month', 'new_stars')`,
    );
    expect(sql).toContain('CREATE TABLE "studio_spotlight_artists"');
    for (const constraintName of [
      'PK_studio_spotlight_artists',
      'UQ_studio_spotlight_artists_slot_subprofile',
      'UQ_studio_spotlight_artists_slot_position',
      'CHK_studio_spotlight_artists_position',
      'FK_studio_spotlight_artists_subprofile',
      'FK_studio_spotlight_artists_created_by',
    ]) {
      expect(sql).toContain(`CONSTRAINT "${constraintName}"`);
    }
  });

  it('keeps slot positions unique and deferrable', async () => {
    const sql = await upSql();

    expect(sql).toContain(
      'UNIQUE ("slot", "position") DEFERRABLE INITIALLY IMMEDIATE',
    );
    expect(sql).toContain('CHECK ("position" >= 1)');
  });

  it('cascades the persona key on delete and on update so an unlink re-key succeeds', async () => {
    const sql = await upSql();

    expect(sql).toContain(
      'FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id") ON DELETE CASCADE ON UPDATE CASCADE',
    );
  });

  it('lets a removed curator account leave the row', async () => {
    const sql = await upSql();

    expect(sql).toContain('REFERENCES "users"("id") ON DELETE SET NULL');
  });

  it('indexes the persona column', async () => {
    const sql = await upSql();

    expect(sql).toContain(
      'CREATE INDEX "IDX_studio_spotlight_artists_subprofile_id" ON "studio_spotlight_artists" ("subprofile_id")',
    );
  });

  it('drops the table and then the type in down', async () => {
    const { runner, statements } = capturingRunner();
    await new AddStudioSpotlightArtists1838300000000().down(runner);

    expect(statements).toEqual([
      'DROP TABLE "studio_spotlight_artists"',
      'DROP TYPE "studio_spotlight_slot"',
    ]);
  });

  it('opens with the DO NOT RUN banner and exports only the class', () => {
    const source = readFileSync(MIGRATION_PATH, 'utf8');

    expect(source.split('\n')[0]).toBe(
      '// DO NOT RUN: authored for review only; the maintainer runs migrations.',
    );
    expect(source).not.toMatch(/^export (async )?function|^export default/m);
  });
});
