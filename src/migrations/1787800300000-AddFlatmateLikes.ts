import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `flatmate_likes` table backing the optional swipe/browse discovery
 * view: one directed like/pass per (member, profile), with a mutual `like`
 * forming a match. Purely additive — no existing table is touched, so this is
 * safe to apply on top of live data.
 */
export class AddFlatmateLikes1787800300000 implements MigrationInterface {
  name = 'AddFlatmateLikes1787800300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "flatmate_likes_decision_enum" AS ENUM('like', 'pass')`,
    );
    await queryRunner.query(
      `CREATE TABLE "flatmate_likes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "from_user_id" uuid NOT NULL,
        "to_profile_id" uuid NOT NULL,
        "decision" "flatmate_likes_decision_enum" NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_flatmate_likes" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_flatmate_likes_from_to" ON "flatmate_likes" ("from_user_id", "to_profile_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_flatmate_likes_to_profile_id" ON "flatmate_likes" ("to_profile_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_flatmate_likes_to_profile_id"`);
    await queryRunner.query(`DROP INDEX "UQ_flatmate_likes_from_to"`);
    await queryRunner.query(`DROP TABLE "flatmate_likes"`);
    await queryRunner.query(`DROP TYPE "flatmate_likes_decision_enum"`);
  }
}
