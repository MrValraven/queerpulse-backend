// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `magazine_piece_message` value to `notifications_type_enum`
 * (Magazine Desk Phase 7, Task F1): the "someone messaged you about this
 * piece" alert `MagazinePieceService.postPieceMessage` fires at the OTHER
 * party (editor → writer, or writer → editor) through the app's normal
 * `NotificationsService.create` path — no separate magazine-only mechanism.
 * Mirrors `AddForumReplyNotificationType`.
 *
 * UNAPPLIED — the maintainer runs `pnpm run migration:run`.
 */
export class AddMagazinePieceMessageNotificationType1787300100000 implements MigrationInterface {
  name = 'AddMagazinePieceMessageNotificationType1787300100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Additive + idempotent. On PG 12+ ADD VALUE runs inside the migration
    // transaction because the new value is not USED in this same transaction.
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'magazine_piece_message'`,
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
