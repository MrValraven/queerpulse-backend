// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Quest personas: adds 20 persona kinds and 16 content sections to the
 * subprofile enums. Postgres enums are not auto-altered (synchronize is off),
 * so the values are added explicitly, mirroring
 * `AddPersonaFamiliesAndCrafts1787700400000`.
 *
 * Only ADDs values and never uses them in the same transaction, so it is safe
 * on PostgreSQL 12+. The family (`quest`) is a pure function of `kind` and the
 * `atTheTable` block lives in the existing `skin_data` jsonb, so neither needs
 * a schema change.
 *
 * `game_master`'s two sections are `campaigns` and `sessions`. `campaigns`
 * already exists in `subprofile_items_section_enum` (added by
 * `AddPersonaFamiliesAndCrafts1787700400000` for the organizer/activist/model
 * kinds), so it is reused verbatim and left out of `NEW_SECTIONS` below:
 * `ALTER TYPE ... ADD VALUE` errors on a label that is already present.
 */
const NEW_KINDS = [
  'game_master',
  'ttrpg_designer',
  'board_game_reviewer',
  'game_night_host',
  'larp_organizer',
  'miniature_painter',
  'cartographer',
  'dice_maker',
  'tournament_organizer',
  'actual_play',
  'streamer',
  'speedrunner',
  'modder',
  'cosplayer',
  'prop_maker',
  'puzzle_designer',
  'podcaster',
  'voice_actor',
  'fanfic_writer',
  'game_critic',
];
const NEW_SECTIONS = [
  'sessions',
  'playthroughs',
  'library',
  'larps',
  'minis',
  'maps',
  'dice',
  'results',
  'streams',
  'runs',
  'mods',
  'cons',
  'puzzles',
  'episodes',
  'roles',
  'works',
];

export class AddQuestPersonaKinds1822000000000 implements MigrationInterface {
  name = 'AddQuestPersonaKinds1822000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const kind of NEW_KINDS) {
      await queryRunner.query(
        `ALTER TYPE "subprofiles_kind_enum" ADD VALUE '${kind}'`,
      );
    }
    for (const section of NEW_SECTIONS) {
      await queryRunner.query(
        `ALTER TYPE "subprofile_items_section_enum" ADD VALUE '${section}'`,
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
