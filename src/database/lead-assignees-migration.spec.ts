// Lives beside the migration runner in `src/database`, outside
// `src/migrations`: the TypeORM CLI and `DatabaseModule` both require every
// `src/migrations/*.ts` file in development, and requiring a spec there throws
// `describe is not defined` before any migration runs.
//
// The spec runs the migration class against a recording query runner and
// compares each statement with the contract text, whitespace collapsed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QueryRunner } from 'typeorm';
import { LEAD_ENTRY_KINDS } from '../leads/leads.constants';
import { AddLeadAssignees1840300000000 } from '../migrations/1840300000000-AddLeadAssignees';

const MIGRATION_PATH = join(
  __dirname,
  '..',
  'migrations',
  '1840300000000-AddLeadAssignees.ts',
);

/** The eleven statements of contract section 1 `up()`, in order. */
const CONTRACT_UP_STATEMENTS = [
  `ALTER TABLE "lead_entries" ALTER COLUMN "kind" TYPE character varying(32)`,
  `ALTER TABLE "lead_entries" DROP CONSTRAINT "CHK_lead_entries_kind"`,
  `ALTER TABLE "lead_entries" ADD CONSTRAINT "CHK_lead_entries_kind" CHECK ("kind" IN ('note', 'stage_changed', 'persona_linked', 'persona_unlinked', 'created', 'assignee_added', 'assignee_removed', 'assignee_access_ended'))`,
  `ALTER TABLE "lead_entries" ADD "subject_user_id" uuid`,
  `ALTER TABLE "lead_entries" ADD CONSTRAINT "CHK_lead_entries_subject" CHECK ("subject_user_id" IS NULL OR "kind" IN ('assignee_added', 'assignee_removed', 'assignee_access_ended'))`,
  `ALTER TABLE "lead_entries" ADD CONSTRAINT "FK_lead_entries_subject_user" FOREIGN KEY ("subject_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
  `CREATE INDEX "IDX_lead_entries_subject_user_id" ON "lead_entries" ("subject_user_id") WHERE "subject_user_id" IS NOT NULL`,
  `CREATE TABLE "lead_assignees" (
    "lead_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "assigned_by_id" uuid,
    "assigned_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT "PK_lead_assignees" PRIMARY KEY ("lead_id", "user_id"),
    CONSTRAINT "FK_lead_assignees_lead" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "FK_lead_assignees_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "FK_lead_assignees_assigned_by" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
  )`,
  `CREATE INDEX "IDX_lead_assignees_user_id" ON "lead_assignees" ("user_id")`,
  `CREATE INDEX "IDX_lead_assignees_assigned_by_id" ON "lead_assignees" ("assigned_by_id") WHERE "assigned_by_id" IS NOT NULL`,
  `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'lead_assigned'`,
];

/** The ten statements of contract section 1 `down()`, in order. */
const CONTRACT_DOWN_STATEMENTS = [
  `DELETE FROM "notifications" WHERE "type" = 'lead_assigned'`,
  `DROP TABLE "lead_assignees"`,
  `DELETE FROM "lead_entries" WHERE "kind" IN ('assignee_added', 'assignee_removed', 'assignee_access_ended')`,
  `DROP INDEX "IDX_lead_entries_subject_user_id"`,
  `ALTER TABLE "lead_entries" DROP CONSTRAINT "FK_lead_entries_subject_user"`,
  `ALTER TABLE "lead_entries" DROP CONSTRAINT "CHK_lead_entries_subject"`,
  `ALTER TABLE "lead_entries" DROP COLUMN "subject_user_id"`,
  `ALTER TABLE "lead_entries" DROP CONSTRAINT "CHK_lead_entries_kind"`,
  `ALTER TABLE "lead_entries" ADD CONSTRAINT "CHK_lead_entries_kind" CHECK ("kind" IN ('note', 'stage_changed', 'persona_linked', 'persona_unlinked', 'created'))`,
  `ALTER TABLE "lead_entries" ALTER COLUMN "kind" TYPE character varying(20)`,
];

/** `sql` with whitespace runs folded and the space inside parentheses dropped. */
function collapsed(sql: string): string {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
    .trim();
}

/** The collapsed text of every `query` call one direction makes, in order. */
async function statementsOf(direction: 'up' | 'down'): Promise<string[]> {
  const query = jest.fn().mockResolvedValue(undefined);
  await new AddLeadAssignees1840300000000()[direction]({
    query,
  } as unknown as QueryRunner);
  return query.mock.calls.map(([sql]: [string]) => collapsed(sql));
}

describe('AddLeadAssignees1840300000000', () => {
  it('opens with the review banner', () => {
    expect(readFileSync(MIGRATION_PATH, 'utf8').split('\n')[0]).toBe(
      '// DO NOT RUN: authored for review only; the maintainer runs migrations.',
    );
  });

  it('keeps the default migration transaction', () => {
    const migration = new AddLeadAssignees1840300000000();
    expect(migration.name).toBe('AddLeadAssignees1840300000000');
    expect(
      (migration as { transaction?: unknown }).transaction,
    ).toBeUndefined();
  });

  it('runs the contract statements in order with the enum append last', async () => {
    const statements = await statementsOf('up');
    expect(statements).toEqual(CONTRACT_UP_STATEMENTS.map(collapsed));
    expect(statements[statements.length - 1]).toContain(
      'ADD VALUE IF NOT EXISTS',
    );
  });

  it('reverts in the contract order and keeps the enum label', async () => {
    const statements = await statementsOf('down');
    expect(statements).toEqual(CONTRACT_DOWN_STATEMENTS.map(collapsed));
    expect(statements.join(' ')).not.toContain('notifications_type_enum');
  });

  it('lists every entry kind in the widened check', async () => {
    const statements = await statementsOf('up');
    const kindCheck = statements[2] ?? '';
    for (const kind of LEAD_ENTRY_KINDS) {
      expect(kindCheck).toContain(`'${kind}'`);
    }
    expect(statements[0]).toContain('character varying(32)');
  });
});
