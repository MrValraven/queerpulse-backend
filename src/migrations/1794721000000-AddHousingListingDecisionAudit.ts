// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The decision trail on a housing listing, and the index the review queue reads
 * (LOC-01).
 *
 * Three columns, all nullable and additive, so the migration is safe on every
 * existing row (an unreviewed listing has simply never been decided on):
 *  - `decision_reason`: the moderator's own words, shown to the LISTER
 *    verbatim in their notification and on their management view. Required for
 *    every decision except an approval (enforced in
 *    `HousingListingModerationService.decide`, not at the column, because an
 *    approval may legitimately carry none).
 *  - `decided_by_id`: who decided. FK to `users` with `ON DELETE SET NULL`,
 *    mirroring `mod_audit_logs.actor_id` and the eleven content FKs
 *    `SetNullContentAuthorFksOnUserErasure1794610000000` flipped: a decision
 *    outlives the moderator who made it, and erasing a staff account must not
 *    delete the listing they reviewed.
 *  - `decided_at`: when.
 *
 * These are the DENORMALISED last decision, for rendering without a join. The
 * immutable per-decision history lives in `mod_audit_logs` (one row per
 * decision, written by the same method), so overwriting these three on a later
 * decision loses nothing.
 *
 * The index backs the review queue's default read: filter on `status`, order by
 * `risk_score` DESC (the deterministic pre-publish score from `housing-risk.ts`,
 * so the likeliest scam or discriminatory listing is on top) with `created_at`
 * ASC breaking ties so nothing at a given score is starved. Plain `CREATE
 * INDEX`, not `CONCURRENTLY`, so this migration stays transactional: the table
 * is small and the queue is staff-only, so a brief write lock is not worth
 * splitting the migration into two phases.
 *
 * Runs AFTER `AddHousingModerationDecisionEnums1794720000000`, which adds the
 * `rejected`/`taken_down` labels. Nothing here references them, so the
 * committed-before-use rule for `ALTER TYPE ... ADD VALUE` is not in play.
 */
export class AddHousingListingDecisionAudit1794721000000 implements MigrationInterface {
  name = 'AddHousingListingDecisionAudit1794721000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "housing_listings" ADD "decision_reason" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" ADD "decided_by_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" ADD "decided_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings"
         ADD CONSTRAINT "FK_housing_listings_decided_by_id"
         FOREIGN KEY ("decided_by_id") REFERENCES "users"("id")
         ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_housing_listings_review_queue"
         ON "housing_listings" ("status", "risk_score" DESC, "created_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_housing_listings_review_queue"`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" DROP CONSTRAINT "FK_housing_listings_decided_by_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" DROP COLUMN "decided_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" DROP COLUMN "decided_by_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" DROP COLUMN "decision_reason"`,
    );
  }
}
