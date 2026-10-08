// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the staff-only free-text note that travels with an approval whose
 * reason key is `other` (AddJoinRequestApprovalReason1828400000000), the
 * context a closed-set key cannot carry. Nullable text with no backfill:
 * every existing row and every approval with another reason stays NULL.
 * `JoinRequestsService.review` requires it for `other` and stores plain text.
 * Staff-only: never surfaced to the applicant.
 */
export class AddJoinRequestApprovalNote1830600000000 implements MigrationInterface {
  name = 'AddJoinRequestApprovalNote1830600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        ADD "approval_note" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        DROP COLUMN "approval_note"
    `);
  }
}
