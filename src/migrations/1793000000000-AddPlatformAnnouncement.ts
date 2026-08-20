import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the sitewide admin-authored announcement banner (ADM-25):
 *
 * - Four new columns on the `platform_settings` singleton row —
 *   `announcement_enabled` / `announcement_message` /
 *   `announcement_expires_at` (an optional auto-hide safety net, checked at
 *   the read boundary in `PlatformStatusController`, never mutated here) /
 *   `announcement_version` (bumped to a fresh UUID by
 *   `PlatformSettingsService.update` whenever the message content actually
 *   changes, so a per-member dismissal of an old banner never suppresses a
 *   new one).
 * - A new `announcement_dismissals` table: one row per (member, version) who
 *   dismissed that exact banner. Its own table rather than a reuse of
 *   `persona_nudges` — that table's `nudge_key` is validated against a fixed,
 *   enumerated set, and `announcement_version` is a value newly minted on
 *   every content edit, not a member of any fixed list. See
 *   `AnnouncementDismissal`'s doc comment for the full reasoning.
 *
 * `announcement_version` gets a `uuid_generate_v4()` default so the existing
 * singleton row (inserted by `AddPlatformSettings1782800790000`) ends up with
 * a real version instead of NULL the moment this migration runs — the column
 * itself is NOT NULL with no application-level default, mirroring how
 * `PlatformSettings.announcementVersion` is typed as `string`, never
 * `string | null`.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddPlatformAnnouncement1793000000000 implements MigrationInterface {
  name = 'AddPlatformAnnouncement1793000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "platform_settings" ADD "announcement_enabled" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_settings" ADD "announcement_message" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_settings" ADD "announcement_expires_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_settings" ADD "announcement_version" uuid NOT NULL DEFAULT uuid_generate_v4()`,
    );

    await queryRunner.query(`
      CREATE TABLE "announcement_dismissals" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "announcement_version" uuid NOT NULL,
        "dismissed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_announcement_dismissals" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_announcement_dismissals_user_id_version" UNIQUE ("user_id", "announcement_version")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_announcement_dismissals_user_id" ON "announcement_dismissals" ("user_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "announcement_dismissals" ADD CONSTRAINT "FK_announcement_dismissals_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "announcement_dismissals" DROP CONSTRAINT "FK_announcement_dismissals_user_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_announcement_dismissals_user_id"`);
    await queryRunner.query(`DROP TABLE "announcement_dismissals"`);

    await queryRunner.query(
      `ALTER TABLE "platform_settings" DROP COLUMN "announcement_version"`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_settings" DROP COLUMN "announcement_expires_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_settings" DROP COLUMN "announcement_message"`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_settings" DROP COLUMN "announcement_enabled"`,
    );
  }
}
