// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Claiming for shared business mailboxes (Task 9). A thread has exactly one
 * business side, so the claim lives once, on the conversation itself, and
 * covers every one of that mailbox's participant rows at once.
 * `claimed_by_user_id` names the staff member currently answering the
 * thread; `claimed_at` is when they took it. Both are NULL together for an
 * unclaimed thread.
 *
 * The claim is taken with a conditional UPDATE guarded on
 * `claimed_by_user_id IS NULL` (`ConversationsService.claim`), which is what
 * lets the database itself settle two simultaneous claims on exactly one
 * winner, inside the single atomic write.
 *
 * LOCKS. Both new columns are nullable with no default, so `ADD COLUMN` is a
 * metadata-only change on Postgres and takes no more than the brief
 * `ACCESS EXCLUSIVE` lock that statement always needs. `ADD CONSTRAINT ...
 * FOREIGN KEY` takes a `SHARE ROW EXCLUSIVE` lock on `conversations` (reads
 * proceed; concurrent writes to the table wait) while it validates the new
 * constraint, but every existing row is NULL in the very column the
 * constraint checks, so that validation scan finds nothing to flag and
 * finishes quickly even though `conversations` holds real production data.
 * No index is being built here, so there is no need for `CREATE INDEX
 * CONCURRENTLY` or this migration opting out of its transaction; this
 * mirrors the plain transactional shape
 * `1820540000000-AddOfficialConversationsAndBroadcasts.ts` used for the same
 * kind of change (a nullable uuid column plus a `SET NULL` foreign key) on
 * this same table.
 */
export class AddConversationClaim1821250000000 implements MigrationInterface {
  name = 'AddConversationClaim1821250000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "claimed_by_user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "claimed_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(`
      ALTER TABLE "conversations"
        ADD CONSTRAINT "FK_conversations_claimed_by_user_id"
        FOREIGN KEY ("claimed_by_user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP CONSTRAINT "FK_conversations_claimed_by_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "claimed_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "claimed_by_user_id"`,
    );
  }
}
