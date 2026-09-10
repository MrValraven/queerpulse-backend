/**
 * A gathering's FAMILY, and the small bag of format-specific questions each
 * family raises.
 *
 * A gathering used to carry one free string ("Supper club", "Other") that
 * nothing downstream read. It now carries two things: a family, which is a
 * closed enum and drives behaviour, and a format key stored in the existing
 * `events.event_type` column (or, for "something else", the host's own text).
 *
 * THIS MODULE IS THE ONE PLACE the family vocabulary, the per-family detail
 * keys and the one-off legacy backfill table are declared, so the migration,
 * the DTO validators, the service and the specs cannot drift apart.
 *
 * The frontend mirrors this in `gatheringCatalog.ts` (queerpulse repo). The
 * keys on both sides are identical and are never renamed: they are stored
 * values, not labels.
 */

export enum GatheringFamily {
  Meet = 'meet',
  Eat = 'eat',
  Party = 'party',
  Make = 'make',
  Learn = 'learn',
  Watch = 'watch',
  Move = 'move',
  Care = 'care',
  Organise = 'organise',
}

/** Declaration order, which is also the order the wizard's family row uses. */
export const GATHERING_FAMILY_VALUES: readonly GatheringFamily[] = [
  GatheringFamily.Meet,
  GatheringFamily.Eat,
  GatheringFamily.Party,
  GatheringFamily.Make,
  GatheringFamily.Learn,
  GatheringFamily.Watch,
  GatheringFamily.Move,
  GatheringFamily.Care,
  GatheringFamily.Organise,
];

export const TERRAIN_VALUES = ['flat', 'mixed', 'steep'] as const;
export type Terrain = (typeof TERRAIN_VALUES)[number];

export const MAX_BRING_LENGTH = 200;
export const MIN_RUNTIME_MINUTES = 1;
export const MAX_RUNTIME_MINUTES = 600;

/**
 * The per-family details bag, stored whole in `events.format_details`.
 *
 * Deliberately six flat, optional, primitive fields rather than a per-format
 * schema: the wizard promises "one or two questions specific to this format"
 * and nothing more. Every field is optional, and a bag with no surviving
 * fields is stored as `null` rather than an empty object, so "the host
 * answered nothing" is one fact with one representation.
 */
export interface FormatDetails {
  /** What to bring, one line, already trimmed and never blank. Eat and make
   *  families. See `stripDisallowedDetails`, which drops a blank one. */
  bring?: string;
  /** The door checks age. Party family. */
  isAdultsOnly?: boolean;
  /** There is something good to drink that is not alcohol. Party family. */
  isSoberFriendly?: boolean;
  /** How hard the ground is underfoot. Move family. */
  terrain?: Terrain;
  /** Nobody needs to have done this before. Move family. */
  isBeginnerFriendly?: boolean;
  /** How long the film, set or performance runs. Watch family. */
  runtimeMinutes?: number;
}

export type FormatDetailKey = keyof FormatDetails;

/**
 * Which questions each family raises. A family with an empty list shows no
 * details block at all in the wizard and stores `null`.
 */
export const FORMAT_DETAIL_KEYS_BY_FAMILY: Readonly<
  Record<GatheringFamily, readonly FormatDetailKey[]>
> = {
  [GatheringFamily.Meet]: [],
  [GatheringFamily.Eat]: ['bring'],
  [GatheringFamily.Party]: ['isAdultsOnly', 'isSoberFriendly'],
  [GatheringFamily.Make]: ['bring'],
  [GatheringFamily.Learn]: [],
  [GatheringFamily.Watch]: ['runtimeMinutes'],
  [GatheringFamily.Move]: ['terrain', 'isBeginnerFriendly'],
  [GatheringFamily.Care]: [],
  [GatheringFamily.Organise]: [],
};

/** The detail keys this family may store. A gathering with no family stores
 *  none: the bag only ever means something inside a family. */
export function allowedDetailKeys(
  family: GatheringFamily | null | undefined,
): readonly FormatDetailKey[] {
  if (!family) return [];
  return FORMAT_DETAIL_KEYS_BY_FAMILY[family] ?? [];
}

