// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `notifications.pushed_at`, the moment a push went out for the row's
 * recipient. Studio sends at most one new-release push per recipient per
 * artist per UTC day: the push listener claims the day by stamping this column
 * and skips a recipient who already holds a stamp from today on the same
 * persona bundle. The in-app row is written every time; only the push is
 * limited. Bundle absorption leaves the column untouched, so a stamp survives
 * a later release folding into the same row.
 *
 * Nullable with no default and no backfill: an existing row simply never
 * pushed through this path. The partial index serves the "already pushed
 * today" lookup and stays small because only pushed rows enter it.
 */
export class AddNotificationPushedAt1837600000000 implements MigrationInterface {
  name = 'AddNotificationPushedAt1837600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notifications" ADD "pushed_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notifications_pushed_bundle" ON "notifications" ("user_id", "bundle_key", "pushed_at") WHERE "pushed_at" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_notifications_pushed_bundle"`);
    await queryRunner.query(
      `ALTER TABLE "notifications" DROP COLUMN "pushed_at"`,
    );
  }
}
