// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Collapsing same-subject notification rows (`notifications.bundle_key`,
 * `notifications.other_actor_count`).
 *
 * Forty replies to one thread used to write forty rows: the bell read as forty
 * separate events, the unread badge said forty, and clearing it was forty taps
 * for one conversation. With these two columns an unread row for the same
 * (recipient, type, subject) absorbs the next event instead: the newest actor
 * replaces the payload, `other_actor_count` goes up by one, and `created_at` is
 * bumped so the bundle floats back to the top of the feed. One row, rendered as
 * "Ana and 39 others replied".
 *
 * Both columns are backfilled by their defaults in the same metadata-only
 * `ADD COLUMN`, so every existing row is a valid un-bundled row (`NULL` key,
 * zero others) and nothing has to be rewritten.
 *
 * `bundle_key` is nullable on purpose: it is `NULL` for every type that does not
 * bundle, which is most of them, and the partial index below then covers only
 * the rows that can ever absorb anything. See `notification-bundling.ts` for
 * which types bundle and why mentions and every always-delivered type do not.
 */
export class AddNotificationBundling1794731000000 implements MigrationInterface {
  name = 'AddNotificationBundling1794731000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notifications"
        ADD "bundle_key" character varying(200)
    `);
    await queryRunner.query(`
      ALTER TABLE "notifications"
        ADD "other_actor_count" integer NOT NULL DEFAULT 0
    `);
    // Serves the lookup every notification write now makes: "does this
    // recipient already hold an unread row for this subject?". Partial, because
    // only unread bundling rows can ever absorb anything, which keeps the index
    // a small fraction of a table that is mostly read rows with no bundle key.
    await queryRunner.query(`
      CREATE INDEX "IDX_notifications_bundle"
        ON "notifications" ("user_id", "bundle_key")
        WHERE "bundle_key" IS NOT NULL AND "read" = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_notifications_bundle"`);
    await queryRunner.query(
      `ALTER TABLE "notifications" DROP COLUMN "other_actor_count"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications" DROP COLUMN "bundle_key"`,
    );
  }
}
