// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lineup invites (2026-10-06): `event_lineup_invite` reaches the invited
 * member; `event_lineup_accepted` and `event_lineup_declined` reach the
 * organizer who sent it. ADD VALUE only, and the new values go unused in the same transaction,
 * the same shape as `AddEventCohostInviteNotificationType1790500000000`.
 */
export class AddLineupNotificationTypes1830100100000 implements MigrationInterface {
  name = 'AddLineupNotificationTypes1830100100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'event_lineup_invite'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'event_lineup_accepted'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'event_lineup_declined'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres has no `ALTER TYPE ... DROP VALUE`. Failing loudly keeps the
    // migrations ledger honest, as in the cohost invite migration.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
