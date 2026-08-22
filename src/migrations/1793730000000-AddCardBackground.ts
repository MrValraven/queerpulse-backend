// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets a community's card carry a ground of its own: one of the curated flag
 * presets, or a photo it uploads.
 *
 * Two nullable columns rather than one polymorphic pair, because they answer
 * different questions and only one can win. `background_preset` is a NAME from
 * a closed list the API validates (same discipline as `accent_token`: a
 * community may never post a raw colour). `background_media_key` is a raw
 * storage key resolved through `toImageUrl` at the response boundary, matching
 * `crest_media_key` directly above it.
 *
 * Both null (the default, and the state every existing row starts in) means
 * the card keeps painting its `skin` colour, so this migration cannot change
 * how any card that already exists looks. `varchar(512)` on the key matches
 * the DTO's `@MaxLength(512)` and the crest column's own bound.
 */
export class AddCardBackground1793730000000 implements MigrationInterface {
  name = 'AddCardBackground1793730000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_cards" ADD "background_preset" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_cards" ADD "background_media_key" character varying(512)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_cards" DROP COLUMN "background_media_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_cards" DROP COLUMN "background_preset"`,
    );
  }
}
