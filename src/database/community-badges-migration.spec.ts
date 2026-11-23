// Lives beside the migration runner in `src/database`, outside
// `src/migrations`: the TypeORM CLI and `DatabaseModule` both require every
// `src/migrations/*.ts` file in development, and requiring a spec there throws
// `describe is not defined` before any migration runs.
//
// The spec runs the migration class against a recording query runner and
// compares each statement with the plan text, whitespace collapsed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMetadataArgsStorage, type QueryRunner } from 'typeorm';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { AddCommunityBadges1840700000000 } from '../migrations/1840700000000-AddCommunityBadges';

const MIGRATION_PATH = join(
  __dirname,
  '..',
  'migrations',
  '1840700000000-AddCommunityBadges.ts',
);

/** The eight enum label appends that close `up()`, in order. */
const LABEL_STATEMENTS = [
  `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'community_badge_earned'`,
  `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'community_gift_received'`,
  `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'badge_created'`,
  `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'badge_updated'`,
  `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'badge_deleted'`,
  `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'gift_sent'`,
  `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'gift_removed'`,
  `ALTER TYPE "reports_subject_type_enum" ADD VALUE IF NOT EXISTS 'community_gift'`,
];

/** The ten `down()` statements, in order. */
const DOWN_STATEMENTS = [
  `DELETE FROM "notifications" WHERE "type" IN ('community_badge_earned', 'community_gift_received')`,
  `DELETE FROM "community_governance_log" WHERE "action" IN ('badge_created', 'badge_updated', 'badge_deleted', 'gift_sent', 'gift_removed')`,
  `DROP INDEX "IDX_community_members_worn_badge_id"`,
  `ALTER TABLE "community_members" DROP CONSTRAINT "FK_community_members_worn_badge_id"`,
  `ALTER TABLE "community_members" DROP COLUMN "worn_badge_id"`,
  `ALTER TABLE "community_members" DROP COLUMN "events_attended_count"`,
  `DROP TABLE "community_gifts"`,
  `DROP TABLE "community_badge_awards"`,
  `DROP TABLE "community_badges"`,
  `DROP TYPE "community_badges_rule_type_enum"`,
];

/** `sql` with whitespace runs folded and the space inside parentheses dropped. */
function collapsed(sql: string): string {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
    .trim();
}

/** One recorded `query` call: the collapsed SQL and its parameters. */
type RecordedCall = [string, unknown[] | undefined];

/** Every `query` call one direction makes, in order. */
async function callsOf(direction: 'up' | 'down'): Promise<RecordedCall[]> {
  const query = jest.fn().mockResolvedValue(undefined);
  await new AddCommunityBadges1840700000000()[direction]({
    query,
  } as unknown as QueryRunner);
  return query.mock.calls.map(
    ([sql, parameters]: [string, unknown[] | undefined]): RecordedCall => [
      collapsed(sql),
      parameters,
    ],
  );
}

