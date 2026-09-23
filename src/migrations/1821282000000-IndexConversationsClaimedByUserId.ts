import { MigrationInterface, QueryRunner } from 'typeorm';

// DO NOT RUN: authored for review only; the maintainer runs migrations.
/**
 * A partial index on `conversations.claimed_by_user_id`.
 * `1821250000000-AddConversationClaim.ts` added the column with an
 * `ON DELETE SET NULL` foreign key to `users` but no index, so erasing an
 * account makes Postgres scan every conversation to find the ones that name
 * it there. `1821280100000-IndexConversationClaimChangeUsers.ts` already
 * indexes the two sibling claim columns (`claim_released_by_user_id`,
 * `claim_taken_over_from_user_id`) for exactly this reason; this closes the
 * same gap for the third.
 *
 * PARTIAL. Only a currently claimed thread carries a value, and most
 * mailbox threads and every ordinary member-to-member thread never do, so
 * the index keeps only its non-NULL rows (`WHERE "claimed_by_user_id" IS NOT
 * NULL`), which is exactly the set the foreign key lookup can match.
 *
 * SEPARATE AND NON-TRANSACTIONAL. `conversations` takes a write on every new
 * thread, and a plain `CREATE INDEX` holds a lock that blocks those writes
 * for the whole build. `CREATE INDEX CONCURRENTLY` avoids that, and it
 * cannot run inside a transaction block, so this index lives in its own
 * migration that opts out of the per-migration transaction, the same way
 * `1821280100000` and `1821270000000-AddConversationsInitiatorUserIdIndex.ts`
 * do. The statement carries no `IF [NOT] EXISTS` guard: an index already
 * present means the ledger and the schema disagree, and that should fail
 * loudly (see CLAUDE.md). A concurrent build that fails leaves an INVALID
 * index behind under its name, so drop it before running this migration
 * again. `down()` runs outside a transaction for the same reason, which is
 * what lets it use `DROP INDEX CONCURRENTLY`.
 */
export class IndexConversationsClaimedByUserId1821282000000 implements MigrationInterface {
  name = 'IndexConversationsClaimedByUserId1821282000000';

  // `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_conversations_claimed_by_user_id" ON "conversations" ("claimed_by_user_id") WHERE "claimed_by_user_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_conversations_claimed_by_user_id"`,
    );
  }
}
