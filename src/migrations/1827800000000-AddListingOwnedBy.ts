// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `listings.owned_by`: who owns and runs the business, as the owner declares
 * it. Any of `women`, `trans` and `nonbinary` (`LISTING_OWNED_BY_VALUES`),
 * stored as `text[]` like `cats`, `tags` and `langs` beside it.
 *
 * SELF-DECLARED, NOT VERIFIED. Unlike `queer_owned_verified` there is no
 * moderator confirmation behind it and no provenance columns beside it.
 *
 * OWNER-PERSONAL. Each value discloses the owner's gender identity, so the
 * application treats the column like `owner_name` and `consent_outing`: only
 * the owner writes it, and a handover clears it.
 *
 * NOT NULL DEFAULT '{}', with no backfill. No owner has declared anything yet,
 * and an empty array is what every existing listing has said so far. The
 * allowed values are enforced by the write DTOs rather than a CHECK
 * constraint, the same as `cats` and `tags`.
 *
 * No index: the directory's `owned=` overlap filter always runs beside
 * `status = 'live'`, which `IDX_listings_status` already serves, over a
 * directory of a few hundred rows.
 *
 * Transactional: adding a column with a constant default is a metadata-only
 * change in Postgres 11+, so it takes no table rewrite and builds no index.
 */
export class AddListingOwnedBy1827800000000 implements MigrationInterface {
  name = 'AddListingOwnedBy1827800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "owned_by" text array NOT NULL DEFAULT '{}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "listings" DROP COLUMN "owned_by"`);
  }
}
