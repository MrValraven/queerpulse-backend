import { MigrationInterface, QueryRunner } from 'typeorm';

// DO NOT RUN: authored for review only; the maintainer runs migrations.
/**
 * Task 18 fix round 1: a partial index on `conversations.initiator_user_id`,
 * for the cold-enquiry quota read (`COLD_IDENTITY_ENQUIRY_MESSAGES_SQL` in
 * `src/identity-contact/identity-enquiry-quota.ts`). That read keeps the
 * threads a member initiated. For a member with many threads the planner
 * starts from `conversations` filtered by `initiator_user_id`, and with no
 * index that is a sequential scan of the whole table on every enquiry send
 * and every contact read. The review measured 14 ms warm and 200 ms cold at
 * 689k conversations, growing with the table, and 8 ms with this index.
 *
 * PARTIAL. Only a cold-contact thread carries an initiator (`deliverEnquiry`
 * and `deliverEnquiryToIdentity` seed it); groups, official threads and
 * every thread opened between connections leave it NULL, and no reader looks
 * those up by initiator, so they stay out of the index. The index also
 * serves the `ON DELETE SET NULL` foreign key on this column, which today
 * scans the table when a member's account is erased.
 *
 * TRANSACTION. `conversations` takes a write on every new thread, and a
 * plain `CREATE INDEX` holds a lock that blocks those writes for the whole
 * build. This migration therefore opts out of the per-migration transaction
 * and builds the index `CONCURRENTLY`, as
 * `1821235000000-SetMessagesSenderIdentityConstraints.ts` does for
 * `messages`. A concurrent build that fails leaves an INVALID index behind
 * under this name; drop it before running this migration again. `down()`
 * runs outside a transaction for the same reason, which is what lets it use
 * `DROP INDEX CONCURRENTLY`.
 */
export class AddConversationsInitiatorUserIdIndex1821270000000 implements MigrationInterface {
  name = 'AddConversationsInitiatorUserIdIndex1821270000000';

  // `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_conversations_initiator_user_id" ON "conversations" ("initiator_user_id") WHERE "initiator_user_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_conversations_initiator_user_id"`,
    );
  }
}
