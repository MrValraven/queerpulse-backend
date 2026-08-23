// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Which legibility treatment a card's flag or photo ground carries behind the
 * card's own text: `'shade'`, `'panel'`, or `'veil'`.
 *
 * A ground is arbitrary artwork, so it cannot inherit the contrast guarantee
 * the five flat skins are built around, and the front face has always laid a
 * fixed top-and-bottom gradient over it. That gradient is the right answer for
 * a striped flag and the wrong one for a busy illustration, where the detail
 * competing with the holder's name sits in the middle of the card rather than
 * at its edges. This column lets the ISSUING community pick the treatment that
 * suits the artwork it chose.
 *
 * It is not a switch for turning protection off: every value protects the
 * text, because a card that cannot be read at a door is not a card. Stored as
 * a varchar against a closed list validated in the DTO, the same shape
 * `photo_style` and `background_preset` use, so a fourth treatment ships
 * without an enum ALTER.
 *
 * Defaults to `'shade'` and is NOT NULL, so every card already in someone's
 * wallet keeps exactly the face it has today.
 */
export class AddCardTextBackdrop1793790000000 implements MigrationInterface {
  name = 'AddCardTextBackdrop1793790000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_cards" ADD "text_backdrop" character varying(16) NOT NULL DEFAULT 'shade'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_cards" DROP COLUMN "text_backdrop"`,
    );
  }
}
