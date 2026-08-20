import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the 'image' message kind (MSG-8) so a message can carry a member-
 * uploaded image attachment, reusing the existing `attachment` jsonb column
 * `AddGifMessages1785001800000` already added — no new column needed, the
 * same `GifAttachment` shape (url/previewUrl/width/height/provider) now also
 * carries an uploaded photo (`provider: 'upload'`). Additive: existing rows
 * are untouched. `ADD VALUE` is idempotent and, on PG 12+, transaction-legal
 * because 'image' is not USED in this migration (mirrors
 * `AddGifMessages1785001800000` exactly).
 */
export class AddImageMessages1792100000000 implements MigrationInterface {
  name = 'AddImageMessages1792100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "messages_kind_enum" ADD VALUE IF NOT EXISTS 'image'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot drop a single enum value; leaving 'image' is harmless —
    // mirrors AddGifMessages1785001800000's down() (nothing to reverse here
    // since this migration adds no column, only the enum value).
  }
}
