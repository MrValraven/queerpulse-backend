import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tell a member when a new device signs in (ID-06).
 *
 * Until now not one of the notification types was about the ACCOUNT. Every
 * value in `notifications_type_enum` described something happening inside the
 * community — a reply, an invite, a vouch — and the one category where prompt
 * notice matters most had no type at all. A stolen session was invisible until
 * somebody went looking for it on a page that printed raw User-Agent strings.
 *
 * Three things land together here, because each is useless without the others.
 *
 * 1. THE ENUM VALUES.
 *    - `security_new_sign_in` — emitted by `AuthService.issueTokens` when a
 *      refresh-token FAMILY is created for a device label the member's history
 *      does not already contain.
 *    - `account_export_ready` and `account_deletion_final_warning` — the two
 *      account-lifecycle moments that currently end in silence. NEITHER HAS AN
 *      EMIT SITE YET: they belong to `src/account`, which this change does not
 *      touch. They are added now so wiring them later is a one-line service
 *      call rather than a second `ALTER TYPE` and a second frontend deploy.
 *      Both are IN-APP notifications (plus push). QueerPulse sends no email.
 *
 * 2. THE DEVICE LABEL, on `refresh_tokens`.
 *    A coarse, version-free name — "Chrome on macOS", "Safari on iPhone" —
 *    derived at mint time by `auth/device-label.ts` and carried through every
 *    rotation. It does two jobs at once, and that is the point of storing it
 *    rather than deriving it per read: it is what `/account/sessions` shows the
 *    member instead of a 130-character UA string, AND it is the key
 *    `AuthService.recogniseDevice` compares to decide whether a sign-in is new.
 *    One stored value means the alert and the security page can never disagree
 *    about which devices this member has used.
 *
 *    NULLABLE, with no backfill. A backfill would mean reimplementing the UA
 *    parser in SQL, and a second implementation of a matcher is a second
 *    implementation to keep in step. Existing rows keep their `user_agent` and
 *    get a NULL label, which `recogniseDevice` reads as "no device history
 *    here" — so a member whose entire history predates this column is not
 *    alerted about their own everyday laptop the first time they sign in after
 *    the deploy. It self-heals: the first labelled row is written by that same
 *    sign-in.
 *
 *    `last_seen_at` names the value `AccountService.listSessions` was already
 *    approximating with the newest row's `created_at`. Same number today, but
 *    it means "when was this session last seen" rather than "when was this
 *    credential minted", and gives a future non-rotation touchpoint somewhere
 *    to stamp.
 *
 * 3. THE MEMBER'S SWITCH, on `member_preferences`.
 *    `login_alerts_enabled`, DEFAULT TRUE — the opposite default to
 *    `public_profile_enabled` on the same table, and for the same reason it is
 *    false: the safe default is the one a member would choose if they had read
 *    the setting, and nobody opts in to hearing about an unrecognised sign-in.
 *    Settings has shown "Login alerts" as a coming-soon toggle since the pane
 *    was built; this is the column behind it. NOT NULL with a default, so every
 *    existing row is covered by the ALTER itself.
 *
 *    It is deliberately NOT a `NotificationPreferenceCategory`: those are
 *    content-volume controls stored in `notification_preferences`, and a
 *    security alert is not content. It is read at the EMIT site, so switching
 *    it off silences the bell and the push together rather than writing a row
 *    nothing renders.
 *
 * NO GEO. `src/geocode` resolves ADDRESSES to coordinates through Nominatim;
 * there is no IP-to-location signal anywhere in this codebase, and adding one
 * would mean shipping members' IP addresses to a third party to make a security
 * alert slightly more specific. The alert names the device and the time, and
 * says nothing it cannot stand behind.
 *
 * NON-TRANSACTIONAL, LOUDLY. `ALTER TYPE ... ADD VALUE` must be COMMITTED
 * before any statement may use the new label, so this opts out of the wrapping
 * transaction (`transaction = false`, honoured because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`), following
 * `AddListingCoManagerEnumValues1794530000000`. Nothing here uses any of the
 * three new labels, so there is no same-transaction hazard either way; the
 * safer precedent is the one worth copying. `up()` is therefore NOT atomic: a
 * failure partway leaves the earlier statements applied. Every statement is
 * `IF NOT EXISTS`, so re-running is safe.
 *
 * No new index. `recogniseDevice` filters on `user_id` alone and reads the
 * labels back in memory, which the existing `IDX_refresh_tokens_user_id`
 * already covers — a member has a handful of live sessions, not a table scan.
 */
export class AddSecurityAlertsAndDeviceLabel1794610100000 implements MigrationInterface {
  name = 'AddSecurityAlertsAndDeviceLabel1794610100000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'security_new_sign_in'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'account_export_ready'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'account_deletion_final_warning'`,
    );

    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "device_label" character varying(120)`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "last_seen_at" TIMESTAMP WITH TIME ZONE`,
    );

    await queryRunner.query(
      `ALTER TABLE "member_preferences" ADD COLUMN IF NOT EXISTS "login_alerts_enabled" boolean NOT NULL DEFAULT true`,
    );
  }

  /**
   * Reverts everything that CAN be reverted, and says plainly what cannot.
   *
   * The three columns drop cleanly: nothing outside this feature reads them,
   * and `refresh_tokens.user_agent` still carries the raw string the labels
   * were derived from, so no information is destroyed that was not derivable
   * before. Existing sessions keep working — the label is advisory, never part
   * of authentication.
   *
   * The three enum labels STAY. Postgres has no `ALTER TYPE ... DROP VALUE`,
   * and removing them would need the rename-and-recreate dance (see
   * `RemovePendingStatus1782800740000`) plus a decision about what any
   * `security_new_sign_in` rows already written become — a real data decision
   * this migration must not guess at. Leaving unused labels in an enum is inert.
   *
   * This `down()` therefore SUCCEEDS rather than throwing, unlike the
   * enum-only migrations that precede it: the columns are the part with a
   * schema footprint, and a revert that actually removes them is worth more
   * than a revert that refuses to do anything. Re-running `up()` afterwards is
   * safe — every statement is `IF NOT EXISTS`, and the labels being already
   * present is exactly the case that guards.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "member_preferences" DROP COLUMN IF EXISTS "login_alerts_enabled"`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "last_seen_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "device_label"`,
    );
  }
}
