// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `'card_program_enabled'` and `'card_program_disabled'` to
 * `community_governance_log_action_enum`.
 *
 * `CardProgramsService.upsert` (`src/membership-cards/card-programs.service.ts`)
 * calls `CommunityGovernanceLogService.log()` when an owner/mod turns a
 * community's membership-card programme on or off. `action` is a Postgres
 * enum column (`community_governance_log_action_enum`), so the new values
 * used by `GovernanceLogAction.CardProgramEnabled`/`CardProgramDisabled`
 * (`src/communities/entities/community-governance-log.entity.ts`) must exist
 * in the type before any row can be written with them.
 */
export class AddCommunityGovernanceCardProgramActions1793660000000 implements MigrationInterface {
  name = 'AddCommunityGovernanceCardProgramActions1793660000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Additive + idempotent. On PG 12+ ADD VALUE runs inside the migration
    // transaction because the new value is not USED in this same transaction
    // (mirrors 1793520200000-AddCommunityGovernanceSettingsChangedAction).
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'card_program_enabled'`,
    );
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'card_program_disabled'`,
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
