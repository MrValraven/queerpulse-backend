// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records why a request was approved, the approval-side twin of
 * AddJoinRequestDeclineReason1790900000000, so reviewers can be compared
 * against one bar for both outcomes. Closed set of reason keys is
 * frontend-owned, mirroring the decline column exactly: nullable varchar, no
 * backfill, length-capped only (the catalogue can grow without a backend
 * deploy). Staff-only: never surfaced to the applicant.
 */
export class AddJoinRequestApprovalReason1828400000000 implements MigrationInterface {
  name = 'AddJoinRequestApprovalReason1828400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        ADD "approval_reason" character varying(64)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        DROP COLUMN "approval_reason"
    `);
  }
}
