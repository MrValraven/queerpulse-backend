// Lives beside the migration runner in `src/database`, outside
// `src/migrations`: the TypeORM CLI and `DatabaseModule` both require every
// `src/migrations/*.ts` file in development, and requiring a spec there throws
// `describe is not defined` before any migration runs.
//
// The migration itself lives in the sibling `pending-migrations/` folder
// (neither glob loads that folder either) until its handover blockers clear;
// see `pending-migrations/README.md`. This spec reads it in place, so it keeps
// guarding the file whichever folder it is in.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(
    __dirname,
    'pending-migrations',
    '1821260000000-MigrateEnquiryThreadsToListingMailboxes.ts',
  ),
  'utf8',
);

const upSource = source.slice(
  source.indexOf('public async up('),
  source.indexOf('public async down('),
);
const downSource = source.slice(source.indexOf('public async down('));

/** The SQL text of every `queryRunner.query` call in `text`, in order. */
function statementsOf(text: string): string[] {
  return text
    .split('queryRunner.query(`')
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf('`')));
}

/** The one statement in `text` that contains `marker`. */
function statementContaining(text: string, marker: string): string {
  const matches = statementsOf(text).filter((statement) =>
    statement.includes(marker),
  );
  expect(matches).toHaveLength(1);
  return matches[0] ?? '';
}

const eligibleSet = statementContaining(
  upSource,
  'CREATE TEMP TABLE "enquiry_thread_moves"',
);

