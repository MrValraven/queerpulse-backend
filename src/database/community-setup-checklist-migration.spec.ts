// Lives beside the migration runner in `src/database`, outside
// `src/migrations`: the TypeORM CLI and `DatabaseModule` both require every
// `src/migrations/*.ts` file in development, and requiring a spec there throws
// `describe is not defined` before any migration runs.
//
// The spec runs the migration class against a recording query runner and
// compares each statement with the contract text, whitespace collapsed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMetadataArgsStorage } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import { Community } from '../communities/entities/community.entity';
import { AddCommunitySetupChecklistDismissedAt1840500000000 } from '../migrations/1840500000000-AddCommunitySetupChecklistDismissedAt';

const MIGRATION_PATH = join(
  __dirname,
  '..',
  'migrations',
  '1840500000000-AddCommunitySetupChecklistDismissedAt.ts',
);

/** `sql` with whitespace runs folded to single spaces. */
function collapsed(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** The collapsed text of every `query` call one direction makes, in order. */
async function statementsOf(direction: 'up' | 'down'): Promise<string[]> {
  const recordedStatements: string[] = [];
  const recordingQueryRunner = {
    query: (sql: string) => {
      recordedStatements.push(collapsed(sql));
      return Promise.resolve(undefined);
    },
  } as unknown as QueryRunner;
  await new AddCommunitySetupChecklistDismissedAt1840500000000()[direction](
    recordingQueryRunner,
  );
  return recordedStatements;
}

describe('AddCommunitySetupChecklistDismissedAt1840500000000', () => {
  it('adds the nullable column in one statement', async () => {
    expect(await statementsOf('up')).toEqual([
      'ALTER TABLE "communities" ADD "setup_checklist_dismissed_at" TIMESTAMP WITH TIME ZONE',
    ]);
  });

  it('drops the column on down', async () => {
    expect(await statementsOf('down')).toEqual([
      'ALTER TABLE "communities" DROP COLUMN "setup_checklist_dismissed_at"',
    ]);
  });

  it('carries the ledger name', () => {
    expect(new AddCommunitySetupChecklistDismissedAt1840500000000().name).toBe(
      'AddCommunitySetupChecklistDismissedAt1840500000000',
    );
  });

  it('opens with the review banner', () => {
    expect(readFileSync(MIGRATION_PATH, 'utf8').split('\n')[0]).toBe(
      '// DO NOT RUN: authored for review only; the maintainer runs migrations.',
    );
  });

  it('keeps the column out of every entity save', () => {
    const column = getMetadataArgsStorage().columns.find(
      (columnArgs) =>
        columnArgs.target === Community &&
        columnArgs.propertyName === 'setupChecklistDismissedAt',
    );
    expect(column?.options).toEqual({
      type: 'timestamptz',
      nullable: true,
      update: false,
    });
  });
});
