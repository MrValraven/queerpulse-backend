// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-325: one additive, nullable column on `member_preferences` holding the
 * member's interface language, so the choice follows them to a new device and
 * survives cleared site data.
 *
 * Nullable with no default. `null` means the member has never told the
 * server; the app answers it by writing up the language the device already
 * uses. A literal default would be indistinguishable from a member who picked
 * that language, so no backfill is wanted either.
 *
 * A plain `varchar(5)` with a CHECK, following
 * `AddMessagingPrivacyPreferences1820500000000`'s `who_can_message`: a small
 * closed set that may grow is one constraint swap away from widening, where a
 * Postgres enum would need `ALTER TYPE ... ADD VALUE`. The CHECK mirrors
 * `MEMBER_LANGUAGE_VALUES` (`src/preferences/member-language.ts`) and lets
 * `NULL` through, as every CHECK does.
 */
export class AddMemberLanguagePreference1829700000000 implements MigrationInterface {
  name = 'AddMemberLanguagePreference1829700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "member_preferences"
        ADD COLUMN "language" varchar(5)
    `);
    await queryRunner.query(`
      ALTER TABLE "member_preferences"
        ADD CONSTRAINT "CHK_member_preferences_language"
        CHECK ("language" IN ('en', 'pt'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "member_preferences"
        DROP CONSTRAINT "CHK_member_preferences_language"
    `);
    await queryRunner.query(`
      ALTER TABLE "member_preferences"
        DROP COLUMN "language"
    `);
  }
}
