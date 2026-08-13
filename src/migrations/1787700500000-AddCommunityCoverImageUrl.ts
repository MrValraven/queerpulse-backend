import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `communities.cover_image_url` — the optional cover image shown on the
 * public homepage featured-community card and the community detail page. Stores
 * a raw storage key (uploaded via the `community-cover` upload kind) or an
 * absolute `https://` URL; responses resolve it through `toImageUrl`. NULL for
 * every existing row (no cover by default), so this is a metadata-only
 * `ADD COLUMN` with a NULL default: fast, non-rewriting, and safe to run online
 * without `CONCURRENTLY` (that clause is only for index builds). Kept inside the
 * default batch transaction — no `transaction = false` opt-out needed here.
 *
 * The matching `@Column({ nullable: true }) coverImageUrl` decorator is on
 * `Community` (`communities/entities/community.entity.ts`) so entity metadata
 * and schema stay in sync for any future `migration:generate` diff.
 */
export class AddCommunityCoverImageUrl1787700500000 implements MigrationInterface {
  name = 'AddCommunityCoverImageUrl1787700500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "cover_image_url" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "cover_image_url"`,
    );
  }
}
