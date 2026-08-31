import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persona families + crafts expansion. Adds the 75 new persona kinds and the 81
 * new content sections to the subprofile enums. Postgres enums are not
 * auto-altered (synchronize is off), so the values are added explicitly —
 * mirroring `AddAstrologerKind1787700300000`.
 *
 * This migration only ADDS values (never using them in the same transaction),
 * so it is safe on PostgreSQL 12+. Plain `ADD VALUE` (no `IF NOT EXISTS`)
 * matches this repo's convention — migrations run exactly once against the
 * ledger, so guards would only hide drift (see CLAUDE.md).
 *
 * Families/skins are a pure function of `kind` (never stored), so there is no
 * family enum. The 10 new per-persona `SkinData` blocks live in the existing
 * freeform `skin_data` jsonb column, so they need no schema change — only the
 * `SkinData` interface on the entity gained the optional fields.
 *
 * `down()` now throws instead of pretending to revert: Postgres has no `ALTER TYPE ... DROP VALUE`,
 * and the added values are harmless if left in place once no rows reference
 * them.
 */

// 75 new kind enum values, in the authored order.
const NEW_KINDS = [
  'comedian',
  'vocalist',
  'burlesque',
  'circus',
  'spoken_word',
  'host',
  'voguer',
  'illustrator',
  'tattoo_artist',
  'animator',
  'comic_artist',
  'game_designer',
  'artist_3d',
  'printmaker',
  'journalist',
  'poet',
  'editor',
  'screenwriter',
  'translator',
  'zinester',
  'academic',
  'ceramicist',
  'jeweler',
  'textile_artist',
  'woodworker',
  'florist',
  'data_scientist',
  'coach',
  'bodyworker',
  'yoga_teacher',
  'nutritionist',
  'doula',
  'personal_trainer',
  'sex_educator',
  'peer_support',
  'baker',
  'barista',
  'brewer',
  'sommelier',
  'caterer',
  'hair_stylist',
  'barber',
  'makeup_artist',
  'nail_artist',
  'esthetician',
  'piercer',
  'fashion_designer',
  'stylist',
  'model',
  'costume_designer',
  'curator',
  'gallerist',
  'art_dealer',
  'archivist',
  'conservator',
  'registrar',
  'exhibition_designer',
  'art_critic',
  'docent',
  'preparator',
  'historian',
  'art_historian',
  'oral_historian',
  'genealogist',
  'heritage',
  'archival_researcher',
  'memory_keeper',
  'organizer',
  'activist',
  'event_producer',
  'promoter',
  'teacher',
  'facilitator',
  'tutor',
  'lecturer',
];

// 81 new section enum values, in the authored order.
const NEW_SECTIONS = [
  'sets',
  'tour',
  'recordings',
  'acts',
  'pieces',
  'hosted',
  'balls',
  'flash',
  'healed',
  'books',
  'strips',
  'games',
  'jams',
  'models',
  'editions',
  'reporting',
  'bylines',
  'poems',
  'edited',
  'scripts',
  'productions',
  'translations',
  'languages',
  'zines',
  'distros',
  'papers',
  'teaching',
  'wares',
  'firings',
  'commissions',
  'builds',
  'arrangements',
  'events',
  'analyses',
  'programmes',
  'treatments',
  'classes',
  'trainings',
  'support',
  'training',
  'resources',
  'groups',
  'bakes',
  'markets',
  'brews',
  'releases',
  'taprooms',
  'lists',
  'pairings',
  'services',
  'cuts',
  'nail_sets',
  'aftercare',
  'piercings',
  'editorials',
  'book',
  'campaigns',
  'sketches',
  'texts',
  'programme',
  'artists',
  'available',
  'advisory',
  'finding_aids',
  'loans',
  'installations',
  'reviews',
  'tours',
  'talks',
  'installs',
  'research',
  'lectures',
  'testimonies',
  'findings',
  'sites',
  'actions',
  'writing',
  'nights',
  'roster',
  'courses',
  'subjects',
];

export class AddPersonaFamiliesAndCrafts1787700400000 implements MigrationInterface {
  name = 'AddPersonaFamiliesAndCrafts1787700400000';

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
    // Not reversible: Postgres cannot drop enum values. Leaving the new kinds/sections
    // in place is harmless once no rows reference them.
    // Fails loudly rather than reporting a successful revert that undid
    // nothing: a silent no-op removes the row from the migrations ledger, so
    // the next `migration:run` retries `ADD VALUE` and errors on the label
    // that is still there. Postgres has no `ALTER TYPE ... DROP VALUE`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
