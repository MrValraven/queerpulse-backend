import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `'card_revoked'`, `'card_suspended'`, and `'card_reinstated'` to
 * `community_governance_log_action_enum`.
 *
 * `MembershipCardsService.setStatus`
 * (`src/membership-cards/membership-cards.service.ts`) calls
 * `CommunityGovernanceLogService.log()` when an owner/mod suspends, revokes,
 * or reinstates one member's card. `action` is a Postgres enum column
 * (`community_governance_log_action_enum`), so the new values used by
 * `GovernanceLogAction.CardRevoked`/`CardSuspended`/`CardReinstated`
 * (`src/communities/entities/community-governance-log.entity.ts`) must exist
 * in the type before any row can be written with them.
 */
export class AddCommunityGovernanceCardActions1793670000000 implements MigrationInterface {
  name = 'AddCommunityGovernanceCardActions1793670000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Additive + idempotent. On PG 12+ ADD VALUE runs inside the migration
    // transaction because the new value is not USED in this same transaction
    // (mirrors 1793660000000-AddCommunityGovernanceCardProgramActions).
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'card_revoked'`,
    );
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'card_suspended'`,
    );
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'card_reinstated'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres has no DROP VALUE — rebuilding the enum without these values
    // is a manual revert path (would fail if any row still uses them).
    // Fails loudly rather than reporting a successful revert that undid
    // nothing: a silent no-op removes the row from the migrations ledger, so
    // the next `migration:run` retries `ADD VALUE` and errors on the label
    // that is still there. Postgres has no `ALTER TYPE ... DROP VALUE`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
