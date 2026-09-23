// Lives beside the migration runner in `src/database`, outside
// `src/migrations`: the TypeORM CLI and `DatabaseModule` both require every
// `src/migrations/*.ts` file in development, and requiring a spec there throws
// `describe is not defined` before any migration runs.
//
// The migration itself lives in the sibling `pending-migrations/` folder
// (neither glob loads that folder either), not in `src/migrations`, until its
// handover blockers clear; see `pending-migrations/README.md`. This spec
// reads it in place, so it keeps guarding the file whichever folder it is in.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The text of the one `queryRunner.query` call that contains `marker`. */
function statementContaining(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  const start = source.lastIndexOf('queryRunner.query(`', markerIndex);
  const end = source.indexOf('`', markerIndex);
  return source.slice(start, end);
}

const sql = readFileSync(
  join(
    __dirname,
    'pending-migrations',
    '1821260000000-MigrateEnquiryThreadsToListingMailboxes.ts',
  ),
  'utf8',
);

describe('the enquiry migration protects private history', () => {
  it('gives co-manager seats a cleared_at floor', () => {
    expect(sql).toMatch(/cleared_at/);
  });

  it('never seats a co-manager without that floor', () => {
    const insertBlock = sql.slice(
      sql.indexOf('INSERT INTO "conversation_participants"'),
    );
    expect(insertBlock.slice(0, 1200)).toMatch(/cleared_at/);
  });

  it('only re-attributes messages sent at or after the first enquiry', () => {
    const reattribution = statementContaining(
      sql,
      'SET "sender_identity_id" = "move"."listing_identity_id"',
    );
    expect(reattribution).toContain(
      '"message"."created_at" >= "move"."floor_instant"',
    );
    expect(reattribution).toContain(
      '"message"."sender_id" = "move"."owner_user_id"',
    );
  });

  it('builds every co-manager floor from whole milliseconds that cover earlier messages', () => {
    const eligibleSet = statementContaining(
      sql,
      'CREATE TEMP TABLE "enquiry_thread_moves"',
    );
    expect(eligibleSet).toContain(
      `date_trunc('milliseconds', "latest_before_floor" + interval '999 microseconds')`,
    );
    expect(eligibleSet).toContain(
      '"message"."created_at" < "thread_facts"."floor_instant"',
    );
    expect(eligibleSet).toMatch(
      /WHEN date_trunc\('milliseconds', "floor_instant"\) <= "staff_floor_base"\s+THEN GREATEST\(\s+"staff_floor_base",\s+date_trunc\('milliseconds', "floor_instant" \+ interval '999 microseconds'\)/,
    );
  });

  it('keeps a thread the owner cleared cleared for co-managers', () => {
    const eligibleSet = statementContaining(
      sql,
      'CREATE TEMP TABLE "enquiry_thread_moves"',
    );
    expect(eligibleSet).toContain(
      '"owner_seat"."cleared_at" AS "owner_cleared_at"',
    );
    expect(eligibleSet).toContain(
      `date_trunc('milliseconds', "owner_cleared_at" + interval '999 microseconds')`,
    );
  });

  it('skips a thread whose customer blocked the business, before any other customer rule', () => {
    const eligibleSet = statementContaining(
      sql,
      'CREATE TEMP TABLE "enquiry_thread_moves"',
    );
    expect(eligibleSet).toMatch(
      /"business_block"\."blocker_user_id" = "thread"\."customer_user_id"\s+AND "business_block"\."identity_id" = "listing_identity"\."id"/,
    );
    const blockArm = eligibleSet.indexOf(
      `WHEN "has_customer_blocked_business" THEN 'customer_blocked_business'`,
    );
    expect(blockArm).toBeGreaterThanOrEqual(0);
    expect(blockArm).toBeLessThan(
      eligibleSet.indexOf(`THEN 'customer_is_staff'`),
    );
  });

  it('skips a thread with a person block between the customer and the owner, in either direction', () => {
    const eligibleSet = statementContaining(
      sql,
      'CREATE TEMP TABLE "enquiry_thread_moves"',
    );
    expect(eligibleSet).toMatch(
      /"owner_block"\."blocker_id" = "thread"\."customer_user_id"\s+AND "owner_block"\."blocked_id" = "listing"\."owner_id"/,
    );
    expect(eligibleSet).toMatch(
      /"owner_block"\."blocked_id" = "thread"\."customer_user_id"\s+AND "owner_block"\."blocker_id" = "listing"\."owner_id"/,
    );
    const businessBlockArm = eligibleSet.indexOf(
      `WHEN "has_customer_blocked_business" THEN 'customer_blocked_business'`,
    );
    const ownerBlockArm = eligibleSet.indexOf(
      `WHEN "has_customer_owner_block" THEN 'customer_owner_blocked'`,
    );
    expect(ownerBlockArm).toBeGreaterThan(businessBlockArm);
    expect(ownerBlockArm).toBeLessThan(
      eligibleSet.indexOf(`THEN 'customer_is_staff'`),
    );
  });

  it('leaves a move note from an earlier down() out of the floor and the note placement', () => {
    const eligibleSet = statementContaining(
      sql,
      'CREATE TEMP TABLE "enquiry_thread_moves"',
    );
    const noteExclusion =
      /AND NOT \("message"\."kind" = 'system'\s+AND "message"\."system_event" ->> 'type' = 'moved_to_business_mailbox'\)/;
    for (const alias of ['"latest_before_floor"', '"latest_message"']) {
      const aliasIndex = eligibleSet.indexOf(`) AS ${alias}`);
      expect(aliasIndex).toBeGreaterThanOrEqual(0);
      const subquery = eligibleSet.slice(
        eligibleSet.lastIndexOf('SELECT MAX(', aliasIndex),
        aliasIndex,
      );
      expect(subquery).toMatch(noteExclusion);
    }
  });

  it('counts owner-clear cover apart, and describes moved threads only', () => {
    const outcomeLog = statementContaining(sql, '"ownerClearCoveredCount"');
    expect(outcomeLog).toMatch(
      /AND NOT "is_enquiry_covered_by_owner_clear"\s+\) AS "enquiryCoveredCount"/,
    );
    const filters = outcomeLog.split('FILTER (').slice(1);
    expect(filters).toHaveLength(6);
    for (const filter of filters) {
      expect(filter).toMatch(/^\s*WHERE "skip_reason" IS NULL\s+AND /);
    }
  });

  it('keeps the note below the floor instant and below the newest message', () => {
    const eligibleSet = statementContaining(
      sql,
      'CREATE TEMP TABLE "enquiry_thread_moves"',
    );
    expect(eligibleSet).toMatch(
      /LEAST\(\s+"staff_cleared_at" \+ interval '1 millisecond',\s+"floor_instant" - interval '1 microsecond',\s+"latest_message" - interval '1 microsecond'\s+\) AS "note_created_at"/,
    );
  });

  it('takes the enquirer message nearest the enquiry row, whatever its body', () => {
    const eligibleSet = statementContaining(
      sql,
      'CREATE TEMP TABLE "enquiry_thread_moves"',
    );
    const nearest = eligibleSet.slice(
      eligibleSet.indexOf('LEFT JOIN LATERAL'),
      eligibleSet.indexOf('AS "nearest_message"'),
    );
    expect(nearest).toMatch(/ORDER BY "message"\."created_at" DESC\s+LIMIT 1/);
    expect(nearest).not.toMatch(/WHERE[\s\S]*LIKE/);
  });

  it('analyzes the temporary table and logs the pre-floor quote exposure', () => {
    expect(sql).toContain('ANALYZE "enquiry_thread_moves"');
    const outcomeLog = statementContaining(sql, '"preFloorQuoteThreadCount"');
    expect(outcomeLog).toContain(
      '"quoted_parent"."created_at" <= "enquiry_thread_moves"."staff_cleared_at"',
    );
    expect(outcomeLog).toContain(
      '"reply"."created_at" > "enquiry_thread_moves"."staff_cleared_at"',
    );
  });

  it('states when it runs and what it locks', () => {
    expect(sql).toContain('ensureDatabaseSchema');
    expect(sql).toContain('row locks');
  });

  it("copies the owner's watermarks onto co-manager seats", () => {
    const insertBlock = sql.slice(
      sql.indexOf('INSERT INTO "conversation_participants"'),
    );
    const statement = insertBlock.slice(0, insertBlock.indexOf('`);'));
    const columnList = statement.slice(0, statement.indexOf(')'));
    expect(columnList).toContain('"last_read_at"');
    expect(columnList).toContain('"last_read_instant"');
    expect(columnList).toContain('"delivered_at"');
    expect(statement).toContain('"owner_seat"."last_read_at"');
    expect(statement).toContain('"owner_seat"."last_read_instant"');
    expect(statement).toContain('"owner_seat"."delivered_at"');
    expect(statement).not.toMatch(/MAX\("message"\."created_at"\)/);
  });

  it("withholds the owner's read watermarks when the owner hides read receipts", () => {
    const insertBlock = sql.slice(
      sql.indexOf('INSERT INTO "conversation_participants"'),
    );
    const statement = insertBlock.slice(0, insertBlock.indexOf('`);'));
    expect(statement).toContain('"share_read_receipts"');
    expect(statement).toMatch(
      /CASE WHEN "owner_privacy"\."is_owner_sharing_read_receipts" THEN "owner_seat"\."last_read_at" END/,
    );
    expect(statement).toMatch(
      /CASE WHEN "owner_privacy"\."is_owner_sharing_read_receipts" THEN "owner_seat"\."last_read_instant" END/,
    );
  });

  it('stamps the move note at the floor with no human sender', () => {
    const noteInsert = sql.slice(sql.indexOf('INSERT INTO "messages"'));
    const noteStatement = noteInsert.slice(0, noteInsert.indexOf('`);'));
    expect(noteStatement).toContain('"created_at")');
    expect(noteStatement).toContain('"move"."note_created_at"');
    expect(noteStatement).toMatch(/"move"\."conversation_id",\s*NULL,/);
  });

  it('writes the same fallback text the application uses for the note', () => {
    const groupsService = readFileSync(
      join(__dirname, '..', 'messaging', 'groups.service.ts'),
      'utf8',
    );
    const fallback = /moved_to_business_mailbox:\s*'([^']+)'/.exec(
      groupsService,
    );
    expect(fallback).not.toBeNull();
    expect(sql).toContain(`'${fallback?.[1]}'`);
    expect(fallback?.[1]).toMatch(/^This conversation moved to /);
  });

  it('carries the do-not-run banner', () => {
    expect(sql).toContain(
      '// DO NOT RUN: authored for review only; the maintainer runs migrations.',
    );
  });
});
