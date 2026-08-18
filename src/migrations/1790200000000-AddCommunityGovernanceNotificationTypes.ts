import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the six `notifications_type_enum` values backing the community
 * governance audit sweep: `community_role_changed`, `community_member_removed`,
 * `community_ownership_transferred`, `community_archived`, `community_frozen`,
 * `community_unfrozen`. Enum values only — no emit site is wired yet; that,
 * and the paired `CommunityGovernanceLogService.log()` call sites in
 * `CommunitiesService`, belong to a follow-up task.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, exactly like the other `ADD VALUE`
 * migrations (e.g. `AddRecognitionNotificationTypes1789600000000`): `ALTER
 * TYPE ... ADD VALUE` must be COMMITTED before any statement may use the new
 * label, so this opts out of the wrapping transaction (`transaction = false`,
 * honoured because `data-source.ts` sets `migrationsTransactionMode: 'each'`).
 * `IF NOT EXISTS` keeps it re-run-safe. `down()` is a no-op: Postgres has no
 * `ALTER TYPE ... DROP VALUE`, and the added labels are harmless if left.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddCommunityGovernanceNotificationTypes1790200000000 implements MigrationInterface {
  name = 'AddCommunityGovernanceNotificationTypes1790200000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'community_role_changed'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'community_member_removed'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'community_ownership_transferred'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'community_archived'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'community_frozen'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'community_unfrozen'`,
    );
  }

  public async down(): Promise<void> {
    // No-op: Postgres cannot drop an enum value; the added values are harmless.
  }
}
