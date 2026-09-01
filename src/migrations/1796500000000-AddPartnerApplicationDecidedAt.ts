// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-37: record WHEN a partner application was decided.
 *
 * Approving or rejecting an application flipped `partners.status` and nothing
 * else, so the row could say "rejected" but never "rejected on the 4th". The
 * applicant now gets `GET /partner-applications/mine`, and a status with no
 * date on it is a poor answer to "have I heard back?" when the whole reason
 * the endpoint exists is that the applicant had no way to learn the outcome.
 *
 * NULLABLE, AND DELIBERATELY NOT BACKFILLED. Every row that predates this
 * column keeps NULL, including the ones already approved or rejected. The
 * tempting backfill is `updated_at` for decided rows, and it would be wrong:
 * `AdminPartnersController.update` rewrites an approved partner's
 * `featured`/testimonial fields whenever the directory is edited, so
 * `updated_at` on a long-standing partner is the date of the last marketing
 * tweak, not the date of the decision. Writing that in would hand the
 * applicant a confident wrong date. NULL says "we did not record this", which
 * is true, and the read path renders it as nothing rather than as a breach or
 * a guess — the same contract `partners.due_at` already carries.
 *
 * NO INDEX. The only new read is "this member's own applications", which
 * filters on `submitted_by_id` (already covered by
 * `IDX_partners_submitted_by_id`) and orders by `(created_at, id)` over the
 * handful of rows one organisation ever submits. An index on `decided_at`
 * would never be chosen, and nothing sorts or filters by it.
 *
 * Plain transactional DDL: one `ADD COLUMN` of a nullable column, which takes
 * no table rewrite and no lock worth naming on a table this size.
 */
export class AddPartnerApplicationDecidedAt1796500000000 implements MigrationInterface {
  name = 'AddPartnerApplicationDecidedAt1796500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "partners" ADD "decided_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "partners" DROP COLUMN "decided_at"`);
  }
}
