// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `event_community_invite` and `event_community_invite_response`, the two
 * `notifications_type_enum` values behind guest communities (2026-10-08).
 *
 * `event_community_invite` reaches every owner, co-owner and mod of the
 * invited community; its payload names the gathering, the guest community
 * and, when the lead is not private, the lead community. The inviter rides as
 * the actor. `event_community_invite_response` reaches the gathering's
 * organisers when the guest's team accepts or declines, with the responder as
 * the actor. Both are in-app only: neither is in `PushNotificationListener`'s
 * whitelist.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, like every other `ADD VALUE` migration here:
 * a new label must be COMMITTED before any statement may use it, so this opts
 * out of the wrapping transaction (`transaction = false`, honoured because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). Nothing in this
 * file uses either label.
 */
export class AddEventCommunityNotificationTypes1831300100000 implements MigrationInterface {
  name = 'AddEventCommunityNotificationTypes1831300100000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'event_community_invite'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'event_community_invite_response'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value, and the added labels
    // are inert once nothing writes them. Fails loudly so the ledger row stays.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
