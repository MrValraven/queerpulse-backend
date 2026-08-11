// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `notifications_type_enum` value backing co-owner *removal*
 * notifications: `subprofile_member_removed`, sent to the one co-owner a
 * persona's CREATOR evicts (`SubprofilesService.removeMember` →
 * `SUBPROFILE_MEMBER_REMOVED` → `NotificationsListener.onSubprofileMemberRemoved`).
 * Before this, a creator kick emitted nothing — the removed member silently lost
 * the persona from their dashboard with no notice. Companion to
 * `AddSubprofileDeletedNotificationType1787700000000`.
 *
 * TWO-PHASE / NON-TRANSACTIONAL. `ALTER TYPE ... ADD VALUE` is committed on its
 * own here — the migration opts out of the wrapping transaction
 * (`transaction = false`, honored because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`), for the same reason the other
 * enum-value migrations do: an enum value must be COMMITTED before any statement
 * may USE it, so adding and using it in one transaction is unsafe. Keeping the
 * ADD VALUE in its own committed step means the code that writes
 * `subprofile_member_removed` notification rows (a separate deploy) always sees
 * a durable enum label. `IF NOT EXISTS` keeps the step re-run-safe. Run alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 *
 * `down()` is a documented no-op — Postgres has no `ALTER TYPE ... DROP VALUE`;
 * the added label is harmless if left in place.
 *
 * UNAPPLIED — the maintainer runs `pnpm run migration:run`.
 */
export class AddSubprofileMemberRemovedNotificationType1787700100000
  implements MigrationInterface
{
  name = 'AddSubprofileMemberRemovedNotificationType1787700100000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'subprofile_member_removed'`,
    );
  }

  public async down(): Promise<void> {
    // No-op: Postgres cannot drop an enum value; the added value is harmless if
    // left in place.
  }
}
