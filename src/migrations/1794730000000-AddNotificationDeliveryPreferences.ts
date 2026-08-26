// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Quiet hours (`notification_delivery_preferences`).
 *
 * The Notifications settings pane has offered a quiet-hours selector for a long
 * time and persisted nothing, so a member who set one and then got a 3am push
 * had been actively misled. This table is where the window finally lives.
 *
 * **Sparse**, like `notification_preferences`: a row exists only once a member
 * has actually set a window, and the service deletes it again when they return
 * to the defaults. A member with no row has quiet hours off, which is what
 * everyone had before this table existed, so nothing changes for anyone who
 * never opens the setting.
 *
 * The window is two minute-of-day integers rather than two `time` columns
 * because the only question ever asked of it is "is this member's local clock
 * inside the range right now?", which is integer comparison. A window that
 * wraps midnight (22:00 to 08:00, the common case) is simply `start > end`.
 *
 * `time_zone` is an IANA name, never a fixed UTC offset: an offset silently
 * drifts an hour when the member's region changes to or from summer time, and
 * quiet hours that move by an hour in October are the same broken promise in a
 * quieter form. The send path reads the local clock through the runtime's zone
 * database, which knows about the changeover night.
 *
 * Quiet hours gate the PUSH channel only. The in-app row is always written, so
 * nothing is lost: the buzz is withheld and the notification is waiting in the
 * bell. That contract is enforced in `PushNotificationListener` and
 * `PushMessageListener`, both of which run strictly after the write.
 */
export class AddNotificationDeliveryPreferences1794730000000 implements MigrationInterface {
  name = 'AddNotificationDeliveryPreferences1794730000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "notification_delivery_preferences" (
        "user_id" uuid NOT NULL,
        "is_quiet_hours_enabled" boolean NOT NULL DEFAULT false,
        "quiet_hours_start_minute" smallint NOT NULL DEFAULT 1320,
        "quiet_hours_end_minute" smallint NOT NULL DEFAULT 480,
        "time_zone" character varying(64) NOT NULL DEFAULT 'UTC',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_delivery_preferences" PRIMARY KEY ("user_id")
      )
    `);
    // Both minutes are minute-of-day. Constrained in the schema as well as the
    // DTO so a bad value can never reach the send path through any other door.
    await queryRunner.query(`
      ALTER TABLE "notification_delivery_preferences"
        ADD CONSTRAINT "CHK_notification_delivery_quiet_hours_minutes"
        CHECK (
          "quiet_hours_start_minute" BETWEEN 0 AND 1439
          AND "quiet_hours_end_minute" BETWEEN 0 AND 1439
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "notification_delivery_preferences"`);
  }
}
