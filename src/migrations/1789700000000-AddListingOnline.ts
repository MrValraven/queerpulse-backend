import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `listings.online` — the flag an owner sets when their business has no
 * physical location (an online-only business). When true the listing carries no
 * address or coordinates and never appears as a map pin; the directory shows an
 * "Online" badge instead of a neighbourhood.
 *
 * Boolean `NOT NULL DEFAULT false`, so every existing row backfills to a
 * physical listing — a metadata-only `ADD COLUMN` (constant default, no table
 * rewrite, safe online).
 */
export class AddListingOnline1789700000000 implements MigrationInterface {
  name = 'AddListingOnline1789700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "online" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "listings" DROP COLUMN "online"`);
  }
}
