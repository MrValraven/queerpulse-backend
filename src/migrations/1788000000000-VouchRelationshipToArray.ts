import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widens a vouch's "how you know them" from a single relationship to several.
 * Replaces the scalar `relationship` column with an array `relationships` of
 * the same `vouches_relationship_enum`, backfilling each existing non-null
 * value into a one-element array so no recorded relationship is lost.
 */
export class VouchRelationshipToArray1788000000000 implements MigrationInterface {
  name = 'VouchRelationshipToArray1788000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "vouches" ADD "relationships" "vouches_relationship_enum"[]`,
    );
    await queryRunner.query(
      `UPDATE "vouches"
         SET "relationships" = ARRAY["relationship"]::"vouches_relationship_enum"[]
         WHERE "relationship" IS NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "vouches" DROP COLUMN "relationship"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "vouches" ADD "relationship" "vouches_relationship_enum"`,
    );
    // Collapse back to a single value: keep the first element of the array.
    await queryRunner.query(
      `UPDATE "vouches"
         SET "relationship" = "relationships"[1]
         WHERE "relationships" IS NOT NULL
           AND array_length("relationships", 1) >= 1`,
    );
    await queryRunner.query(
      `ALTER TABLE "vouches" DROP COLUMN "relationships"`,
    );
  }
}