describe('AddCommunityBadges1840700000000', () => {
  let upCalls: RecordedCall[];
  let upStatements: string[];
  let downStatements: string[];

  beforeAll(async () => {
    upCalls = await callsOf('up');
    upStatements = upCalls.map(([sql]) => sql);
    downStatements = (await callsOf('down')).map(([sql]) => sql);
  });

  it('opens with the review banner', () => {
    expect(readFileSync(MIGRATION_PATH, 'utf8').split('\n')[0]).toBe(
      '// DO NOT RUN: authored for review only; the maintainer runs migrations.',
    );
  });

  it('carries the ledger name', () => {
    const migration = new AddCommunityBadges1840700000000();
    expect(migration.name).toBe('AddCommunityBadges1840700000000');
    expect(
      (migration as { transaction?: unknown }).transaction,
    ).toBeUndefined();
  });

  it('runs the 33 up statements in order', () => {
    expect(upStatements).toHaveLength(33);
    expect(upStatements[0]).toBe(
      `CREATE TYPE "community_badges_rule_type_enum" AS ENUM ('tenure_days', 'events_checked_in', 'volunteer_hours', 'posts_and_replies')`,
    );
    expect(upStatements[3]).toBe(
      `CREATE UNIQUE INDEX "UQ_community_badges_community_name" ON "community_badges" ("community_id", lower("name"))`,
    );
    expect(upStatements[16]).toBe(
      `ALTER TABLE "community_members" ADD "worn_badge_id" uuid`,
    );
    expect(upStatements[19]).toBe(
      `ALTER TABLE "community_members" ADD "events_attended_count" integer NOT NULL DEFAULT 0`,
    );
  });

  it('starts the tally per roster row from distinct events checked in since joining', () => {
    expect(upStatements[20]).toContain(
      'SELECT "cm"."id" AS "member_id", count(DISTINCT "r"."event_id")::int AS "total"',
    );
    expect(upStatements[20]).toContain(
      'JOIN "events" "e" ON "e"."community_id" = "cm"."community_id"',
    );
    expect(upStatements[20]).toContain(
      'JOIN "event_rsvps" "r" ON "r"."event_id" = "e"."id" AND "r"."user_id" = "cm"."user_id"',
    );
    expect(upStatements[20]).toContain(
      'WHERE "r"."checked_in_at" IS NOT NULL AND "r"."checked_in_at" >= "cm"."joined_at"',
    );
    expect(upStatements[20]).toContain('GROUP BY "cm"."id"');
    expect(upStatements[20]).toContain('WHERE "m"."id" = "tally"."member_id"');
  });

  it('pins the threshold ranges of every rule', () => {
    expect(upStatements[1]).toContain(
      `("rule_type" = 'tenure_days' AND "threshold" BETWEEN 30 AND 3650)`,
    );
    expect(upStatements[1]).toContain(
      `("rule_type" = 'events_checked_in' AND "threshold" BETWEEN 1 AND 500)`,
    );
    expect(upStatements[1]).toContain(
      `("rule_type" = 'volunteer_hours' AND "threshold" BETWEEN 1 AND 1000)`,
    );
    expect(upStatements[1]).toContain(
      `("rule_type" = 'posts_and_replies' AND "threshold" BETWEEN 1 AND 5000)`,
    );
  });

  it('seeds the four starters for top-level communities only, staggered by a millisecond', () => {
    const seedCalls = upCalls.slice(21, 25);
    expect(seedCalls.map(([, parameters]) => parameters)).toEqual([
      ['regular', 'Regular', 'calendar', 'jade', 'events_checked_in', 3, 0],
      ['old_friend', 'Old friend', 'clock', 'plum', 'tenure_days', 365, 1],
      [
        'helping_hands',
        'Helping hands',
        'life_buoy',
        'amber',
        'volunteer_hours',
        5,
        2,
      ],
      [
        'in_the_conversation',
        'In the conversation',
        'message_circle',
        'accent',
        'posts_and_replies',
        10,
        3,
      ],
    ]);
    for (const [sql] of seedCalls) {
      expect(sql).toContain(
        'WHERE "c"."parent_id" IS NULL ON CONFLICT DO NOTHING',
      );
      expect(sql).toContain("now() + ($7 * interval '1 millisecond')");
      expect(sql).not.toContain('community_badge_awards');
    }
  });

  it('appends the eight labels last and only with ADD VALUE IF NOT EXISTS', () => {
    expect(upStatements.slice(25)).toEqual(LABEL_STATEMENTS);
    expect(upStatements.slice(0, 25).join(' ')).not.toContain('IF NOT EXISTS');
  });

  it('drops the column, tables and the rule enum on down', () => {
    expect(downStatements).toEqual(DOWN_STATEMENTS);
  });

  it('keeps worn flair out of every roster save', () => {
    const column = getMetadataArgsStorage().columns.find(
      (columnArgs) =>
        columnArgs.target === CommunityMember &&
        columnArgs.propertyName === 'wornBadgeId',
    );
    expect(column?.options).toEqual({
      type: 'uuid',
      nullable: true,
      update: false,
    });
  });

  it('keeps the attendance tally out of every roster save', () => {
    const column = getMetadataArgsStorage().columns.find(
      (columnArgs) =>
        columnArgs.target === CommunityMember &&
        columnArgs.propertyName === 'eventsAttendedCount',
    );
    expect(column?.options).toEqual({
      type: 'integer',
      default: 0,
      update: false,
    });
  });
});
