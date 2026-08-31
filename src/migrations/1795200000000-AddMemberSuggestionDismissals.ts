import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `member_suggestion_dismissals` (SOC-05) — one row per member and
 * person that member has waved away from `GET /members/suggested`.
 *
 * WHY A TABLE AND NOT A CLIENT-SIDE DISMISS. A dismissal held in the browser
 * dies with the tab, so the same faces come back on the next feed load and on
 * every other device. The whole point of the row is that "no thanks" is
 * remembered.
 *
 * WHY NOT REUSE `mutes`. A mute is a statement about a person's content
 * everywhere on the platform, read by `BlockFilterService` on every content
 * list. Waving away a suggestion is a statement about one surface and nothing
 * else: the dismissed member keeps their full reach in the directory, in
 * search, in shared communities and in the feed. Folding the two together
 * would silently escalate a small "not this card" into a platform-wide
 * silence.
 *
 * BOTH FOREIGN KEYS CASCADE. `user_id` because a member's own preferences die
 * with the member; `dismissed_user_id` because an erased account must leave no
 * row naming it, in a table nobody but the dismisser can read.
 *
 * `UQ_member_suggestion_dismissals (user_id, dismissed_user_id)` makes the
 * dismiss route idempotent at the DB level, so a double-tap is absorbed by
 * `ON CONFLICT DO NOTHING` rather than raising 23505. It leads with `user_id`,
 * so it also serves the "who has this member dismissed?" read that every
 * suggestions request issues; `IDX_member_suggestion_dismissals_user_id` is
 * kept as the explicit single-column index for that read.
 */
export class AddMemberSuggestionDismissals1795200000000 implements MigrationInterface {
  name = 'AddMemberSuggestionDismissals1795200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "member_suggestion_dismissals" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "dismissed_user_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_member_suggestion_dismissals" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_member_suggestion_dismissals" UNIQUE ("user_id", "dismissed_user_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_member_suggestion_dismissals_user_id" ON "member_suggestion_dismissals" ("user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "member_suggestion_dismissals" ADD CONSTRAINT "FK_member_suggestion_dismissals_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "member_suggestion_dismissals" ADD CONSTRAINT "FK_member_suggestion_dismissals_dismissed_user_id" FOREIGN KEY ("dismissed_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "member_suggestion_dismissals" DROP CONSTRAINT "FK_member_suggestion_dismissals_dismissed_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "member_suggestion_dismissals" DROP CONSTRAINT "FK_member_suggestion_dismissals_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_member_suggestion_dismissals_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "member_suggestion_dismissals"`);
  }
}
