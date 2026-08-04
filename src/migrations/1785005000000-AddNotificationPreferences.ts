// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-member, per-category notification preference overrides. Sparse: a row
 * exists only for a category a member has turned off, so a member with no rows
 * gets every notification (both channels default ON), reproducing the
 * pre-preference behaviour. Keyed `(user_id, category)`; `category` is a plain
 * varchar holding a `NotificationPreferenceCategory` value (no Postgres enum, so
 * adding a category stays code-only). `user_id` FK cascades on member deletion,
 * matching `member_event_reminder_preferences`.
 */
export class AddNotificationPreferences1785005000000 implements MigrationInterface {
  name = 'AddNotificationPreferences1785005000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "notification_preferences" (
        "user_id" uuid NOT NULL,
        "category" character varying(64) NOT NULL,
        "in_app" boolean NOT NULL DEFAULT true,
        "push" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_preferences" PRIMARY KEY ("user_id", "category")
      )`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_preferences"
        ADD CONSTRAINT "FK_notification_preferences_user"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notification_preferences"
        DROP CONSTRAINT "FK_notification_preferences_user"`,
    );
    await queryRunner.query(`DROP TABLE "notification_preferences"`);
  }
}
