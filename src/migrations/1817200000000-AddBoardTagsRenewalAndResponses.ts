// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

// Two changes in one migration because they ship one feature: board posts gain
// a tag vocabulary and renewal bookkeeping, and responses (offers to help and
// board-scoped hellos) get their own table.
export class AddBoardTagsRenewalAndResponses1817200000000 implements MigrationInterface {
  name = 'AddBoardTagsRenewalAndResponses1817200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "board_posts"
        ADD COLUMN "tags" text[] NOT NULL DEFAULT '{}',
        ADD COLUMN "renewed_at" timestamptz NULL,
        ADD COLUMN "renew_count" integer NOT NULL DEFAULT 0
    `);
    // GIN supports the && overlap operator the reciprocal match query uses.
    await queryRunner.query(`
      CREATE INDEX "IDX_board_posts_tags" ON "board_posts" USING GIN ("tags")
    `);
    await queryRunner.query(`
      CREATE TYPE "board_post_responses_kind_enum" AS ENUM ('help', 'hello')
    `);
    await queryRunner.query(`
      CREATE TABLE "board_post_responses" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "post_id" uuid NOT NULL,
        "responder_id" uuid NOT NULL,
        "kind" "board_post_responses_kind_enum" NOT NULL,
        "note" text NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_board_post_responses" PRIMARY KEY ("id"),
        CONSTRAINT "FK_board_post_responses_post" FOREIGN KEY ("post_id")
          REFERENCES "board_posts"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_board_post_responses_responder" FOREIGN KEY ("responder_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_board_post_responses_post_responder_kind"
        ON "board_post_responses" ("post_id", "responder_id", "kind")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_board_post_responses_post_id"
        ON "board_post_responses" ("post_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_board_post_responses_responder_id"
        ON "board_post_responses" ("responder_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "board_post_responses"`);
    await queryRunner.query(`DROP TYPE "board_post_responses_kind_enum"`);
    await queryRunner.query(`DROP INDEX "IDX_board_posts_tags"`);
    await queryRunner.query(`
      ALTER TABLE "board_posts"
        DROP COLUMN "tags",
        DROP COLUMN "renewed_at",
        DROP COLUMN "renew_count"
    `);
  }
}
