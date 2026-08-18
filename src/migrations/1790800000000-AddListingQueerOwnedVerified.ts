// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `queer_owned_verified` to `listings` — a moderator-checked confirmation
 * of the "queer-owned" badge, distinct from the member's own self-reported
 * `link_to_profile` claim. `false` by default; only flipped through the
 * moderator toggle (`PATCH /listings/:ref/queer-owned-verified`), never by the
 * member-submission wizard. Mirrors `AddListingPartnerSpaceFields`'s
 * simple-boolean-plus-index shape exactly (`is_partnered_with_queerpulse`).
 *
 * UNAPPLIED — the maintainer runs `pnpm run migration:run`.
 */
export class AddListingQueerOwnedVerified1790800000000
  implements MigrationInterface
{
  name = 'AddListingQueerOwnedVerified1790800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "queer_owned_verified" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listings_queer_owned_verified" ON "listings" ("queer_owned_verified")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_listings_queer_owned_verified"`);
    await queryRunner.query(
      `ALTER TABLE "listings" DROP COLUMN "queer_owned_verified"`,
    );
  }
}
