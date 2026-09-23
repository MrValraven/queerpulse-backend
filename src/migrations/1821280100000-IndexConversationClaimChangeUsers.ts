// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Task 19: partial indexes on the two user columns
 * `1821280000000-RecordConversationClaimChanges.ts` added to
 * `conversations`, `claim_released_by_user_id` and
 * `claim_taken_over_from_user_id`. Both carry an `ON DELETE SET NULL`
 * foreign key to `users`, and erasing an account makes Postgres look up
 * every conversation naming that user in each column. With no index that
 * lookup is a sequential scan of the whole table per erasure; with these it
 * is an index probe.
 *
 * PARTIAL. Only a thread whose claim was released or taken over carries a
 * value, and most threads never do, so each index keeps only its non-NULL
 * rows (`WHERE <column> IS NOT NULL`), which is exactly the set the foreign
 * key lookup can match.
 *
 * SEPARATE AND NON-TRANSACTIONAL. `conversations` takes a write on every new
 * thread, and a plain `CREATE INDEX` holds a lock that blocks those writes
 * for the whole build. `CREATE INDEX CONCURRENTLY` avoids that, and it
 * cannot run inside a transaction block, so these indexes live in their own
 * migration that opts out of the per-migration transaction, as
 * `1821270000000-AddConversationsInitiatorUserIdIndex.ts` does. Keeping them
 * apart leaves the column and constraint changes in the preceding
 * migration fully transactional. The statements carry no `IF [NOT] EXISTS`
 * guard: an index already present means the ledger and the schema disagree,
 * and that should fail loudly (see CLAUDE.md). A concurrent build that fails
 * leaves an INVALID index behind under its name, so drop it before running
 * this migration again. `down()` runs outside a transaction for the same
 * reason, which is what lets it use `DROP INDEX CONCURRENTLY`.
 */
export class IndexConversationClaimChangeUsers1821280100000 implements MigrationInterface {
  name = 'IndexConversationClaimChangeUsers1821280100000';

  // `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_conversations_claim_released_by_user_id" ON "conversations" ("claim_released_by_user_id") WHERE "claim_released_by_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_conversations_claim_taken_over_from_user_id" ON "conversations" ("claim_taken_over_from_user_id") WHERE "claim_taken_over_from_user_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_conversations_claim_taken_over_from_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_conversations_claim_released_by_user_id"`,
    );
  }
}