describe('the enquiry migration splits at the enquiry', () => {
  it('carries the do-not-run banner', () => {
    expect(source).toContain(
      '// DO NOT RUN: authored for review only; the maintainer runs migrations.',
    );
  });

  it('never references the history floor column a later migration adds', () => {
    expect(source).not.toContain('history_floor_at');
  });

  it('names no claim-release column, which a fresh database does not have yet', () => {
    const allSql = statementsOf(source).join('\n');
    expect(allSql).not.toMatch(/claim_released|claim_taken_over/);
  });

  it('keeps none of the retired staff-floor machinery', () => {
    for (const retired of [
      'latest_before_floor',
      'owner_cleared_at',
      'staff_cleared_at',
      'date_trunc',
      'noteBelowStaffFloorCount',
      'ownerClearCoveredCount',
      'enquiryCoveredCount',
    ]) {
      expect(source).not.toContain(retired);
    }
  });

  it('takes the enquirer message nearest the enquiry row, whatever its body', () => {
    const nearest = eligibleSet.slice(
      eligibleSet.indexOf('LEFT JOIN LATERAL'),
      eligibleSet.indexOf('AS "nearest_message"'),
    );
    expect(nearest).toMatch(/ORDER BY "message"\."created_at" DESC\s+LIMIT 1/);
    expect(nearest).not.toMatch(/WHERE[\s\S]*LIKE/);
    expect(eligibleSet).toContain('MIN("anchor_instant") AS "split_instant"');
  });

  it('anchors exactly on an enquiry message that was edited or deleted', () => {
    const nearest = eligibleSet.slice(
      eligibleSet.indexOf('LEFT JOIN LATERAL'),
      eligibleSet.indexOf('AS "nearest_message"'),
    );
    expect(nearest).toMatch(
      /"message"\."body" LIKE 'Enquiry about your QueerPulse listing "%'\s+OR "message"\."edited_at" IS NOT NULL\s+OR "message"\."deleted_at" IS NOT NULL\s+\) AS "is_enquiry_message"/,
    );
    expect(eligibleSet).toMatch(
      /CASE WHEN "nearest_message"\."is_enquiry_message"\s+THEN "nearest_message"\."created_at"\s+ELSE "enquiry"\."created_at"/,
    );
  });

  it('counts a fallback only when it set the split instant', () => {
    expect(eligibleSet).toContain(
      '(ARRAY_AGG("is_exact_anchor" ORDER BY "anchor_instant", "is_exact_anchor"))[1]',
    );
    expect(eligibleSet).not.toContain('BOOL_AND("is_exact_anchor")');
  });

  it('counts any message of any kind before the split as pre-enquiry history', () => {
    const history = eligibleSet.slice(
      eligibleSet.indexOf('CROSS JOIN LATERAL'),
      eligibleSet.indexOf(') AS "thread_history"'),
    );
    expect(history).toContain(
      'BOOL_OR("message"."created_at" < "thread_facts"."split_instant")',
    );
    expect(history).not.toContain('"kind"');
  });

  it('splits only a moving thread with pre-enquiry history and mints its business conversation', () => {
    expect(eligibleSet).toContain(
      '"skip_reason" IS NULL AND "has_pre_enquiry_history" AS "is_split"',
    );
    expect(eligibleSet).toMatch(
      /CASE WHEN "skip_reason" IS NULL AND "has_pre_enquiry_history"\s+THEN uuid_generate_v4\(\)\s+ELSE "conversation_id"\s+END AS "business_conversation_id"/,
    );
  });

  it('moves messages only at or after the split, and only for split threads', () => {
    const move = statementContaining(
      upSource,
      'UPDATE "messages" AS "message"\n      SET "conversation_id"',
    );
    expect(move).toContain('"message"."created_at" >= "move"."split_instant"');
    expect(move).toContain('AND "move"."is_split"');
    expect(move).toContain(
      'SET "conversation_id" = "move"."business_conversation_id"',
    );
  });

  it('leaves reply_to_id intact and counts replies that quote across the split', () => {
    expect(statementsOf(source).join('\n')).not.toMatch(/SET\s+"reply_to_id"/);
    expect(eligibleSet).toContain(
      '"reply"."created_at" >= "classified"."split_instant"',
    );
    expect(eligibleSet).toContain(
      '"quoted_parent"."created_at" < "classified"."split_instant"',
    );
    expect(eligibleSet).toContain(
      '"quoted_parent"."conversation_id" = "classified"."conversation_id"',
    );
  });

  it('moves pins with their messages and repoints the enquiries of a split thread', () => {
    const pins = statementContaining(
      upSource,
      'UPDATE "conversation_pinned_messages"',
    );
    expect(pins).toContain(
      '"message"."conversation_id" = "move"."business_conversation_id"',
    );
    const enquiries = statementContaining(
      upSource,
      'UPDATE "listing_enquiries"',
    );
    expect(enquiries).toContain(
      'SET "conversation_id" = "move"."business_conversation_id"',
    );
    expect(enquiries).toContain('AND "move"."is_split"');
  });

  it('seats co-managers with a NULL cleared_at on the business thread', () => {
    const coManagerSeats = statementContaining(
      upSource,
      'JOIN "listing_co_managers" AS "co_manager"',
    );
    const columnList = coManagerSeats.slice(0, coManagerSeats.indexOf(')'));
    expect(columnList).toContain('"cleared_at"');
    expect(coManagerSeats).toMatch(
      /"move"\."business_conversation_id",\s*"co_manager"\."user_id",\s*"move"\."listing_identity_id",\s*NULL::timestamptz,/,
    );
  });

  it("copies the owner's watermarks onto co-manager seats", () => {
    const coManagerSeats = statementContaining(
      upSource,
      'JOIN "listing_co_managers" AS "co_manager"',
    );
    const columnList = coManagerSeats.slice(0, coManagerSeats.indexOf(')'));
    expect(columnList).toContain('"last_read_at"');
    expect(columnList).toContain('"last_read_instant"');
    expect(columnList).toContain('"delivered_at"');
    expect(coManagerSeats).toContain('"owner_seat"."delivered_at"');
    expect(coManagerSeats).toContain(
      '"owner_seat"."conversation_id" = "move"."conversation_id"',
    );
  });

  it("withholds the owner's read watermarks when the owner hides read receipts", () => {
    const coManagerSeats = statementContaining(
      upSource,
      'JOIN "listing_co_managers" AS "co_manager"',
    );
    expect(coManagerSeats).toContain('"share_read_receipts"');
    expect(coManagerSeats).toMatch(
      /CASE WHEN "owner_privacy"\."is_owner_sharing_read_receipts" THEN "owner_seat"\."last_read_at" END/,
    );
    expect(coManagerSeats).toMatch(
      /CASE WHEN "owner_privacy"\."is_owner_sharing_read_receipts" THEN "owner_seat"\."last_read_instant" END/,
    );
  });

  it("carries the customer's and owner's clear onto a split seat only when it reaches the split", () => {
    const splitSeats = statementContaining(
      upSource,
      'JOIN "conversation_participants" AS "old_seat"',
    );
    expect(splitSeats).toContain(
      'CASE WHEN "old_seat"."cleared_at" >= "move"."split_instant" THEN "old_seat"."cleared_at" END',
    );
    for (const copied of [
      '"old_seat"."last_read_at"',
      '"old_seat"."last_read_instant"',
      '"old_seat"."delivered_at"',
      '"old_seat"."muted"',
      '"old_seat"."mute_mode"',
      '"old_seat"."muted_until"',
    ]) {
      expect(splitSeats).toContain(copied);
    }
    for (const leftOnTheDm of [
      'pinned_at',
      'favorited_at',
      'archived_at',
      'marked_unread_at',
      'draft',
    ]) {
      expect(splitSeats).not.toContain(leftOnTheDm);
    }
  });

  it('rekeys the owner seat in place only for a thread without pre-enquiry history', () => {
    const ownerSeat = statementContaining(
      upSource,
      'UPDATE "conversation_participants" AS "owner_seat"',
    );
    expect(ownerSeat).toContain('AND NOT "move"."is_split"');
    expect(ownerSeat).not.toContain('cleared_at');
  });

  it('only re-attributes owner messages at or after the split, in the business thread', () => {
    const reattribution = statementContaining(
      upSource,
      'SET "sender_identity_id" = "move"."listing_identity_id"',
    );
    expect(reattribution).toContain(
      '"message"."created_at" >= "move"."split_instant"',
    );
    expect(reattribution).toContain(
      '"message"."sender_id" = "move"."owner_user_id"',
    );
    expect(reattribution).toContain(
      '"message"."conversation_id" = "move"."business_conversation_id"',
    );
  });

  it('stamps the move note just before the first business message, with no human sender', () => {
    expect(eligibleSet).toMatch(
      /"first_business_message_at" - interval '1 microsecond' AS "note_created_at"/,
    );
    const note = statementContaining(upSource, "'moved_to_business_mailbox'");
    expect(note).toMatch(/"move"\."business_conversation_id",\s*NULL,/);
    expect(note).toContain('"move"."note_created_at"');
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
    expect(source).toContain(`'${fallback?.[1]}'`);
    expect(fallback?.[1]).toMatch(/^This conversation moved to /);
  });

  it('skips a thread whose customer blocked the business, before any other customer rule', () => {
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

  it('keeps every skip reason', () => {
    for (const reason of [
      'already_business_thread',
      'several_listings',
      'not_one_to_one',
      'customer_blocked_business',
      'customer_owner_blocked',
      'customer_is_staff',
      'owner_without_seat',
      'mailbox_thread_exists',
      'nothing_to_move',
    ]) {
      expect(eligibleSet).toContain(`'${reason}'`);
    }
  });

  it('keeps a thread with nothing at or after the split personal, as the last skip reason', () => {
    const nothingArm = eligibleSet.indexOf(
      `WHEN "business_message_count" = 0 THEN 'nothing_to_move'`,
    );
    expect(nothingArm).toBeGreaterThan(
      eligibleSet.indexOf(`THEN 'mailbox_thread_exists'`),
    );
    expect(eligibleSet.slice(nothingArm)).toMatch(
      /^WHEN "business_message_count" = 0 THEN 'nothing_to_move'\s+ELSE NULL/,
    );
    expect(source).not.toContain('emptySplitThreadCount');
  });

  it('creates the business conversation and its split seats for split threads only', () => {
    const conversationInsert = statementContaining(
      upSource,
      'INSERT INTO "conversations"',
    );
    expect(conversationInsert).toContain('AND "move"."is_split"');
    const splitSeats = statementContaining(
      upSource,
      'JOIN "conversation_participants" AS "old_seat"',
    );
    expect(splitSeats).toContain('AND "move"."is_split"');
  });

  it('analyzes the temporary table and logs every counter for moved threads only', () => {
    expect(upSource).toContain('ANALYZE "enquiry_thread_moves"');
    const outcomeLog = statementContaining(upSource, '"crossSplitReplyCount"');
    for (const counter of [
      '"threadCount"',
      '"rekeyedThreadCount"',
      '"splitThreadCount"',
      '"movedMessageCount"',
      '"crossSplitReplyCount"',
      '"fallbackAnchorCount"',
    ]) {
      expect(outcomeLog).toContain(counter);
    }
    const filters = outcomeLog.split('FILTER (').slice(1);
    expect(filters.length).toBeGreaterThanOrEqual(5);
    for (const filter of filters) {
      expect(filter).toMatch(/^\s*WHERE "skip_reason" IS NULL\s+AND /);
    }
    expect(upSource).toContain('console.log(');
  });

  it('records every moved thread for down() and drops that record on the way down', () => {
    const record = statementContaining(
      upSource,
      'INSERT INTO "enquiry_mailbox_moves"',
    );
    expect(record).toContain('WHERE "move"."skip_reason" IS NULL');
    expect(downSource).toContain('FROM "enquiry_mailbox_moves" AS "move"');
    expect(downSource).toContain('DROP TABLE "enquiry_mailbox_moves"');
  });

  it('reverses a split in down(): note out first, messages, pins and enquiries back, business thread gone', () => {
    const statements = statementsOf(downSource);
    const indexOfStatement = (marker: string): number =>
      statements.findIndex((statement) => statement.includes(marker));
    const noteDelete = indexOfStatement('DELETE FROM "messages" AS "note"');
    const messagesBack = indexOfStatement(
      'UPDATE "messages" AS "message"\n      SET "conversation_id"',
    );
    expect(noteDelete).toBeGreaterThanOrEqual(0);
    expect(messagesBack).toBeGreaterThan(noteDelete);
    expect(
      indexOfStatement('UPDATE "conversation_pinned_messages"'),
    ).toBeGreaterThan(noteDelete);
    expect(indexOfStatement('UPDATE "listing_enquiries"')).toBeGreaterThan(
      noteDelete,
    );
    expect(
      indexOfStatement(
        'DELETE FROM "conversations" AS "business_conversation"',
      ),
    ).toBeGreaterThan(messagesBack);
    const personalGate = indexOfStatement(
      'UPDATE "conversations" AS "personal_conversation"',
    );
    expect(personalGate).toBeGreaterThan(messagesBack);
    expect(personalGate).toBeLessThan(
      indexOfStatement(
        'DELETE FROM "conversations" AS "business_conversation"',
      ),
    );
    expect(statements[personalGate]).toContain(
      '"personal_conversation"."initiator_user_id" = "revert"."customer_user_id"',
    );
    // A person block between the customer and the owner, either way, keeps
    // the restored DM unopened.
    const personalGateStatement = statements[personalGate] ?? '';
    expect(personalGateStatement).toMatch(
      /AND NOT EXISTS \(\s*SELECT 1 FROM "blocks" AS "pair_block"/,
    );
    expect(personalGateStatement).toMatch(
      /\("pair_block"\."blocker_id" = "revert"\."customer_user_id"\s+AND "pair_block"\."blocked_id" = "revert"\."owner_user_id"\)/,
    );
    expect(personalGateStatement).toMatch(
      /\("pair_block"\."blocked_id" = "revert"\."customer_user_id"\s+AND "pair_block"\."blocker_id" = "revert"\."owner_user_id"\)/,
    );
    const identityBack = indexOfStatement(
      'SET "sender_identity_id" = "revert"."owner_identity_id"',
    );
    expect(identityBack).toBeGreaterThan(messagesBack);
  });

  it('states when it runs and what it locks', () => {
    expect(source).toContain('ensureDatabaseSchema');
    expect(source).toContain('row locks');
  });
});
