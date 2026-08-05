import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `profiles.featured_consent` — the member-controlled opt-in that gates
 * whether they may be selected for the admin-curated live landing page
 * (member quote / changemaker highlight, see `landing_feature`). Default
 * false: opt-in only, mirroring `private_network`.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddProfileFeaturedConsent1785903300000 implements MigrationInterface {
  name = 'AddProfileFeaturedConsent1785903300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "profiles" ADD "featured_consent" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "profiles" DROP COLUMN "featured_consent"`,
    );
  }
}
