// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the two `community_governance_log_action_enum` values a moderator
 * takedown of member content writes (PRD-147).
 *
 * - `post_removed`: written by `CommunityPostsService.deletePost` when an
 *   owner, co-owner or moderator tombstones somebody ELSE'S post.
 * - `reply_removed`: written by `CommunityPostsService.deleteReply` for the
 *   same act against a reply.
 *
 * An author deleting their own content writes neither. There is no governance
 * decision in a member deleting their own words, and a log full of them would
 * bury the decisions that are.
 *
 * TWO ACTIONS RATHER THAN ONE WITH A FLAG, the distinction `member_banned` vs
 * `member_removed` already draws on this enum: the log is read to answer "what
 * happened in this room", and "they removed a whole post" and "they removed a
 * reply inside somebody else's thread" are different answers.
 *
 * The entry records who acted (`actor_user_id`), whose content it was
 * (`target_user_id`, the author) and, in `metadata`, the post or reply id, the
 * member-facing reason, the moderator-only internal note and the snapshotted
 * house rule that was cited. `community-governance-history-response.ts` reads
 * those keys through its allowlist, so the community's own owner/co-owners and
 * moderators can read the record of their own decisions.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, for the same reason as
 * `AddCommunityBanGovernanceLogActions1793950000000`: `ALTER TYPE ... ADD
 * VALUE` has to be COMMITTED before any statement may use the new label, so
 * this opts out of the wrapping transaction (`transaction = false`, honoured
 * because `data-source.ts` sets `migrationsTransactionMode: 'each'`). Nothing
 * in this file uses either label, and `IF NOT EXISTS` keeps it re-run-safe.
 */
export class AddCommunityContentTakedownGovernanceActions1799020000000 implements MigrationInterface {
  name = 'AddCommunityContentTakedownGovernanceActions1799020000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'post_removed'`,
    );
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'reply_removed'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value, and the added labels
    // are inert once nothing writes them. Fails loudly rather than reporting a
    // successful revert that undid nothing, since a silent no-op removes the
    // ledger row and the next `migration:run` retries `ADD VALUE` against
    // labels that are still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
