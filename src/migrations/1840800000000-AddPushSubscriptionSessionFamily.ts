// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SEC-12: `push_subscriptions.session_family_id` names the refresh-token
 * family (the signed-in session) that registered the device, so signing that
 * session out (logout, "sign out this device", "log out other devices") can
 * remove that device's push subscription too.
 *
 * Nullable with no backfill. A row with no link keeps today's behaviour: it
 * goes only once the member has no live session left anywhere. The client
 * re-posts its subscription once per signed-in page load, so linked rows fill
 * in on their own as members come back.
 *
 * No index: the cleanup statement filters on `user_id` first, which is
 * already indexed, and a member holds a handful of devices at most. Adding a
 * nullable column with no default is a catalog change on Postgres with no
 * table rewrite.
 */
export class AddPushSubscriptionSessionFamily1840800000000 implements MigrationInterface {
  name = 'AddPushSubscriptionSessionFamily1840800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "push_subscriptions" ADD "session_family_id" uuid`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "push_subscriptions" DROP COLUMN "session_family_id"`,
    );
  }
}