/**
 * The bag, narrowed to what this family allows, or `null` when nothing
 * survives.
 *
 * A host who fills in "what to bring" for a potluck and then switches the
 * gathering to a screening leaves a stale `bring` behind. Stripping (rather
 * than rejecting) is what stops that from being a 400 the host cannot act on:
 * the answer belonged to a question that is no longer being asked, so it is
 * simply dropped. A key that is present but `undefined` is dropped too, so a
 * cleared field never becomes a stored hole.
 *
 * `bring` gets the same reading applied to its CONTENT: a line that is blank
 * or only whitespace is what a host sends by tabbing past the field, which is
 * the same fact as leaving the question unanswered, so it is dropped here
 * rather than stored as an empty string. A bag holding nothing but a blank
 * `bring` therefore comes back as `null`. The DTO deliberately caps the
 * length and stops there: a `@MinLength` would turn an untouched input into a
 * 400 a host cannot act on, which is the failure this whole function exists to
 * avoid. A `bring` that does survive is stored trimmed.
 */
export function stripDisallowedDetails(
  family: GatheringFamily | null | undefined,
  details: FormatDetails | null | undefined,
): FormatDetails | null {
  if (!details) return null;
  const allowed = allowedDetailKeys(family);
  const kept: FormatDetails = {};
  let hasAnyKey = false;
  for (const key of allowed) {
    const value = details[key];
    if (value === undefined || value === null) continue;
    // Per-key assignment rather than a spread so the result is typed field by
    // field instead of widened to a partial record of unions.
    if (key === 'bring') {
      // Blank is not an answer: see this function's doc. A non-string is
      // treated the same way, since there is no line to store either.
      const trimmedBring = typeof value === 'string' ? value.trim() : '';
      if (trimmedBring !== '') {
        kept.bring = trimmedBring;
        hasAnyKey = true;
      }
    } else if (key === 'isAdultsOnly' && typeof value === 'boolean') {
      kept.isAdultsOnly = value;
      hasAnyKey = true;
    } else if (key === 'isSoberFriendly' && typeof value === 'boolean') {
      kept.isSoberFriendly = value;
      hasAnyKey = true;
    } else if (key === 'terrain' && typeof value === 'string') {
      kept.terrain = value as Terrain;
      hasAnyKey = true;
    } else if (key === 'isBeginnerFriendly' && typeof value === 'boolean') {
      kept.isBeginnerFriendly = value;
      hasAnyKey = true;
    } else if (key === 'runtimeMinutes' && typeof value === 'number') {
      kept.runtimeMinutes = value;
      hasAnyKey = true;
    }
  }
  return hasAnyKey ? kept : null;
}

export interface LegacyTypeBackfillRow {
  /** Exactly the string the old wizard stored in `events.event_type`. */
  legacyLabel: string;
  /** The family the row gets, or `null` to leave it unclassified. */
  family: GatheringFamily | null;
  /** The format key `event_type` becomes, or `null` to clear the column. */
  formatKey: string | null;
}

/**
 * The eight labels the old wizard could store, and what each becomes.
 *
 * Matched CASE-INSENSITIVELY on `events.event_type` by the migration. Any
 * other stored value is left exactly as it is: family stays `NULL` and the
 * text keeps displaying verbatim, which is the correct reading of a gathering
 * whose host typed their own words. Backfilling beyond these eight is out of
 * scope on purpose (see the spec's "Not in this round").
 *
 * "Other" was stored as the literal word, which said nothing about the
 * gathering, so it clears both columns rather than inventing a family.
 */
export const LEGACY_TYPE_BACKFILL: readonly LegacyTypeBackfillRow[] = [
  {
    legacyLabel: 'Supper club',
    family: GatheringFamily.Eat,
    formatKey: 'supper-club',
  },
  {
    legacyLabel: 'Workshop / talk',
    family: GatheringFamily.Learn,
    formatKey: 'workshop',
  },
  {
    legacyLabel: 'Screening',
    family: GatheringFamily.Watch,
    formatKey: 'screening',
  },
  {
    legacyLabel: 'Studio visit',
    family: GatheringFamily.Make,
    formatKey: 'studio-visit',
  },
  {
    legacyLabel: 'Walk or outdoor',
    family: GatheringFamily.Move,
    formatKey: 'walk-or-hike',
  },
  {
    legacyLabel: 'Discussion',
    family: GatheringFamily.Learn,
    formatKey: 'discussion',
  },
  {
    legacyLabel: 'Skills exchange',
    family: GatheringFamily.Learn,
    formatKey: 'skills-exchange',
  },
  { legacyLabel: 'Other', family: null, formatKey: null },
];
