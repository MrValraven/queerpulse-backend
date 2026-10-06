// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Each retired language tag, paired with the `langs` id it becomes, in the
 * order the ids are appended. The ids are the ones the "list your business"
 * wizard's languages field stores.
 */
const LANGUAGE_TAG_TO_LANG_ID: readonly (readonly [string, string])[] = [
  ['Portuguese spoken', 'Português'],
  ['English spoken', 'English'],
  ['Spanish spoken', 'Español'],
  ['French spoken', 'Français'],
  ['Portuguese Sign Language', 'LGP (sign)'],
];

/**
 * Moves spoken languages out of a listing's `tags` and into `langs`.
 *
 * The wizard asked for languages twice: a "Languages" group in the tag picker
 * and the dedicated `langs` field. The tag group is gone from
 * `LISTING_TAG_GROUPS`, so languages live in `langs` alone. This carries the
 * existing data across in one statement, over only the rows whose `tags`
 * overlap the five language tags:
 *
 *  - `langs` gains the mapped id of every language tag the row carries, in
 *    the order of `LANGUAGE_TAG_TO_LANG_ID`, skipping any id `langs` already
 *    holds. Ids already in `langs` keep their place.
 *  - `tags` loses the five language tags. Every other tag keeps its position
 *    (`unnest ... WITH ORDINALITY`, ordered by the original index).
 *
 * Both assignments read the row as it was before the update, so the mapping
 * sees the original `tags`. Tags are matched exactly: stored tag values are
 * the vocabulary's canonical spellings (`normalizeListingTags`).
 *
 * `updated_at` is left alone, following the earlier listing data rewrites
 * (`AddListingAccessibilityAnswers1794210000000` stripping `good_for`,
 * `RewriteListingHoursToIntervals1785801000000`). The owner changed nothing,
 * and `@UpdateDateColumn` is set by the ORM only, with no database trigger to
 * bump it. `details_confirmed_at` is left alone for the same reason.
 *
 * `down` is a documented no-op: the move is not reversible in any useful
 * sense. Nothing records which `langs` entries arrived from tags and which
 * the owner picked in the languages field, so stripping ids back out would
 * delete real owner answers, and putting the tags back would revive a group
 * the vocabulary no longer offers. After a revert, re-running `up` finds no
 * listing carrying a language tag and updates nothing.
 */
export class MoveLanguageTagsToLangs1828200000000 implements MigrationInterface {
  name = 'MoveLanguageTagsToLangs1828200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const languageTags = LANGUAGE_TAG_TO_LANG_ID.map(
      ([languageTag]) => languageTag,
    );
    const languageIds = LANGUAGE_TAG_TO_LANG_ID.map(
      ([, languageId]) => languageId,
    );

    await queryRunner.query(
      `UPDATE "listings"
         SET "langs" = "listings"."langs" || ARRAY(
               SELECT "mapping"."lang_id"
               FROM unnest($1::text[], $2::text[]) WITH ORDINALITY
                 AS "mapping"("tag", "lang_id", "position")
               WHERE "mapping"."tag" = ANY("listings"."tags")
                 AND "mapping"."lang_id" <> ALL("listings"."langs")
               ORDER BY "mapping"."position"
             ),
             "tags" = ARRAY(
               SELECT "kept"."tag"
               FROM unnest("listings"."tags") WITH ORDINALITY
                 AS "kept"("tag", "position")
               WHERE "kept"."tag" <> ALL($1::text[])
               ORDER BY "kept"."position"
             )
       WHERE "listings"."tags" && $1::text[]`,
      [languageTags, languageIds],
    );
  }

  public async down(): Promise<void> {
    // Intentionally empty. See the class comment for why the move is not
    // reversed.
  }
}
