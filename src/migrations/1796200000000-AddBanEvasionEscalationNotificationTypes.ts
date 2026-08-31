// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `ban_evasion_escalation_raised` and `ban_evasion_escalation_resolved`, the two
 * `notifications_type_enum` values that close the notification loop on a
 * ban-evasion escalation (PRD-31).
 *
 * The gap they close. A community's owner, co-owners and moderators see one bit
 * about a join-request applicant (`CommunityBanEvasionFlagDTO`) and can hand the
 * wider question to platform staff in one click. Until now that escalation
 * appeared on `GET /admin/ban-evasion/escalations` and pinged nobody, so it was
 * found only if a staff member happened to open the queue; and when staff closed
 * it, the moderator who asked was never told. Somebody is standing at a door
 * while that round trip happens.
 *
 * `ban_evasion_escalation_raised` goes to PLATFORM STAFF (`users.role` of
 * `moderator` or `admin`, the roles `BanEvasionController` is already guarded
 * by), written by `BanEvasionNotificationsListener`. Its payload carries the
 * escalation id and the community's slug and name, and NOTHING about the
 * applicant: no id, no name, no assessment, no tier, no score. Staff read all of
 * that on `/admin/ban-evasion`, one click away and behind that console's own
 * authentication.
 *
 * `ban_evasion_escalation_resolved` goes to the ONE moderator who raised it. It
 * carries that the case was closed and nothing else: no `resolutionNote`, no
 * resolving staff member, no timestamp of the resolution, no part of the
 * assessment. What staff found is a cross-community judgement, and this
 * recipient is precisely the person the one-bit design exists to withhold it
 * from.
 *
 * Both are unmutable (`ALWAYS_DELIVERED_NOTIFICATION_TYPES`) and IN-APP ONLY:
 * neither is in `PushNotificationListener`'s push whitelist, so quiet hours,
 * which gate the push channel, never come into it. QueerPulse sends no email and
 * never will, so no copy for either type may say anything is on its way.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, like every other `ADD VALUE` migration here
 * (e.g. `AddEventNearlyFullNotificationType1796020000000`): a new label must be
 * COMMITTED before any statement may use it, so this opts out of the wrapping
 * transaction (`transaction = false`, honoured because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`). Nothing in this file uses either label.
 */
export class AddBanEvasionEscalationNotificationTypes1796200000000 implements MigrationInterface {
  name = 'AddBanEvasionEscalationNotificationTypes1796200000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'ban_evasion_escalation_raised'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'ban_evasion_escalation_resolved'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value, and the added labels
    // are inert once nothing writes them. Fails loudly rather than reporting a
    // successful revert that undid nothing, which would drop the ledger row and
    // make the next `migration:run` error on labels that are still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
