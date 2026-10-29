// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { readFileSync } from 'fs';
import { join } from 'path';
import { QueryRunner } from 'typeorm';
import { AddMusicGatheringFamily1838200000000 } from '../migrations/1838200000000-AddMusicGatheringFamily';
import { RefileMusicFormatEvents1838200100000 } from '../migrations/1838200100000-RefileMusicFormatEvents';

const BANNER =
  '// DO NOT RUN: authored for review only; the maintainer runs migrations.';

const MIGRATION_FILE_NAMES = [
  '1838200000000-AddMusicGatheringFamily.ts',
  '1838200100000-RefileMusicFormatEvents.ts',
];

const FORMAT_KEYS_BY_OLD_FAMILY: Record<string, string[]> = {
  party: ['club-night', 'listening-party', 'karaoke'],
  make: ['jam-session'],
  watch: ['live-performance'],
};

function buildFakeRunner(): {
  runner: QueryRunner;
  query: jest.Mock;
  statements: () => string[];
} {
  const query = jest.fn().mockResolvedValue(undefined);
  const fakeRunner: Pick<QueryRunner, 'query'> = { query };
  return {
    runner: fakeRunner as unknown as QueryRunner,
    query,
    statements: () =>
      query.mock.calls.map((call: unknown[]) => String(call[0])),
  };
}

describe('AddMusicGatheringFamily1838200000000', () => {
  it('adds the music label to events_gathering_family_enum and nothing else', async () => {
    const { runner, query } = buildFakeRunner();
    await new AddMusicGatheringFamily1838200000000().up(runner);
    expect(query.mock.calls).toEqual([
      [`ALTER TYPE "events_gathering_family_enum" ADD VALUE 'music'`],
    ]);
  });

  it('refuses to go down because Postgres cannot drop an enum value', async () => {
    await expect(
      new AddMusicGatheringFamily1838200000000().down(),
    ).rejects.toThrow(/Irreversible/);
  });
});

describe('RefileMusicFormatEvents1838200100000', () => {
  it('re-files each format from its own old family only', async () => {
    const { runner, statements } = buildFakeRunner();
    await new RefileMusicFormatEvents1838200100000().up(runner);
    const sentStatements = statements();
    expect(sentStatements).toHaveLength(3);
    for (const statement of sentStatements) {
      expect(statement).toMatch(
        /SET "gathering_family" = 'music' WHERE "gathering_family" = '(party|make|watch)' AND "event_type" IN \(/,
      );
    }
    for (const [oldFamily, formatKeys] of Object.entries(
      FORMAT_KEYS_BY_OLD_FAMILY,
    )) {
      const statement = sentStatements.find((candidate) =>
        candidate.includes(`"gathering_family" = '${oldFamily}'`),
      );
      expect(statement).toBeDefined();
      expect(statement).toContain(
        `IN (${formatKeys.map((formatKey) => `'${formatKey}'`).join(', ')})`,
      );
    }
  });

  it('never writes format_details', async () => {
    const { runner, statements } = buildFakeRunner();
    const migration = new RefileMusicFormatEvents1838200100000();
    await migration.up(runner);
    await migration.down(runner);
    for (const statement of statements()) {
      expect(statement).not.toContain('format_details');
    }
  });

  it('maps every moved key back to its old family on down', async () => {
    const { runner, statements } = buildFakeRunner();
    await new RefileMusicFormatEvents1838200100000().down(runner);
    const sentStatements = statements();
    expect(sentStatements).toHaveLength(3);
    for (const [oldFamily, formatKeys] of Object.entries(
      FORMAT_KEYS_BY_OLD_FAMILY,
    )) {
      const statement = sentStatements.find((candidate) =>
        candidate.includes(`SET "gathering_family" = '${oldFamily}'`),
      );
      expect(statement).toBeDefined();
      expect(statement).toContain(`WHERE "gathering_family" = 'music'`);
      expect(statement).toContain(
        `IN (${formatKeys.map((formatKey) => `'${formatKey}'`).join(', ')})`,
      );
    }
  });
});

describe('music family migration files', () => {
  it('opens both files with the DO NOT RUN banner and exports only the class', () => {
    for (const fileName of MIGRATION_FILE_NAMES) {
      const source = readFileSync(
        join(__dirname, '..', 'migrations', fileName),
        'utf8',
      );
      expect(source.split('\n')[0]).toBe(BANNER);
      expect(source).not.toMatch(/^export (async )?function|^export default/m);
    }
  });
});
