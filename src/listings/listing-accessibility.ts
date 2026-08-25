/**
 * The canonical accessibility question vocabulary for business listings — the
 * single set of question slugs shared by the frontend's accessibility panel,
 * the listing wizard, and this API. Listings store these slugs verbatim as the
 * keys of `listing.accessibilityAnswers`.
 *
 * Kept here (rather than as an inline literal in the DTO) for exactly the
 * reason `listing-categories.ts` keeps `LISTING_CATEGORY_SLUGS` here: the
 * create/update validation, the write-side normalizer, the response builders
 * and the migration backfill all have to agree on one list, and a vocabulary
 * restated in four places is a vocabulary that will disagree in four places.
 *
 * Why this exists at all: accessibility used to live in `goodFor`, a flat
 * `text[]` of amenity tags that mixed "Wheelchair accessible" in with
 * "Dog-friendly" and "Budget-friendly", and every stored tag rendered as a
 * positive check. A member could learn that a place CLAIMS a step-free
 * entrance. They could never learn that it does not have one, because a
 * missing tag and a deliberate "no" were the same absence. Someone who uses a
 * wheelchair cannot plan an evening around that ambiguity: an unanswered
 * question and a "no" have to be different answers, and both have to be
 * sayable.
 */
export const LISTING_ACCESSIBILITY_QUESTION_SLUGS = [
  'step-free-entrance',
  'wheelchair-accessible-interior',
  'accessible-toilet',
  'gender-neutral-toilet',
  'quiet-hours',
  'assistance-animals-welcome',
] as const;

export type ListingAccessibilityQuestionSlug =
  (typeof LISTING_ACCESSIBILITY_QUESTION_SLUGS)[number];

/**
 * The three answers a venue can give to an accessibility question.
 *
 * `Unknown` is the default and is a REAL stored value, never an absent key: a
 * venue that has not answered is a different fact from a venue that answered
 * "no", and collapsing the two is the bug this whole model exists to fix. The
 * write-side normalizer fills every question slug on every row, so the column
 * always holds a complete map and the wire always carries all six answers.
 */
export enum ListingAccessibilityAnswer {
  Yes = 'yes',
  No = 'no',
  Unknown = 'unknown',
}

/** The complete answer set a listing carries: one answer per question slug. */
export type ListingAccessibilityAnswerMap = Record<
  ListingAccessibilityQuestionSlug,
  ListingAccessibilityAnswer
>;

/** Longest an owner's free-text accessibility note may be. Sized for the
 * honest paragraph the structured answers cannot hold ("two steps at the
 * door, staff will help with the ramp, ring the bell on the left"), and short
 * enough that it stays a note rather than a second description. */
export const MAX_ACCESSIBILITY_NOTE_LENGTH = 500;

/** True when `value` is one of the canonical question slugs. */
export function isListingAccessibilityQuestionSlug(
  value: string,
): value is ListingAccessibilityQuestionSlug {
  return (LISTING_ACCESSIBILITY_QUESTION_SLUGS as readonly string[]).includes(
    value,
  );
}

/** True when `value` is one of the three answers. */
export function isListingAccessibilityAnswer(
  value: unknown,
): value is ListingAccessibilityAnswer {
  return (
    value === ListingAccessibilityAnswer.Yes ||
    value === ListingAccessibilityAnswer.No ||
    value === ListingAccessibilityAnswer.Unknown
  );
}

/**
 * Every question answered `unknown` — the shape a listing starts from, and the
 * base the normalizer merges a caller's partial answers onto.
 *
 * Built fresh on each call rather than shared as a frozen constant, because
 * callers assign into the result.
 */
export function emptyAccessibilityAnswers(): ListingAccessibilityAnswerMap {
  const answers = {} as ListingAccessibilityAnswerMap;
  for (const slug of LISTING_ACCESSIBILITY_QUESTION_SLUGS) {
    answers[slug] = ListingAccessibilityAnswer.Unknown;
  }
  return answers;
}

/**
 * Fills a (possibly partial, possibly stale) stored or submitted answer map up
 * to the complete vocabulary. Unknown keys are dropped and missing ones land
 * as `unknown`, so the column and the wire always hold exactly the six
 * canonical questions whatever a row was written with or a client sent.
 */
export function normalizeAccessibilityAnswers(
  input?: Partial<Record<string, unknown>> | null,
): ListingAccessibilityAnswerMap {
  const answers = emptyAccessibilityAnswers();
  if (!input) return answers;
  for (const slug of LISTING_ACCESSIBILITY_QUESTION_SLUGS) {
    const value = input[slug];
    if (isListingAccessibilityAnswer(value)) {
      answers[slug] = value;
    }
  }
  return answers;
}

/**
 * The accessibility-flavoured entries of the OLD flat `goodFor` amenity
 * vocabulary, mapped to the question each one was really answering `yes` to.
 *
 * This is the map the backfill migration
 * (`1794210000000-AddListingAccessibilityAnswers`) applies, and it is kept in
 * the source tree rather than only in that migration's SQL so the mapping
 * decision stays readable long after the migration has run.
 *
 * The tag keys are the canonical amenity labels the wizard offered
 * (`GOODFOR` in the frontend's `listBusiness.data.ts`). A tag listed here is
 * ALSO removed from `goodFor` by the migration, so it stops being rendered
 * twice: once as a structured accessibility answer and once as a generic
 * amenity check.
 *
 * Deliberately NOT mapped:
 * - "Dog-friendly" is a pets policy, not an access answer. A venue that turns
 *   dogs away must still welcome an assistance animal, and a venue that
 *   welcomes dogs has told us nothing about whether its staff know that.
 *   Reading one as the other would put a fabricated `yes` in front of someone
 *   who depends on the real answer, so `assistance-animals-welcome` takes no
 *   backfill from any tag and starts at `unknown` on every existing row.
 * - "Walk-ins welcome", "Solo-friendly", "Hosts community events" and
 *   "Budget-friendly" are atmosphere and service tags. They stay in `goodFor`,
 *   which is what `goodFor` is genuinely good at.
 */
export const LEGACY_GOOD_FOR_ACCESSIBILITY_TAGS: Readonly<
  Record<string, ListingAccessibilityQuestionSlug>
> = {
  'Step-free entrance': 'step-free-entrance',
  'Wheelchair accessible': 'wheelchair-accessible-interior',
  'Accessible bathroom': 'accessible-toilet',
  'Gender-neutral toilets': 'gender-neutral-toilet',
  'Quiet, low-sensory hours': 'quiet-hours',
};
