// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The safe-spaces hub's Bar / Club facet (`mapSafeSpaceCategory`) now derives
 * from `cats` and `attributes`, so the retired `tags` column can be dropped.
 * This keeps every live bar and club on its facet across that switch.
 *
 * Touches in-person safe spaces (`safe_space_status` other than `none`,
 * `online = false`) whose `tags` gave Bar or Club under the old rule, with a
 * primary category other than culture, health or grooming. The old rule tested
 * substrings, so "Barrier-free" read as a bar; here "bar", "club" and
 * "nightclub" must be whole words, because this writes real categories. Such
 * a row gains `nightlife` in `cats`, appended so the primary stays first; a
 * row already at the two
 * category cap swaps its second category for it. A former Club with neither
 * club attribute gains `dancefloor`, or `dj-nights` for an out and about
 * listing, where `dancefloor` is never offered.
 *
 * `down` is a no-op: the added values read the same as an owner's own choice,
 * and `tags` is untouched, so the old facet still derives from it.
 */
export class MoveSafeSpaceFacetOffTags1831400000000 implements MigrationInterface {
  name = 'MoveSafeSpaceFacetOffTags1831400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "listings"
      SET "attributes" = array_append(
        "attributes",
        CASE WHEN "mobile" = true THEN 'dj-nights' ELSE 'dancefloor' END
      )
      WHERE "safe_space_status" <> 'none'
        AND "online" = false
        AND lower(coalesce("cats"[1], '')) NOT IN ('culture', 'health', 'grooming')
        AND array_to_string("tags", ' ') ~* '\\m(night)?clubs?\\M'
        AND NOT ("attributes" && ARRAY['dancefloor', 'dj-nights']::text[])
    `);
    await queryRunner.query(`
      UPDATE "listings"
      SET "cats" = CASE
        WHEN cardinality("cats") < 2 THEN array_append("cats", 'nightlife')
        ELSE "cats"[1:1] || ARRAY['nightlife']::text[]
      END
      WHERE "safe_space_status" <> 'none'
        AND "online" = false
        AND lower(coalesce("cats"[1], '')) NOT IN ('culture', 'health', 'grooming')
        AND array_to_string("tags", ' ') ~* '\\m(bars?|(night)?clubs?)\\M'
        AND NOT ('nightlife' = ANY ("cats"))
    `);
  }

  public async down(): Promise<void> {
    // Deliberately a no-op; see the class comment.
  }
}
