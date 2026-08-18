import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `notifications_type_enum` value backing the community-create
 * "invites" fan-out: `community_invite_received`, sent to each member slug
 * resolved from `CreateCommunityInput.invites` when a community is created
 * (`CommunitiesService.notifyInvitees`). Closes the gap where an invite
 * accepted by the founding flow was silently discarded — not a roster add
 * (see `seedExtraRoster`'s "no consent-less roster adds" note), purely a
 * "you were invited" notification.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, exactly like the other `ADD VALUE`
 * migrations (e.g. `AddCommunityGovernanceNotificationTypes1790200000000`):
 * `ALTER TYPE ... ADD VALUE` must be COMMITTED before any statement may use
 * the new label, so this opts out of the wrapping transaction
 * (`transaction = false`, honoured because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`). `IF NOT EXISTS` keeps it re-run-safe.
 * `down()` is a no-op: Postgres has no `ALTER TYPE ... DROP VALUE`, and the
 * added label is harmless if left.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddCommunityInviteReceivedNotificationType1790300000000 implements MigrationInterface {
  name = 'AddCommunityInviteReceivedNotificationType1790300000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'community_invite_received'`,
    );
  }

  public async down(): Promise<void> {
    // No-op: Postgres cannot drop an enum value; the added label is harmless.
  }
}
