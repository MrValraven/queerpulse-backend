// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `community_support_offered` — the `notifications_type_enum` value behind
 * OPS-05.
 *
 * Written by `AdminCommunitySupportService.create` to a community's owner,
 * co-owners and moderators when platform staff offer that community support.
 * Before this, the admin console's "Offer support" button reached nobody at
 * all: it wrote no row, sent no notification, and showed the staff member a
 * success toast anyway.
 *
 * Carries no actor id, so a moderator's personal block of whichever staff
 * member typed the offer cannot swallow it, and the bell reads as the platform
 * speaking. The payload carries the community's own name and slug and nothing
 * else — the staff member's note stays behind the community's own mod-tools
 * authentication, which is where it is read and answered.
 *
 * IN-APP plus web push. QueerPulse sends no email, so no copy for this type
 * anywhere may say anything is on its way.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, like the other `ADD VALUE` migrations here
 * (e.g. `AddCardReplacedGovernanceAction1793770000000`): the label must be
 * COMMITTED before any statement may use it, so this opts out of the wrapping
 * transaction (`transaction = false`, honoured because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`). `IF NOT EXISTS` keeps it re-run-safe.
 */
export class AddCommunitySupportOfferedNotificationType1795660200000 implements MigrationInterface {
  name = 'AddCommunitySupportOfferedNotificationType1795660200000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'community_support_offered'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value, and the added label
    // is inert once nothing writes it (the emit site reverts with the code,
    // not with the schema). Fails loudly rather than reporting a successful
    // revert that undid nothing, which would drop the ledger row and make the
    // next `migration:run` error on a label that is still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
