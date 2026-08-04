import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `city` and `timezone` to `listings`, so a directory listing can carry
 * where it is and which clock its hours run on — the detail page's location
 * eyebrow and its timezone-correct "Open now" both read these, defaulting to
 * Lisbon / Europe-Lisbon on the (empty) frontend when unset. NOT NULL DEFAULT ''
 * mirrors the sibling text columns (`hood`, `address`) already on the table.
 */
export class AddListingLocale1785600100000 implements MigrationInterface {
  name = 'AddListingLocale1785600100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "city" character varying NOT NULL DEFAULT ''`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "timezone" character varying NOT NULL DEFAULT ''`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "listings" DROP COLUMN "timezone"`);
    await queryRunner.query(`ALTER TABLE "listings" DROP COLUMN "city"`);
  }
}
