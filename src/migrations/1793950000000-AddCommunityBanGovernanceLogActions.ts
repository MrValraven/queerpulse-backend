import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the two `community_governance_log_action_enum` values the ban
 * lifecycle needs:
 *
 * - `member_banned`: written by `CommunitiesService.removeMember` when the
 *   removal also bars the member's return, which is the default. Kept
 *   distinct from the existing `member_removed` because the two outcomes
 *   differ in whether the person can come back, and a log that recorded them
 *   identically would answer the wrong question later.
 * - `ban_lifted`: written by `CommunityBansService.liftBan` when an owner/mod
 *   lets a barred member back in. Lifting clears the bar and never restores
 *   the roster row, so the member still has to rejoin.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, for the same reason as
 * `AddCommunityNotificationTypes1793940000000`: `ALTER TYPE ... ADD VALUE`
 * has to be COMMITTED before any statement may use the new label, so this
 * opts out of the wrapping transaction (`transaction = false`, honoured
 * because `data-source.ts` sets `migrationsTransactionMode: 'each'`).
 * `IF NOT EXISTS` keeps it re-run-safe.
 *
 * Depends on `AddCommunityBans1793800000000` for the table these actions
 * describe, and touches none of it.
 */
export class AddCommunityBanGovernanceLogActions1793950000000 implements MigrationInterface {
  name = 'AddCommunityBanGovernanceLogActions1793950000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'member_banned'`,
    );
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'ban_lifted'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value; the added labels are
    // harmless. Fails loudly rather than reporting a successful revert that
    // undid nothing, since a silent no-op removes the ledger row and the next
    // `migration:run` retries `ADD VALUE` against labels that are still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
