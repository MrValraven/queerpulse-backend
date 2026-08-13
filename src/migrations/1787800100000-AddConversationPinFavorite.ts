import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds per-participant PIN and FAVORITE preferences to `conversation_participants`,
 * mirroring the existing per-participant `muted` flag. Both are nullable
 * `timestamptz` watermarks (NULL = not pinned / not favorited) so pins sort
 * deterministically and they match the other watermark columns on the row.
 *
 * Nullable with no default, so they apply cleanly to existing rows: every
 * current participant lands unpinned and unfavorited. The 3-pins-per-user cap is
 * enforced in application code (`ConversationsService.setPinned`), not the schema.
 */
export class AddConversationPinFavorite1787800100000 implements MigrationInterface {
  name = 'AddConversationPinFavorite1787800100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation_participants" ADD "pinned_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_participants" ADD "favorited_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation_participants" DROP COLUMN "favorited_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_participants" DROP COLUMN "pinned_at"`,
    );
  }
}
