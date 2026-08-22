import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `resource_guide_rating` — CNT-18 "was this guide helpful?" signal. Ratings
 * key off `content_key`, the i18n dot-path prefix that already addresses one
 * guide section (e.g. `legal.workplace.dismissal`) — there is no "guide"
 * entity in the backend to attach this to, and inventing one just to hang a
 * rating off it would be new scope beyond what CNT-18 asks for (see the
 * design doc's "Why content-key-based, not a guide entity").
 *
 * One row per `(content_key, member_id)` (`UQ_resource_guide_rating_
 * content_key_member_id`) — the upsert-toggle in `ResourceGuideRatingsService
 * .rate()` deletes/updates/creates against this same pair, so the unique
 * index also serves as the lookup index for both the member GET and the
 * toggle's existing-row check (it leads with `content_key`, which is exactly
 * what `AdminResourceGuideRatingsService.list()`'s `GROUP BY content_key`
 * needs too — no separate index required).
 *
 * `value` is `character varying` + a `CHECK` constraint (mirrors
 * `CreateHiddenFromMembers1791200300000`'s `CHK_hidden_from_not_self`)
 * rather than a native Postgres enum type — avoids an `ALTER TYPE ... ADD
 * VALUE` migration if a third rating value is ever added.
 *
 * `member_id` is `ON DELETE CASCADE` (mirrors `forum_post_vote`'s
 * `FK_forum_post_vote_user_id`) — this is a low-value, non-monetary signal;
 * an erased member's votes simply disappear rather than needing the
 * nullable/`SET NULL` erasure-safe pattern reserved for content with its own
 * standalone meaning (reports, mod-audit actor).
 *
 * Timestamp `1793000000000` is also used by a concurrently-authored
 * `AddPlatformAnnouncement` migration in this repo. Per this repo's
 * CLAUDE.md ("Duplicate timestamps between migrations are harmless — leave
 * them alone rather than renumbering to break the tie"), that collision is
 * left as-is rather than renumbered.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class CreateResourceGuideRating1793000000000 implements MigrationInterface {
  name = 'CreateResourceGuideRating1793000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "resource_guide_rating" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "content_key" character varying NOT NULL,
        "member_id" uuid NOT NULL,
        "value" character varying NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_resource_guide_rating" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_resource_guide_rating_content_key_member_id"
          UNIQUE ("content_key", "member_id"),
        CONSTRAINT "CHK_resource_guide_rating_value"
          CHECK ("value" IN ('helpful', 'not_helpful'))
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "resource_guide_rating" ADD CONSTRAINT "FK_resource_guide_rating_member_id"
        FOREIGN KEY ("member_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "resource_guide_rating" DROP CONSTRAINT "FK_resource_guide_rating_member_id"`,
    );
    await queryRunner.query(`DROP TABLE "resource_guide_rating"`);
  }
}
