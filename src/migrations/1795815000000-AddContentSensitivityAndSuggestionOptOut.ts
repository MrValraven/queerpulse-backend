// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives two shipped-but-inert Settings switches a real column (PRD-10, PRD-16).
 *
 * ---------------------------------------------------------------------------
 * What was broken
 * ---------------------------------------------------------------------------
 * Both were placeholders. The Interests pane's three content-sensitivity
 * toggles ("dating & relationships", "mental health & wellbeing", "sexuality &
 * identity exploration") rendered `defaultChecked`, disabled and badged
 * coming-soon, with no field behind them and no filter anywhere in the read
 * path. The Visibility pane's "Appear in suggested connections" was the same
 * shape: the only lever a member actually had over being recommended to
 * strangers was the 24-hour `profiles.hidden_until` blackout, which also takes
 * them out of the member directory.
 *
 * ---------------------------------------------------------------------------
 * Why one migration for two findings
 * ---------------------------------------------------------------------------
 * Four booleans on the same table, added by the same change, read by the same
 * `/me/*` controller. Splitting them would put two ALTERs on `member_preferences`
 * in the same deploy for no gain.
 *
 * ---------------------------------------------------------------------------
 * Why every default is FALSE
 * ---------------------------------------------------------------------------
 * `NOT NULL DEFAULT false` covers existing rows through the ALTER itself, so
 * nothing changes for anybody until they touch the switch. That is the whole
 * point here, and it is the opposite call from `AddHidePushPreviews`, which
 * deliberately backfilled the entire member base to the protective value.
 *
 * The difference is what the flag does when it is on. Hiding a push preview
 * stops information LEAVING the member's control, so being wrong in the
 * cautious direction costs one extra tap. These four SUBTRACT things from the
 * member's own view or from other people's. Backfilling them on would silently
 * strip whole communities out of every feed and empty the suggestion strip for
 * a platform whose premise is that members meet each other, with nobody able
 * to see what they were no longer being shown.
 *
 * See the doc comments on `MemberPreferences` for the per-column reasoning,
 * including why `hide_from_suggestions` is one-directional (it stops the
 * member being recommended, never stops them seeing recommendations).
 *
 * ---------------------------------------------------------------------------
 * No indexes
 * ---------------------------------------------------------------------------
 * The three content flags are read once per feed request by primary key
 * (`WHERE user_id = $1`). `hide_from_suggestions` is read as a correlated
 * `NOT EXISTS` on `member_preferences.user_id`, again the primary key, over a
 * candidate pool already bounded to 300 rows. Neither wants a secondary index,
 * and a boolean whose overwhelming value is `false` would not get one used.
 *
 * Ordinary transactional DDL: four statements, no enum changes, no concurrent
 * index. No `IF NOT EXISTS` guard, so a ledger mismatch fails loudly rather
 * than writing a second row for work already done (see CLAUDE.md).
 */
export class AddContentSensitivityAndSuggestionOptOut1795815000000 implements MigrationInterface {
  name = 'AddContentSensitivityAndSuggestionOptOut1795815000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "member_preferences" ADD "hide_dating_content" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "member_preferences" ADD "hide_mental_health_content" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "member_preferences" ADD "hide_sexuality_identity_content" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "member_preferences" ADD "hide_from_suggestions" boolean NOT NULL DEFAULT false`,
    );
  }

  /**
   * Drops cleanly, and reverting is louder than it looks: every member who
   * had opted out of a content category is opted back in, and every member who
   * had asked not to be recommended to strangers becomes recommendable again
   * the moment the column goes. Nothing else in the schema reads these four,
   * so there is no orphaned data, only choices the platform can no longer
   * honour. Dropped in reverse order of `up()` for symmetry.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "member_preferences" DROP COLUMN "hide_from_suggestions"`,
    );
    await queryRunner.query(
      `ALTER TABLE "member_preferences" DROP COLUMN "hide_sexuality_identity_content"`,
    );
    await queryRunner.query(
      `ALTER TABLE "member_preferences" DROP COLUMN "hide_mental_health_content"`,
    );
    await queryRunner.query(
      `ALTER TABLE "member_preferences" DROP COLUMN "hide_dating_content"`,
    );
  }
}
