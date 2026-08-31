import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The two `community_governance_log_action_enum` values behind an offer of
 * support (OPS-05): `support_offered` when platform staff offer a struggling
 * community a hand, and `support_offer_answered` when the community takes it
 * up or says it is not needed.
 *
 * Every other act platform staff take against a community already lands in
 * that log. "Who from the platform turned up, and what did we say back" is
 * exactly the kind of question a community's own history has to be able to
 * answer later, so leaving this pair out would make the one supportive act
 * the only invisible one.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, exactly like the other `ADD VALUE`
 * migrations here (e.g. `AddCardReplacedGovernanceAction1793770000000`):
 * `ALTER TYPE ... ADD VALUE` must be COMMITTED before any statement may use
 * the new label, so this opts out of the wrapping transaction
 * (`transaction = false`, honoured because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`). `IF NOT EXISTS` keeps it re-run-safe.
 *
 * Kept separate from and later than `CreateCommunitySupportOffers`, which is
 * safely transactional and must stay that way.
 */
export class AddCommunitySupportGovernanceActions1795660100000 implements MigrationInterface {
  name = 'AddCommunitySupportGovernanceActions1795660100000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'support_offered'`,
    );
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'support_offer_answered'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value, and the added labels
    // are inert once nothing writes them (the write sites revert with the
    // code, not with the schema). Fails loudly rather than reporting a
    // successful revert that undid nothing, which would drop the ledger row
    // and make the next `migration:run` error on labels that are still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
