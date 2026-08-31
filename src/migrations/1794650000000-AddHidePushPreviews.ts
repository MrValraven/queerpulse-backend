import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Move "hide notification previews" from the browser to the server (ID-13).
 *
 * ---------------------------------------------------------------------------
 * The bug this closes
 * ---------------------------------------------------------------------------
 * The setting shipped as an IndexedDB flag (`queerpulse/src/pushPrivacy.ts`)
 * that the service worker read inside its `push` handler and used to rewrite
 * the title and body before `showNotification`. On Chrome, Firefox and every
 * desktop engine that is exactly right.
 *
 * iOS never runs that code. Safari's push implementation decrypts the payload
 * and renders its plain-text `title` and `body` itself; the worker's push
 * handler is not invoked at all. And the composer put the sender's NAME in
 * those fields. So on an iPhone the toggle did nothing, silently, while the
 * settings row said previews were hidden. That is the exact harm the feature
 * was written to prevent (being outed to whoever can see your lock screen), on
 * the platform where lock-screen previews are hardest to avoid.
 *
 * The only fix is for the SERVER to decide what a payload may contain. This
 * column is that decision, read per recipient by `PushPreviewPrivacyService`
 * before the push is encrypted.
 *
 * ---------------------------------------------------------------------------
 * DEFAULT TRUE, and the backfill is deliberate
 * ---------------------------------------------------------------------------
 * `NOT NULL DEFAULT true` covers every existing row through the ALTER itself,
 * so this is a backfill to HIDDEN for the entire member base, including the
 * members who never opened the setting and the ones whose browser-side flag
 * said "show".
 *
 * That is a real behaviour change for existing members, taken on purpose. The
 * two errors are not symmetric: a wrongly hidden preview costs one extra tap,
 * a wrongly shown one cannot be taken back once someone has read it. The
 * client-side default was `false` only because it was retrofitted onto shipped
 * behaviour; there is no reason for a privacy control to inherit that.
 *
 * The browser-side flag is NOT migrated into this column, and cannot be: it
 * lives in per-device IndexedDB that the server has never seen. It keeps
 * working as a second line of defence on engines that run the service worker,
 * and the app now mirrors THIS value into it on boot, so the two converge on
 * the server's answer at the next sign-in on each device.
 *
 * ---------------------------------------------------------------------------
 * Shape
 * ---------------------------------------------------------------------------
 * `member_preferences` is the right table for the same reason
 * `login_alerts_enabled` landed there (`AddSecurityAlertsAndDeviceLabel...`):
 * these are account-level switches, not the content-volume categories that
 * live in `notification_preferences`. One boolean, no index: every read is
 * `WHERE user_id IN (...)` against the primary key.
 *
 * Ordinary transactional DDL: one statement, no enum changes, no concurrent
 * index. No `IF NOT EXISTS` guard, so a ledger mismatch fails loudly rather
 * than writing a second row for work already done (see CLAUDE.md).
 */
export class AddHidePushPreviews1794650000000 implements MigrationInterface {
  name = 'AddHidePushPreviews1794650000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "member_preferences" ADD "hide_push_previews" boolean NOT NULL DEFAULT true`,
    );
  }

  /**
   * Drops cleanly. Nothing outside this feature reads the column, and losing it
   * does not lose information the member cannot restate. The toggle simply
   * reverts to the service-worker-only behaviour it had before, which on iOS
   * means previews come back. Worth knowing before reverting: this `down()`
   * un-hides lock screens.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "member_preferences" DROP COLUMN "hide_push_previews"`,
    );
  }
}
