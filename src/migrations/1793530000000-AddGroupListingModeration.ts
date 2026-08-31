import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BE-HSG-01: brings group listings up to the same pre-publication gate the
 * sibling member-listing surface has always had.
 *
 * Adds to `group_listings`:
 *  - `status` (`group_listings_status_enum`, default `review`) — the
 *    pre-publication moderation state. `HousingGroupsService.createListing`
 *    forces `review`; only a housing moderator moves a row to `live`, and the
 *    public read filters on `status = 'live' AND hidden = false`. Distinct from
 *    the pre-existing `hidden` column, which is the POST-publication
 *    norm-violation takedown.
 *  - `risk_score` / `risk_reasons` — the deterministic `assessHousingRisk`
 *    output (including the discriminatory-language scan), stored so the
 *    moderator queue can sort riskiest-first with machine reasons attached.
 *    Never public, never an auto-publish or auto-refuse gate.
 *
 * BACKFILL: existing rows are set to `live`, not left at the `review` default.
 * They have already been publicly visible on their group pages, so defaulting
 * them into review would silently withdraw live community content as a side
 * effect of a schema change. The new gate applies to everything submitted from
 * here on. Moderators can still take any grandfathered row down through the
 * pre-existing `hidden` flag or move it back to `review` through the new
 * `PATCH /admin/housing-groups/listings/:id/status` route.
 *
 * Additive and safe: no existing column is altered or dropped.
 */
export class AddGroupListingModeration1793530000000 implements MigrationInterface {
  name = 'AddGroupListingModeration1793530000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "group_listings_status_enum" AS ENUM('review','question','live')`,
    );
    await queryRunner.query(
      `ALTER TABLE "group_listings" ADD "status" "group_listings_status_enum" NOT NULL DEFAULT 'review'`,
    );
    // Grandfather everything that already exists — see the BACKFILL note above.
    await queryRunner.query(
      `UPDATE "group_listings" SET "status" = 'live' WHERE "status" = 'review'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_group_listings_status" ON "group_listings" ("status")`,
    );
    await queryRunner.query(
      `ALTER TABLE "group_listings" ADD "risk_score" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "group_listings" ADD "risk_reasons" text array NOT NULL DEFAULT '{}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "group_listings" DROP COLUMN "risk_reasons"`,
    );
    await queryRunner.query(
      `ALTER TABLE "group_listings" DROP COLUMN "risk_score"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_group_listings_status"`);
    await queryRunner.query(
      `ALTER TABLE "group_listings" DROP COLUMN "status"`,
    );
    await queryRunner.query(`DROP TYPE "group_listings_status_enum"`);
  }
}
