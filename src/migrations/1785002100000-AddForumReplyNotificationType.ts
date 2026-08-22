import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddForumReplyNotificationType1785002100000 implements MigrationInterface {
  name = 'AddForumReplyNotificationType1785002100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Additive + idempotent. On PG 12+ ADD VALUE runs inside the migration
    // transaction because the new value is not USED in this same transaction.
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'forum_reply'`,
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
