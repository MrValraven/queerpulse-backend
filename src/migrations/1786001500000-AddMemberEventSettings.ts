import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extends `member_event_reminder_preferences` (the per-member singleton event
 * settings row that already holds the reminder lead time) with the two settings
 * the frontend event-settings modal owns:
 *
 *  - `default_event_visibility` — the visibility a member's own events are
 *    created with. Short varchar (not a Postgres enum) so future options don't
 *    need a type migration; the DTO's @IsIn is the closed-set guard. Default
 *    `connections`, mirroring the frontend `DEFAULT_PREFS`.
 *  - `event_emails_enabled` — whether event email notifications are on. Default
 *    true, preserving the prior always-on behaviour for members without a row.
 */
export class AddMemberEventSettings1786001500000 implements MigrationInterface {
  name = 'AddMemberEventSettings1786001500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "member_event_reminder_preferences" ADD "default_event_visibility" character varying(20) NOT NULL DEFAULT 'connections'`,
    );
    await queryRunner.query(
      `ALTER TABLE "member_event_reminder_preferences" ADD "event_emails_enabled" boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "member_event_reminder_preferences" DROP COLUMN "event_emails_enabled"`,
    );
    await queryRunner.query(
      `ALTER TABLE "member_event_reminder_preferences" DROP COLUMN "default_event_visibility"`,
    );
  }
}
