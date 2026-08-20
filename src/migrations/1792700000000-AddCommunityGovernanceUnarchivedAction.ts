import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `'unarchived'` to `community_governance_log_action_enum` — COM-18:
 * admins can now reverse `AdminCommunitiesService.archive` via a new
 * `unarchive` action (`POST /admin/communities/:slug/unarchive`), and that
 * action needs its own audit-trail entry, symmetric with the existing
 * `archived`/`frozen`/`unfrozen` values.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddCommunityGovernanceUnarchivedAction1792700000000 implements MigrationInterface {
  name = 'AddCommunityGovernanceUnarchivedAction1792700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Additive + idempotent. On PG 12+ ADD VALUE runs inside the migration
    // transaction because the new value is not USED in this same transaction
    // (mirrors 1785000500000-AddMentionNotificationType).
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'unarchived'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres has no DROP VALUE — rebuilding the enum without this value is
    // a manual revert path (would fail if any row still uses it). No-op here.
  }
}
