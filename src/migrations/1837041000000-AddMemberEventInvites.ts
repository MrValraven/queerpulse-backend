// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Member-sent event invites: three new invite statuses, an invite `source`
 * column, an (event, inviter) index for the inviter's own list, and the three
 * notification labels. No statement uses a new label, so the default
 * migration transaction stays.
 */
export class AddMemberEventInvites1837041000000 implements MigrationInterface {
  name = 'AddMemberEventInvites1837041000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const label of ['awaiting_host', 'withdrawn', 'host_declined']) {
      await queryRunner.query(
        `ALTER TYPE "event_invites_status_enum" ADD VALUE IF NOT EXISTS '${label}'`,
      );
    }
    await queryRunner.query(
      `CREATE TYPE "event_invites_source_enum" AS ENUM ('host', 'member')`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_invites" ADD "source" "event_invites_source_enum" NOT NULL DEFAULT 'host'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_event_invites_event_inviter" ON "event_invites" ("event_id", "inviter_id")`,
    );
    for (const label of [
      'event_invite_request',
      'event_invite_request_declined',
      'event_invite_accepted',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS '${label}'`,
      );
    }
  }

  public async down(): Promise<void> {
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
