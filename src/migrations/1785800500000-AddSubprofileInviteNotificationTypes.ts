import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the two `notifications_type_enum` values that back co-owned-subprofile
 * notifications (SDD 2026-08-03 "shared co-owned subprofiles", Task 5):
 * `subprofile_invite` (sent to an invitee when a co-owner invites them onto a
 * persona) and `subprofile_co_owner_joined` (sent to the other current
 * co-owners when that invite is accepted).
 *
 * Mirrors `AddMissingNotificationTypes1785004000000` exactly: each value is
 * only ADDED and never USED in this same transaction, so
 * `ALTER TYPE ... ADD VALUE` is safe inside the migration transaction on
 * PostgreSQL 12+. `IF NOT EXISTS` keeps it re-run-safe. `down()` is a
 * documented no-op — Postgres has no `ALTER TYPE ... DROP VALUE`.
 */
export class AddSubprofileInviteNotificationTypes1785800500000 implements MigrationInterface {
  name = 'AddSubprofileInviteNotificationTypes1785800500000';

  private static readonly VALUES = [
    'subprofile_invite',
    'subprofile_co_owner_joined',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const value of AddSubprofileInviteNotificationTypes1785800500000.VALUES) {
      await queryRunner.query(
        `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value; the added values are harmless
    // if left in place.
    // Fails loudly rather than reporting a successful revert that undid
    // nothing: a silent no-op removes the row from the migrations ledger, so
    // the next `migration:run` retries `ADD VALUE` and errors on the label
    // that is still there. Postgres has no `ALTER TYPE ... DROP VALUE`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
