// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Claiming and private notes on a community join request:
 * `claimed_by_user_id`, `claimed_at`, `internal_note`.
 *
 * A queue several moderators watch at once produces duplicated work at best
 * and two different answers to the same applicant at worst. Claiming makes
 * "someone is on this" visible. It is deliberately ADVISORY: it does not lock
 * the row, and any moderator may still act on a claimed request, because a
 * hard lock strands the queue behind whoever claimed something and went to
 * bed. Both columns are NULL on an unclaimed request and are cleared together
 * when a claim is released.
 *
 * `internal_note` is MODERATOR-ONLY working text and must NEVER be shown to
 * the applicant or included in any applicant-facing response. It is what lets
 * `decline_reason` stay the thing the applicant actually reads while
 * moderators still keep context for each other. Any response builder that
 * serialises a join request for its own applicant must omit this column.
 *
 * `claimed_by_user_id` is `ON DELETE SET NULL` for account erasure, the
 * actor-reference convention this module follows: a moderator's account going
 * away releases their claims and leaves the requests reviewable.
 */
export class AddCommunityJoinRequestClaim1793910000000 implements MigrationInterface {
  name = 'AddCommunityJoinRequestClaim1793910000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_join_requests" ADD "claimed_by_user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_join_requests" ADD "claimed_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_join_requests" ADD "internal_note" text`,
    );
    await queryRunner.query(`
      ALTER TABLE "community_join_requests"
        ADD CONSTRAINT "FK_community_join_requests_claimed_by"
        FOREIGN KEY ("claimed_by_user_id")
        REFERENCES "users"("id") ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "community_join_requests"
        DROP CONSTRAINT "FK_community_join_requests_claimed_by"
    `);
    await queryRunner.query(
      `ALTER TABLE "community_join_requests" DROP COLUMN "internal_note"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_join_requests" DROP COLUMN "claimed_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_join_requests" DROP COLUMN "claimed_by_user_id"`,
    );
  }
}
