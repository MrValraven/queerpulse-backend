import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BE-HSG-07: makes the affirming baseline true of the DATA, not just of new
 * writes.
 *
 * `housing_listings.lgbtq_friendly` was an owner-settable boolean defaulting to
 * `false`, echoed on the public listing DTO. Every lister must accept the
 * mandatory LGBTQ+ affirming pledge before they can post
 * (`HousingListingsService.create`), so every listing that exists is affirming
 * by definition. Carrying a per-listing `false` alongside that modelled
 * affirmation as an opt-in attribute of individual homes, which is precisely
 * the pattern the pledge replaced: a public card could read "not LGBTQ
 * friendly" on a listing posted under the pledge.
 *
 * `HousingListingsService` now hard-sets the column to `true` on create and no
 * longer reads it on update. This backfills the rows written before that, and
 * flips the column default so a row inserted outside the service (seed, ops)
 * cannot reintroduce a `false`.
 *
 * The column itself is deliberately KEPT rather than dropped: the public DTO
 * still emits it, so removing it would be a breaking wire change for clients
 * that read it. Dropping it is a follow-up for when no client does.
 */
export class BackfillHousingListingAffirmingBaseline1793530400000 implements MigrationInterface {
  name = 'BackfillHousingListingAffirmingBaseline1793530400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "housing_listings" SET "lgbtq_friendly" = true WHERE "lgbtq_friendly" = false`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" ALTER COLUMN "lgbtq_friendly" SET DEFAULT true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restores the old column default only. The backfilled values are NOT
    // reverted: which rows were `false` before is not recoverable, and
    // re-introducing a per-listing `false` would be the bug, not the fix.
    await queryRunner.query(
      `ALTER TABLE "housing_listings" ALTER COLUMN "lgbtq_friendly" SET DEFAULT false`,
    );
  }
}
