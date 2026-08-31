// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-25. The four `community_governance_log_action_enum` values the second
 * signature on a permanent bar writes:
 *
 * - `member_ban_proposed`: somebody asked for a bar to be permanent. Written
 *   alongside the `member_banned` entry the bar itself writes, because the two
 *   are different facts: the member is barred (30 days), and separately a
 *   permanent bar is waiting on somebody.
 * - `member_ban_ratified`: a second owner, co-owner or moderator signed, and
 *   the bar has no end date any more.
 * - `member_ban_declined`: a second one refused. The 30-day bar stands.
 * - `member_ban_hold_expired`: nobody signed inside the window. The 30-day bar
 *   stands.
 *
 * Four actions rather than one with a flag, for the reason `member_banned` vs
 * `member_removed` already gives on this enum: the community's log is read to
 * answer "what happened to this person", and a proposal, a signature, a refusal
 * and a lapse are four different answers.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, exactly as
 * `AddCommunityBanGovernanceLogActions1793950000000` is and for the same
 * reason: `ALTER TYPE ... ADD VALUE` has to be COMMITTED before any statement
 * may use the new label, so this opts out of the wrapping transaction
 * (`transaction = false`, honoured because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`). Nothing in this migration uses the new
 * labels, so the split is between this file and application code rather than
 * inside it. `IF NOT EXISTS` keeps it re-run-safe.
 *
 * Depends on `AddCommunityBanRatification1795850000000` for the table these
 * actions describe, and touches none of it.
 */
export class AddCommunityBanRatificationGovernanceLogActions1795851000000 implements MigrationInterface {
  name = 'AddCommunityBanRatificationGovernanceLogActions1795851000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'member_ban_proposed'`,
    );
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'member_ban_ratified'`,
    );
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'member_ban_declined'`,
    );
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'member_ban_hold_expired'`,
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
