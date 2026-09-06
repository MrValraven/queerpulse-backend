import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the 'document' message kind (PRD-226) so a message can carry a
 * member-uploaded document attachment (a lease PDF, a flyer, a spreadsheet, a
 * plain-text file — never video/audio/voice, which stays out of scope),
 * reusing the existing `attachment` jsonb column
 * `AddGifMessages1785001800000` already added — no new column needed, the
 * column's `GifAttachment | DocumentAttachment` TypeScript union now also
 * covers a document (`url`/`fileName`/`byteSize`/`contentType`/`provider`).
 * Additive: existing rows are untouched. `ADD VALUE` is idempotent and, on PG
 * 12+, transaction-legal because 'document' is not USED in this migration
 * (mirrors `AddImageMessages1792100000000` exactly).
 */
export class AddDocumentMessages1815000000000 implements MigrationInterface {
  name = 'AddDocumentMessages1815000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "messages_kind_enum" ADD VALUE IF NOT EXISTS 'document'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot drop a single enum value; leaving 'document' is
    // harmless — mirrors AddImageMessages1792100000000's down() (nothing to
    // reverse here since this migration adds no column, only the enum
    // value). Fails loudly rather than reporting a successful revert that
    // undid nothing: a silent no-op removes the row from the migrations
    // ledger, so the next `migration:run` retries `ADD VALUE` and errors on
    // the label that is still there. Postgres has no `ALTER TYPE ... DROP
    // VALUE`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
