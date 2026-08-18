import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds applicant-review state to `volunteer_signups`: `status`
 * (pending/accepted/declined, replacing the old implicit "every signup is
 * confirmed" behavior) and `decided_at` (set when a poster accepts/declines).
 * Existing rows predate the review step, so they're backfilled to `accepted`
 * with `decided_at` set to their own `created_at` — they were already an
 * informal yes before this feature existed.
 *
 * DO NOT RUN. Authored for review only; the maintainer runs migrations.
 */
export class AddVolunteerSignupReviewStatus1790600000000
  implements MigrationInterface
{
  name = 'AddVolunteerSignupReviewStatus1790600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "volunteer_signups_status_enum" AS ENUM('pending', 'accepted', 'declined')`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_signups" ADD "status" "volunteer_signups_status_enum" NOT NULL DEFAULT 'pending'`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_signups" ADD "decided_at" TIMESTAMP WITH TIME ZONE`,
    );
    // Backfill: every row that exists at migration time predates the review
    // step, so it was already an implicit yes before this feature shipped.
    await queryRunner.query(
      `UPDATE "volunteer_signups" SET "status" = 'accepted', "decided_at" = "created_at"`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_volunteer_signups_opportunity_id_status" ON "volunteer_signups" ("opportunity_id", "status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_volunteer_signups_opportunity_id_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_signups" DROP COLUMN "decided_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_signups" DROP COLUMN "status"`,
    );
    await queryRunner.query(`DROP TYPE "volunteer_signups_status_enum"`);
  }
}
