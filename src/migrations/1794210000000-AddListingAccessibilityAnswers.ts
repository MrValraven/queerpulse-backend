import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `listings.accessibility_answers` + `listings.accessibility_note`:
 * accessibility as a real three-state answer set.
 *
 * Accessibility lived in `good_for`, a flat `text[]` of amenity tags that put
 * "Wheelchair accessible" next to "Dog-friendly" and "Budget-friendly", and
 * every stored tag rendered as a positive check. That shape can only say yes.
 * A member could learn that a place CLAIMS a step-free entrance; they could
 * never learn that it does not have one, because a missing tag meant either
 * "no" or "nobody ever asked" and nothing distinguished the two. You cannot
 * plan an evening around that. An unanswered question and a "no" have to be
 * different answers, and both have to be sayable.
 *
 * Each of the six canonical questions
 * (`LISTING_ACCESSIBILITY_QUESTION_SLUGS` in `listings/listing-accessibility.ts`)
 * is answered `yes`, `no` or `unknown`. `unknown` is the DEFAULT and is stored
 * explicitly, never as an absent key, so it survives every round trip and
 * reaches the wire as its own value. `accessibility_note` carries the honesty
 * the six answers cannot hold ("two steps at the door, ring the bell and staff
 * will bring the ramp").
 *
 * Backfill, in two steps:
 *
 *  1. Every accessibility-flavoured tag a listing already carried becomes a
 *     `yes` answer for the question it was really answering:
 *       'Step-free entrance'      -> step-free-entrance
 *       'Wheelchair accessible'   -> wheelchair-accessible-interior
 *       'Accessible bathroom'     -> accessible-toilet
 *       'Gender-neutral toilets'  -> gender-neutral-toilet
 *       'Quiet, low-sensory hours'-> quiet-hours
 *     Everything else stays `unknown`. `assistance-animals-welcome` takes NO
 *     backfill from any tag: 'Dog-friendly' is a pets policy, and a venue that
 *     turns dogs away must still welcome an assistance animal while a venue
 *     that welcomes dogs has said nothing about whether its staff know that.
 *     Reading one as the other would put a fabricated `yes` in front of exactly
 *     the person who depends on the real answer.
 *
 *  2. Those same five tags are REMOVED from `good_for`, so an access claim
 *     stops being rendered twice (once as a structured answer, once as a
 *     generic amenity check). The atmosphere tags 'Walk-ins welcome',
 *     'Solo-friendly', 'Dog-friendly', 'Hosts community events' and
 *     'Budget-friendly' stay exactly where they are, which is what `good_for`
 *     is genuinely good at.
 *
 * Fully transactional. Two `ADD COLUMN`s with constant defaults (catalog-only
 * on PostgreSQL 11+, no table rewrite) plus two `UPDATE`s over a table with a
 * few thousand rows at most.
 *
 * DO NOT RUN: authored for review only, the maintainer runs migrations.
 */
export class AddListingAccessibilityAnswers1794210000000 implements MigrationInterface {
  name = 'AddListingAccessibilityAnswers1794210000000';

  /** Every question answered `unknown` — the column default, and the base the
   * backfill below builds each row's real answers on top of. */
  private static readonly ALL_UNKNOWN_ANSWERS = JSON.stringify({
    'step-free-entrance': 'unknown',
    'wheelchair-accessible-interior': 'unknown',
    'accessible-toilet': 'unknown',
    'gender-neutral-toilet': 'unknown',
    'quiet-hours': 'unknown',
    'assistance-animals-welcome': 'unknown',
  });

  /** The old `good_for` tags that were really accessibility claims. Removed
   * from the array in step 2 above, having become answers in step 1. */
  private static readonly LEGACY_ACCESSIBILITY_TAGS = [
    'Step-free entrance',
    'Wheelchair accessible',
    'Accessible bathroom',
    'Gender-neutral toilets',
    'Quiet, low-sensory hours',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    const allUnknown =
      AddListingAccessibilityAnswers1794210000000.ALL_UNKNOWN_ANSWERS;
    const legacyTags =
      AddListingAccessibilityAnswers1794210000000.LEGACY_ACCESSIBILITY_TAGS;

    await queryRunner.query(
      `ALTER TABLE "listings"
         ADD "accessibility_answers" jsonb NOT NULL DEFAULT '${allUnknown}',
         ADD "accessibility_note" text NOT NULL DEFAULT ''`,
    );

    // Step 1: the accessibility-flavoured tags a row already carried become
    // `yes` answers. Every other question lands `unknown`, which is a truthful
    // "we have not been told" rather than a denial nobody made.
    await queryRunner.query(
      `UPDATE "listings" SET "accessibility_answers" = jsonb_build_object(
         'step-free-entrance',
           CASE WHEN 'Step-free entrance' = ANY("good_for") THEN 'yes' ELSE 'unknown' END,
         'wheelchair-accessible-interior',
           CASE WHEN 'Wheelchair accessible' = ANY("good_for") THEN 'yes' ELSE 'unknown' END,
         'accessible-toilet',
           CASE WHEN 'Accessible bathroom' = ANY("good_for") THEN 'yes' ELSE 'unknown' END,
         'gender-neutral-toilet',
           CASE WHEN 'Gender-neutral toilets' = ANY("good_for") THEN 'yes' ELSE 'unknown' END,
         'quiet-hours',
           CASE WHEN 'Quiet, low-sensory hours' = ANY("good_for") THEN 'yes' ELSE 'unknown' END,
         'assistance-animals-welcome', 'unknown'
       )`,
    );

    // Step 2: strip those five tags out of `good_for` so they stop rendering a
    // second time. Guarded by the overlap operator so only rows that actually
    // carry one are rewritten.
    await queryRunner.query(
      `UPDATE "listings"
         SET "good_for" = ARRAY(
           SELECT tag FROM unnest("good_for") AS tag
           WHERE tag <> ALL ($1::text[])
         )
       WHERE "good_for" && $1::text[]`,
      [legacyTags],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Puts the five accessibility tags back on any listing that answered the
    // matching question `yes`, so a revert leaves `good_for` reading the way it
    // did before, then drops the columns.
    //
    // A `no` answer is NOT representable in `good_for` and is simply lost on
    // revert. That is the whole reason these columns exist, and there is no
    // honest place to put a "no" in a list of positive claims.
    await queryRunner.query(
      `UPDATE "listings" SET "good_for" = ARRAY(
         SELECT DISTINCT tag FROM unnest(
           "good_for" || ARRAY(
             SELECT recovered.tag FROM (VALUES
               ('step-free-entrance', 'Step-free entrance'),
               ('wheelchair-accessible-interior', 'Wheelchair accessible'),
               ('accessible-toilet', 'Accessible bathroom'),
               ('gender-neutral-toilet', 'Gender-neutral toilets'),
               ('quiet-hours', 'Quiet, low-sensory hours')
             ) AS recovered(slug, tag)
             WHERE "accessibility_answers" ->> recovered.slug = 'yes'
           )
         ) AS tag
       )`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings"
         DROP COLUMN "accessibility_note",
         DROP COLUMN "accessibility_answers"`,
    );
  }
}
