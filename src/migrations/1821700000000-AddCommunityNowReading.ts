// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `communities.now_reading`: the book a reading group (a community tagged
 * `book-club`) is reading now. Nullable varchar(200), so the ADD COLUMN is
 * catalog-only with no table rewrite.
 *
 * The backfill copies `name` into `now_reading` for every existing reading
 * group. Before this column, a reading group's name WAS its book, so copying
 * it keeps the group's book on record once the group renames itself.
 * `btrim` drops stray leading and trailing whitespace from the name first,
 * and `left(..., 200)` then fits the column even for a name written outside
 * the create DTO's 200-character cap.
 */
export class AddCommunityNowReading1821700000000 implements MigrationInterface {
  name = 'AddCommunityNowReading1821700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "now_reading" character varying(200)`,
    );
    await queryRunner.query(
      `UPDATE "communities" SET "now_reading" = left(btrim("name"), 200) WHERE 'book-club' = ANY("tags")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "now_reading"`,
    );
  }
}
