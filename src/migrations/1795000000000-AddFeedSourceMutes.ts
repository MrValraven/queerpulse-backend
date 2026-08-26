import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `feed_source_mutes` (SOC-18) — one row per member and source the
 * member has asked their feed to show less of.
 *
 * WHY A NEW TABLE RATHER THAN WIDENING `mutes`. `mutes` is person-to-person
 * and is read by `BlockFilterService` everywhere content is listed, not just
 * the feed. A community or a thread is not a person, and turning a room down
 * in one member's home screen is a much smaller act than silencing someone.
 * Folding the two together would make every existing `mutes` read have to
 * learn about kinds it has no opinion on.
 *
 * WHY NO FOREIGN KEY ON `source_id`. The column addresses two different
 * parents (`communities.id`, `forum_thread.id`), so one FK cannot express it,
 * and a member's own preference row should not be rewritten by someone else
 * deleting a community. An orphan row is inert: the read path only uses these
 * ids as a NOT-IN filter, and `GET /feed/mutes` drops any row whose subject no
 * longer resolves.
 *
 * `user_id` DOES cascade: a member's feed preferences die with the member.
 *
 * `UQ_feed_source_mutes (user_id, source_kind, source_id)` makes muting
 * idempotent at the DB level, so a double-tap is absorbed by
 * `ON CONFLICT DO NOTHING` rather than raising 23505. It leads with
 * `user_id`, so it also serves the "what has this member muted?" read that
 * every feed page issues; `IDX_feed_source_mutes_user_id` is kept as the
 * explicit single-column index for it.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddFeedSourceMutes1795000000000 implements MigrationInterface {
  name = 'AddFeedSourceMutes1795000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "feed_source_mutes_source_kind_enum" AS ENUM('community', 'forum_thread')`,
    );
    await queryRunner.query(`
      CREATE TABLE "feed_source_mutes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "source_kind" "feed_source_mutes_source_kind_enum" NOT NULL,
        "source_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_feed_source_mutes" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_feed_source_mutes" UNIQUE ("user_id", "source_kind", "source_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_feed_source_mutes_user_id" ON "feed_source_mutes" ("user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "feed_source_mutes" ADD CONSTRAINT "FK_feed_source_mutes_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "feed_source_mutes" DROP CONSTRAINT "FK_feed_source_mutes_user_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_feed_source_mutes_user_id"`);
    await queryRunner.query(`DROP TABLE "feed_source_mutes"`);
    await queryRunner.query(`DROP TYPE "feed_source_mutes_source_kind_enum"`);
  }
}
