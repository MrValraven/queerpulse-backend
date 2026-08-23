// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the five `notifications_type_enum` values the Communities build needs:
 *
 * - `community_new_post`: to members whose
 *   `community_members.notification_level` is `all`, when a post lands. The
 *   per-member level IS the consent, so no preference category gates it.
 * - `community_announcement`: to every member above `muted`, when an owner/mod
 *   marks a post as an announcement.
 * - `community_banned`: to the member an owner/mod bans (`community_bans`), so
 *   a removal is never silent. No actor id, so it does not name the moderator.
 * - `community_owner_review_requested`: to platform staff when moderators file
 *   an owner-review request (`community_owner_review_requests`).
 * - `community_resource_added`: to members at level `all`, when an owner/mod
 *   pins a resource to the community's shelf (`community_resources`).
 *
 * TWO-PHASE / NON-TRANSACTIONAL, exactly like the other `ADD VALUE`
 * migrations (e.g. `AddBarterProposalReceivedNotificationType1793720000000`):
 * `ALTER TYPE ... ADD VALUE` must be COMMITTED before any statement may use
 * the new label, so this opts out of the wrapping transaction
 * (`transaction = false`, honoured because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`). `IF NOT EXISTS` keeps it re-run-safe.
 *
 * Depends on the tables these types refer to
 * (`AddCommunityBans1793800000000`, `AddCommunityResources1793840000000`,
 * `AddCommunityOwnerReviewRequests1793930000000`) but touches none of them:
 * kept in its own later-timestamped migration because it must run
 * non-transactionally while those table migrations stay safely transactional.
 */
export class AddCommunityNotificationTypes1793940000000 implements MigrationInterface {
  name = 'AddCommunityNotificationTypes1793940000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'community_new_post'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'community_announcement'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'community_banned'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'community_owner_review_requested'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'community_resource_added'`,
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
