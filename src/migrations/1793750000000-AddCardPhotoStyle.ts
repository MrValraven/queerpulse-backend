// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * How a photo card prints the faces it carries: `'color'` or `'mono'`.
 *
 * Stored as a varchar against a closed list validated in the DTO, the same
 * shape `community_cards.background_preset` uses. A two-value Postgres enum
 * would read more strictly and would have to be ALTERed the first time a
 * third style ships, which is a heavier migration than this column is worth.
 *
 * Defaults to `'color'` and is NOT NULL, so every programme that already
 * prints photos keeps printing exactly the photo its members uploaded. The
 * setting belongs to the ISSUING community, which is why it lives here rather
 * than on `membership_cards`; the member's own control over their face stays
 * the veto in `membership_cards.is_photo_hidden`.
 */
export class AddCardPhotoStyle1793750000000 implements MigrationInterface {
  name = 'AddCardPhotoStyle1793750000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_cards" ADD "photo_style" character varying(16) NOT NULL DEFAULT 'color'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_cards" DROP COLUMN "photo_style"`,
    );
  }
}
