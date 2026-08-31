import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `community_governance_log_action_enum` value behind replacing a
 * lost or stolen physical card: `card_replaced`.
 *
 * Every other act an issuer can perform on a card (revoke, suspend,
 * reinstate) already lands in the governance log. Replacing one is the same
 * kind of act against the same member, so leaving it unlogged would make it
 * the single card action invisible to a community's own history.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, exactly like the other `ADD VALUE`
 * migrations (e.g. `AddBarterProposalReceivedNotificationType`):
 * `ALTER TYPE ... ADD VALUE` must be COMMITTED before any statement may use
 * the new label, so this opts out of the wrapping transaction
 * (`transaction = false`, honoured because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`). `IF NOT EXISTS` keeps it re-run-safe.
 *
 * Kept separate from and later than `AddMembershipCardCodeVersion` because
 * that one is safely transactional and this one must not be.
 */
export class AddCardReplacedGovernanceAction1793770000000 implements MigrationInterface {
  name = 'AddCardReplacedGovernanceAction1793770000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'card_replaced'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value; the added label is
    // harmless. Fails loudly rather than reporting a successful revert that
    // undid nothing, which would drop the ledger row and make the next
    // `migration:run` error on a label that is still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
