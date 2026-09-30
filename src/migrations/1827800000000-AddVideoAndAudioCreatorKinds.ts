// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Video and audio creators: adds four persona kinds to `subprofiles_kind_enum`
 * (video_creator, short_form_creator, podcast_producer, radio_host), mirroring
 * `AddQuestPersonaKinds1822000000000`.
 *
 * Every section these kinds use already exists in
 * `subprofile_items_section_enum` (videos, series, campaigns, productions,
 * clients, episodes, appearances), so no section value is added:
 * `ALTER TYPE ... ADD VALUE` errors on a label that is already present.
 *
 * Only ADDs values and never uses them in the same transaction, so it is safe
 * on PostgreSQL 12+.
 */
const NEW_KINDS = [
  'video_creator',
  'short_form_creator',
  'podcast_producer',
  'radio_host',
];

export class AddVideoAndAudioCreatorKinds1827800000000 implements MigrationInterface {
  name = 'AddVideoAndAudioCreatorKinds1827800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const kind of NEW_KINDS) {
      await queryRunner.query(
        `ALTER TYPE "subprofiles_kind_enum" ADD VALUE '${kind}'`,
      );
    }
  }

  public async down(): Promise<void> {
    // Postgres has no `ALTER TYPE ... DROP VALUE`. Failing loudly keeps the
    // migrations ledger honest; a silent no-op would make the next run retry
    // `ADD VALUE` and error on labels that are still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
