// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `listings.menu` and `listings.pricing_mode`: a sectioned menu for bars,
 * cafés and restaurants, beside the untouched `services` list.
 *
 * `menu` is jsonb `{ sections: [{ title, items: [{ name, price, description,
 * dietary }] }], file: { url, contentType, fileName } | null, link }`, read
 * whole and written whole like `services` and `hours_exceptions`. Nothing
 * queries individual items.
 *
 * `pricing_mode` says which of the two lists the public page shows. Both ADD
 * COLUMNs carry constant defaults, so on PostgreSQL 11+ they are catalog-only
 * with no table rewrite.
 *
 * The backfill switches existing food and nightlife listings to `menu`, but
 * only when they have typed no services, so nobody's existing list vanishes
 * from their page. The value list covers the legacy category labels and venue
 * types the frontend's `normalizeCategory` heals at read time.
 */
export class AddListingMenu1821600000000 implements MigrationInterface {
  name = 'AddListingMenu1821600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "menu" jsonb NOT NULL DEFAULT '{"sections":[],"file":null,"link":""}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "pricing_mode" character varying(16) NOT NULL DEFAULT 'services'`,
    );
    await queryRunner.query(
      `UPDATE "listings" SET "pricing_mode" = 'menu'
       WHERE EXISTS (
         SELECT 1 FROM unnest("cats") AS category
         WHERE lower(trim(category)) IN
           ('food', 'nightlife', 'food & drink', 'café', 'bar', 'club', 'sauna')
       )
       AND "services" = '[]'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" DROP COLUMN "pricing_mode"`,
    );
    await queryRunner.query(`ALTER TABLE "listings" DROP COLUMN "menu"`);
  }
}
