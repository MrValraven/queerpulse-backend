import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records why a request was declined, so two admins can be checked against
 * the same bar later (guideline audit E5). Closed set of reason keys is
 * frontend-owned, mirroring AddJoinRequestSource1789500000000 exactly: nullable
 * varchar, no backfill, length-capped not @IsIn-validated (the catalogue can
 * grow without a backend deploy).
 *
 * Timestamp note: the implementation plan this migration comes from
 * (`docs/superpowers/plans/2026-08-18-invite-review-guidelines-backend.md`,
 * Task 2) specified `1790100100000`, but by the time this task was
 * implemented several other migrations (up to `1790800200000`) had already
 * landed from concurrent work. This migration is timestamped after all of
 * them so it applies last, per this repo's "pending migrations run in
 * timestamp order" rule; reusing the plan's original number would have put
 * it in the middle of already-applied history.
 */
export class AddJoinRequestDeclineReason1790900000000 implements MigrationInterface {
  name = 'AddJoinRequestDeclineReason1790900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        ADD "decline_reason" character varying(64)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        DROP COLUMN "decline_reason"
    `);
  }
}
