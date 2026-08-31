import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `profile_last_active`: the coarse "recently active" directory signal.
 *
 * WHY A TABLE RATHER THAN A COLUMN ON `profiles`. The profile row is hand-mapped
 * into several response shapes (`toProfileCard`, `toMemberCard`,
 * `toFullProfile`, `toLimitedProfile`, the public-profile path) because this
 * codebase has no global serializer. A member's activity is the field where an
 * accidental leak is a safety problem, so it lives where nothing can select it
 * by accident: reaching it takes a deliberate join or a deliberate lookup.
 *
 * WHAT THE COLUMN CAN AND CANNOT SAY. `last_active_month` is a `date` pinned by
 * CHECK constraint to the first day of a month. The finest question it can
 * answer is "which month", and the read path does not even expose that: it
 * collapses the month into one of three bands. There is deliberately no
 * `created_at`, no `updated_at` and no `last_seen_at` on this table. Any of
 * them would restore the precise last-seen timestamp the design exists to
 * avoid.
 *
 * NO BACKFILL, BY DESIGN. Every existing member starts with no row. "No row" is
 * a real, distinct state the read path renders as nothing at all. Seeding day
 * one from `profiles.joined_at` or a refresh-token row would invent activity
 * the platform never observed, and would stamp "not active recently" on the
 * entire existing directory the moment this ships.
 *
 * `is_hidden` is the member's opt-out, defaulting to `false`. It sits on this
 * table rather than in `member_preferences` so that one read answers both "what
 * is the band" and "may this viewer see it", with no second query per member on
 * a paginated directory page.
 *
 * THE INDEX serves exactly one query: the directory's `recentlyActive` sort,
 * which reads the newest month first and never reads a hidden member's value.
 * It is therefore partial (`WHERE is_hidden = false`) and DESC, matching the
 * ORDER BY in `ProfilesService.searchMembers`. Members with no row and members
 * who opted out both sort last under NULLS LAST, which is the honest answer:
 * the platform has nothing to say about either.
 *
 * TRANSACTIONAL. One CREATE TABLE, one CREATE INDEX and one ADD CONSTRAINT,
 * every one against an object created in this same transaction against an empty
 * table, so no `CONCURRENTLY` two-phase split is needed.
 */
export class CreateProfileLastActive1794760000000 implements MigrationInterface {
  name = 'CreateProfileLastActive1794760000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "profile_last_active" (
        "user_id" uuid NOT NULL,
        "last_active_month" date NOT NULL,
        "is_hidden" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_profile_last_active" PRIMARY KEY ("user_id"),
        CONSTRAINT "CHK_profile_last_active_month_start"
          CHECK (
            "last_active_month"
              = date_trunc('month', "last_active_month"::timestamp)::date
          )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_profile_last_active_month_visible"
        ON "profile_last_active" ("last_active_month" DESC)
        WHERE "is_hidden" = false
    `);
    await queryRunner.query(`
      ALTER TABLE "profile_last_active"
        ADD CONSTRAINT "FK_profile_last_active_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "profile_last_active" DROP CONSTRAINT "FK_profile_last_active_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_profile_last_active_month_visible"`,
    );
    await queryRunner.query(`DROP TABLE "profile_last_active"`);
  }
}
