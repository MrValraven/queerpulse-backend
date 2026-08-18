import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Resolves `join_requests.mutual_member_email` (added by
 * AddJoinRequestMutualMemberEmail1790700000000) against an ACTIVE member at
 * submit time, so a reviewer sees a real, checkable corroboration link
 * instead of trusting an unverified string (guideline audit P9).
 *
 * Nullable, no backfill: historical rows never had a chance to resolve, and
 * a mutual-member email that never matched anyone also legitimately leaves
 * this null. FK is ON DELETE SET NULL — the reference is corroborating
 * context, not something worth blocking a user deletion over.
 */
export class AddJoinRequestReferenceUserId1791100000000
  implements MigrationInterface
{
  name = 'AddJoinRequestReferenceUserId1791100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        ADD "reference_user_id" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        ADD CONSTRAINT "FK_join_requests_reference_user_id"
        FOREIGN KEY ("reference_user_id") REFERENCES "users"("id")
        ON DELETE SET NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_join_requests_reference_user_id"
        ON "join_requests" ("reference_user_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX "IDX_join_requests_reference_user_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        DROP CONSTRAINT "FK_join_requests_reference_user_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        DROP COLUMN "reference_user_id"
    `);
  }
}
