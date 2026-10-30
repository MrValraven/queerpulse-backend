// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Meet the team, members: `listing_team_member_invite` (a business invited
 * you to its team) and `listing_team_member_accepted` (a member accepted a
 * team invite from a business you run) join `notifications_type_enum`.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, like every other `ADD VALUE` migration here:
 * a new label must be COMMITTED before any statement may use it, so this opts
 * out of the wrapping transaction (`transaction = false`, honoured because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). Nothing in this
 * file uses any label, and `IF NOT EXISTS` keeps it re-run-safe.
 */
export class AddListingTeamMemberNotificationTypes1838500100000 implements MigrationInterface {
  name = 'AddListingTeamMemberNotificationTypes1838500100000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'listing_team_member_invite'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'listing_team_member_accepted'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot drop an enum value, and the added labels are inert
    // once nothing writes them. Fails loudly so the ledger row stays.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
