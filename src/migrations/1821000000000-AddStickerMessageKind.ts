// DO NOT RUN. This migration has not been applied to any environment yet.
// Remove this banner in the same change that applies it.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the 'sticker' message kind so a message can carry a published sticker
 * from an admin-built pack, reusing the existing `attachment` jsonb column
 * (the stored shape is a third member of that column's TypeScript union,
 * discriminated by `provider === 'sticker'`).
 *
 * Alone in its own file, ahead of `CreateStickerPacks1821100000000`, because
 * `ALTER TYPE ... ADD VALUE` cannot be followed by a statement that USES the
 * new label inside the same transaction and `data-source.ts` runs migrations
 * with `migrationsTransactionMode: 'each'`. Splitting the label out is the
 * same shape `AddDocumentMessages1815000000000` used.
 */
export class AddStickerMessageKind1821000000000 implements MigrationInterface {
  name = 'AddStickerMessageKind1821000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "messages_kind_enum" ADD VALUE IF NOT EXISTS 'sticker'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres has no `ALTER TYPE ... DROP VALUE`. Fail loudly rather than
    // report a successful revert that undid nothing: a silent no-op removes
    // the row from the migrations ledger, so the next `migration:run` retries
    // `ADD VALUE` against a label that is still there. Mirrors
    // AddDocumentMessages1815000000000's down().
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
