// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Anonymous vouchers leave the vouchee's bell.
 *
 * `VOUCH_CREATED` used to drop the vouch's `anonymous` flag, so
 * `NotificationsListener.onVouchCreated` wrote `{ voucherId }` onto every
 * `vouch_received` row and the bell resolved it into a named actor with an
 * avatar and a profile link ("<name> vouched for you."), while the same
 * member's voucher roster read "Anonymous". The listener now writes an empty
 * payload for an anonymous vouch, the split `SafeSpaceVouch` already uses, so
 * `actorIdOf` yields null and the row reads "Someone vouched for you.".
 *
 * This strips `voucherId` from the rows written before that fix. A row is
 * matched to its vouch by recipient and voucher (`vouches` is unique on the
 * pair, `UQ_vouches_voucher_vouchee`), and redacted when that vouch is
 * anonymous today. Withdrawn vouches are included on purpose: a withdrawal
 * keeps the row and its `anonymous` flag, and the old bell row must stop
 * naming the voucher either way. A pair that was named once and re-vouched
 * anonymously is redacted too, since the roster now presents that voucher as
 * anonymous and an older named row would undo that.
 *
 * `payload` is `jsonb`, so `-` removes the key in place and leaves every other
 * key as it was. Purely data, no DDL, one set-based statement over the
 * `vouch_received` rows.
 */
export class RedactAnonymousVoucherFromNotifications1831000000000 implements MigrationInterface {
  name = 'RedactAnonymousVoucherFromNotifications1831000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "notifications" AS "notification"
      SET "payload" = "notification"."payload" - 'voucherId'
      FROM "vouches" AS "vouch"
      WHERE "notification"."type" = 'vouch_received'
        AND "vouch"."vouchee_id" = "notification"."user_id"
        AND "vouch"."voucher_id"::text = "notification"."payload"->>'voucherId'
        AND "vouch"."anonymous" = true
    `);
  }

  public async down(): Promise<void> {
    // Deliberately a no-op. The redaction cannot be reversed and must not be:
    // putting the voucher's id back would name a member who chose to vouch
    // anonymously, which is the leak this migration closes.
  }
}
