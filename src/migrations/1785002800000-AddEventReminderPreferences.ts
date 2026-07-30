// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-member event-reminder preference (currently just the lead time). One row
 * per member, keyed 1:1 to `users` (PK == FK), mirroring `member_preferences`.
 * Default lead 1440 min (1 day) reproduces the pre-preference behaviour for
 * everyone who never sets it.
 */
export class AddEventReminderPreferences1785002800000 implements MigrationInterface {
  name = 'AddEventReminderPreferences1785002800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "member_event_reminder_preferences" (
        "user_id" uuid NOT NULL,
        "lead_minutes" integer NOT NULL DEFAULT 1440,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_member_event_reminder_preferences" PRIMARY KEY ("user_id")
      )`,
    );
    await queryRunner.query(
      `ALTER TABLE "member_event_reminder_preferences"
        ADD CONSTRAINT "FK_member_event_reminder_preferences_user"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "member_event_reminder_preferences"
        DROP CONSTRAINT "FK_member_event_reminder_preferences_user"`,
    );
    await queryRunner.query(`DROP TABLE "member_event_reminder_preferences"`);
  }
}
