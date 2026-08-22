import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `'settings_changed'` to `community_governance_log_action_enum`.
 *
 * `PATCH /communities/:slug` can change a community's `accessTier` — the most
 * consequential setting it has (private to public exposes the roster and every
 * post) — plus its name, purpose, rules and roster visibility, and none of it
 * left a trace: `CommunitiesService.update` was the only mutating community
 * route with no `CommunityGovernanceLogService.log` call at all (BE-COM-22).
 * Every neighbouring action (role change, removal, transfer, archive,
 * freeze/unfreeze) already logs.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddCommunityGovernanceSettingsChangedAction1793520200000 implements MigrationInterface {
  name = 'AddCommunityGovernanceSettingsChangedAction1793520200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Additive + idempotent. On PG 12+ ADD VALUE runs inside the migration
    // transaction because the new value is not USED in this same transaction
    // (mirrors 1792700000000-AddCommunityGovernanceUnarchivedAction).
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'settings_changed'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres has no DROP VALUE — rebuilding the enum without this value is
    // a manual revert path (would fail if any row still uses it). No-op here.
    // Fails loudly rather than reporting a successful revert that undid
    // nothing: a silent no-op removes the row from the migrations ledger, so
    // the next `migration:run` retries `ADD VALUE` and errors on the label
    // that is still there. Postgres has no `ALTER TYPE ... DROP VALUE`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
