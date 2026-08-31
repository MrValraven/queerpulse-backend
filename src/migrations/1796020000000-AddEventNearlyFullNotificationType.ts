// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `event_nearly_full`, the `notifications_type_enum` value behind the
 * "last few spots" alert (PRD-18).
 *
 * Written by `EventCapacityAlertsService` to the members holding an unmade
 * decision about a gathering (they saved it, or they said `maybe`) when its
 * last few seats go. Before this, capacity, the waitlist and saved gatherings
 * all existed and none of them ever reached that member; the settings pane even
 * carried a "Last few spots" switch wired to nothing at all.
 *
 * Gated on the `event_capacity` preference category, which is a plain string
 * and therefore needs no migration of its own (see
 * `notification-preferences.ts`). System-driven: no actor id, because a room
 * filling up is nobody's act and naming whoever took the second-to-last seat
 * would let a block between those two swallow the alert.
 *
 * IN-APP PLUS PUSH. QueerPulse sends no email and never will, so no copy for
 * this type may say anything is on its way.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, like every other `ADD VALUE` migration here
 * (e.g. `AddModerationQueueAlertNotificationType1795720200000`): the label must
 * be COMMITTED before any statement may use it, so this opts out of the
 * wrapping transaction (`transaction = false`, honoured because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). Nothing in this
 * file uses the new label, and the column it is sent alongside lands in the
 * separate `AddEventNearlyFullNotifiedAt1796020100000`.
 */
export class AddEventNearlyFullNotificationType1796020000000 implements MigrationInterface {
  name = 'AddEventNearlyFullNotificationType1796020000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'event_nearly_full'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value, and the added label
    // is inert once nothing writes it. Fails loudly rather than reporting a
    // successful revert that undid nothing, which would drop the ledger row and
    // make the next `migration:run` error on a label that is still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
