// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `notifications.hidden_from_bell_at`: when the member cleared a row from the
 * bell dropdown with its X (`POST /notifications/:id/hide`). The row stays in
 * the table and on the /notifications page; only the dropdown leaves it out.
 * Every existing row still shows in the bell, so the column is nullable with
 * no default and needs no backfill. Hiding also marks the row read, so a
 * hidden row ages out through `NotificationRetentionService` like any read
 * row and needs no index of its own.
 */
export class AddNotificationHiddenFromBellAt1830200000000 implements MigrationInterface {
  name = 'AddNotificationHiddenFromBellAt1830200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notifications" ADD COLUMN "hidden_from_bell_at" timestamptz NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notifications" DROP COLUMN "hidden_from_bell_at"`,
    );
  }
}
