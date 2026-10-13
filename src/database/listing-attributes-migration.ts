/**
 * Frozen mapping tables and row conversions for migration
 * `AddListingAttributes1830800000000` (see that file's doc comment). It moves
 * the facts listings carried as free `tags` and "Good for" chips onto the
 * attribute slugs and the structured "getting in" fields, and the spoken
 * language names onto language codes.
 *
 * Lives in `src/database`, outside `src/migrations`: TypeORM requires every
 * `src/migrations/*.ts` file and calls `new` on every exported function as if
 * it were a migration class. Same convention as
 * `listing-online-details-migration.ts`.
 *
 * Every table here is a literal copy of the vocabularies as they stood on
 * 2026-10-08. Do not import the live ones: a migration is frozen history, and
 * a later vocabulary change must leave what this one did untouched. The
 * frontend draft healer copies the same tables.
 *
 * Lookups go through `Map`s, so an old value such as `constructor` can never
 * read an `Object.prototype` member.
 */

export type EntryModeAtMigration =
  'walkIn' | 'bookingRecommended' | 'appointmentOnly' | 'membersOnly';

export type CoverPolicyAtMigration = 'free';

/** An old tag or Good-for value, trimmed and lowercased, to the attribute it becomes. */
export const ATTRIBUTE_BY_OLD_VALUE_AT_MIGRATION: ReadonlyMap<string, string> =
  new Map([
    ['day passes', 'day-passes'],
    ['memberships', 'memberships'],
    ['class packs', 'class-packs'],
    ['workshops', 'workshops'],
    ['classes', 'classes'],
    ['live music', 'live-music'],
    ['dj nights', 'dj-nights'],
    ['drag shows', 'drag-shows'],
    ['exhibitions', 'exhibitions'],
    ['readings and talks', 'readings-and-talks'],
    ['community events', 'hosts-events'],
    ['hosts community events', 'hosts-events'],
    ['support groups', 'support-groups'],
    ['space for hire', 'space-for-hire'],
    ['vegan options', 'vegan-options'],
    ['vegetarian options', 'vegetarian-options'],
    ['gluten-free options', 'gluten-free-options'],
    ['alcohol-free options', 'alcohol-free-drinks'],
    ['terrace', 'terrace'],
    ['sliding scale', 'sliding-scale'],
    ['pay what you can', 'pay-what-you-can'],
    ['student discount', 'student-discount'],
    ['made to order', 'made-to-order'],
    ['custom commissions', 'custom-commissions'],
    ['gift cards', 'gift-cards'],
    ['free first call', 'free-first-call'],
    ['solo-friendly', 'solo-friendly'],
    ['dog-friendly', 'dog-friendly'],
    ['beginner-friendly', 'beginner-friendly'],
    ['good for gifts', 'good-for-gifts'],
  ]);

/** An old value that answered "how do people get in", to the entry mode. */
export const ENTRY_MODE_BY_OLD_VALUE_AT_MIGRATION: ReadonlyMap<
  string,
  EntryModeAtMigration
> = new Map([
  ['walk-ins welcome', 'walkIn'],
  ['booking recommended', 'bookingRecommended'],
  ['by appointment', 'appointmentOnly'],
  ['members only', 'membersOnly'],
]);

/** Least strict first. A row holding several keeps the strictest. */
export const ENTRY_MODE_STRICTNESS_AT_MIGRATION: readonly EntryModeAtMigration[] =
  ['walkIn', 'bookingRecommended', 'appointmentOnly', 'membersOnly'];

/** On an online row, By appointment becomes this attribute and sets no entry mode. */
const ONLINE_BY_APPOINTMENT_OLD_VALUE = 'by appointment';
const ONLINE_BY_APPOINTMENT_ATTRIBUTE = 'by-appointment';

/** Free entry becomes `cover_policy = 'free'` on a row in one of these categories. */
const FREE_ENTRY_OLD_VALUE = 'free entry';
const COVER_CATEGORY_SLUGS_AT_MIGRATION: readonly string[] = [
  'nightlife',
  'culture',
];

const SENSITIVE_ATTRIBUTE_SLUGS_AT_MIGRATION: readonly string[] = [
  'sexual-health-prep',
  'trans-care-experience',
];
const HIGHLIGHT_LIMIT_AT_MIGRATION = 3;

export const LANGUAGE_CODES_AT_MIGRATION: readonly string[] = [
  'pt',
  'pt-BR',
  'en',
  'es',
  'fr',
  'it',
  'de',
  'uk',
  'ru',
  'zh',
  'hi',
  'ne',
  'bn',
  'ar',
  'kea',
  'lgp',
  'ils',
];

/** The language names the old picker stored, lowercased, to their codes. */
export const LANGUAGE_CODE_BY_OLD_NAME_AT_MIGRATION: ReadonlyMap<
  string,
  string
> = new Map([
  ['português', 'pt'],
  ['português (brasil)', 'pt-BR'],
  ['english', 'en'],
  ['español', 'es'],
  ['français', 'fr'],
  ['lgp (sign)', 'lgp'],
]);

/** Picker values that named no language. */
const DROPPED_LANGUAGE_NAMES_AT_MIGRATION: readonly string[] = ['other'];

/** `down`: the six codes back to the names the old picker stored. */
export const OLD_LANGUAGE_NAME_BY_CODE_AT_MIGRATION: ReadonlyMap<
  string,
  string
> = new Map([
  ['pt', 'Português'],
  ['pt-BR', 'Português (Brasil)'],
  ['en', 'English'],
  ['es', 'Español'],
  ['fr', 'Français'],
  ['lgp', 'LGP (sign)'],
]);

export const LANGS_OTHER_MAX_LENGTH_AT_MIGRATION = 80;
/** The old `CreateListingDto.langs` limit, which `down` must not exceed. */
export const LANGS_MAX_ENTRIES_BEFORE_MIGRATION = 20;

const CODE_BY_LOWERCASE_CODE: ReadonlyMap<string, string> = new Map(
  LANGUAGE_CODES_AT_MIGRATION.map((code) => [code.toLowerCase(), code]),
);

export interface ListingRowBeforeAttributesUp {
  online: boolean | null;
  cats: readonly (string | null)[] | null;
  tags: readonly (string | null)[] | null;
  goodFor: readonly (string | null)[] | null;
  langs: readonly (string | null)[] | null;
}

export interface ListingRowAfterAttributesUp {
  attributes: string[];
  highlights: string[];
  entryMode: EntryModeAtMigration | null;
  coverPolicy: CoverPolicyAtMigration | null;
  langs: string[];
  langsOther: string;
}

export interface ListingRowBeforeLanguagesDown {
  langs: readonly (string | null)[] | null;
  langsOther: string | null;
}

export interface ListingRowBeforeLanguagesRestore extends ListingRowBeforeLanguagesDown {
  /** The `langs_before_attributes` backup `up` took; NULL on a row created after `up`. */
  langsBeforeAttributes: readonly (string | null)[] | null;
}

/** A stored list's string entries, NFC-normalised and trimmed, blanks dropped. */
function presentStrings(list: readonly (string | null)[] | null): string[] {
  return (list ?? [])
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.normalize('NFC').trim())
    .filter((entry) => entry !== '');
}

function convertLanguagesUp(raw: readonly (string | null)[] | null): {
  langs: string[];
  langsOther: string;
} {
  const langs: string[] = [];
  const otherLanguages: string[] = [];
  for (const value of presentStrings(raw)) {
    const lowercaseValue = value.toLowerCase();
    if (DROPPED_LANGUAGE_NAMES_AT_MIGRATION.includes(lowercaseValue)) continue;
    const code =
      LANGUAGE_CODE_BY_OLD_NAME_AT_MIGRATION.get(lowercaseValue) ??
      CODE_BY_LOWERCASE_CODE.get(lowercaseValue);
    if (code !== undefined) {
      if (!langs.includes(code)) langs.push(code);
    } else if (
      !otherLanguages.some(
        (otherLanguage) => otherLanguage.toLowerCase() === lowercaseValue,
      )
    ) {
      otherLanguages.push(value);
    }
  }
  return { langs, langsOther: joinWholeNamesThatFit(otherLanguages) };
}

/**
 * The names joined with `, `, each one whole: a name that would take the text
 * past `LANGS_OTHER_MAX_LENGTH_AT_MIGRATION` is left out and the next one is
 * tried, so the text never ends mid-name or on a separator.
 */
function joinWholeNamesThatFit(names: readonly string[]): string {
  let joinedNames = '';
  for (const name of names) {
    const candidate = joinedNames === '' ? name : `${joinedNames}, ${name}`;
    if (candidate.length <= LANGS_OTHER_MAX_LENGTH_AT_MIGRATION) {
      joinedNames = candidate;
    }
  }
  return joinedNames;
}

/** One row's new attribute, getting-in and language values. Pure; the old columns are left alone. */
export function convertListingAttributesRowUp(
  row: ListingRowBeforeAttributesUp,
): ListingRowAfterAttributesUp {
  const isOnline = row.online === true;
  const hasCoverCategory = presentStrings(row.cats).some((category) =>
    COVER_CATEGORY_SLUGS_AT_MIGRATION.includes(category),
  );
  const attributes: string[] = [];
  let strictestEntryModeRank = -1;
  let coverPolicy: CoverPolicyAtMigration | null = null;

  for (const oldValue of [
    ...presentStrings(row.tags),
    ...presentStrings(row.goodFor),
  ]) {
    const lowercaseValue = oldValue.toLowerCase();
    const attribute =
      isOnline && lowercaseValue === ONLINE_BY_APPOINTMENT_OLD_VALUE
        ? ONLINE_BY_APPOINTMENT_ATTRIBUTE
        : ATTRIBUTE_BY_OLD_VALUE_AT_MIGRATION.get(lowercaseValue);
    const entryMode = ENTRY_MODE_BY_OLD_VALUE_AT_MIGRATION.get(lowercaseValue);
    if (attribute !== undefined) {
      if (!attributes.includes(attribute)) attributes.push(attribute);
    } else if (entryMode !== undefined) {
      // An online listing has no way in (contract rule 4).
      if (!isOnline) {
        strictestEntryModeRank = Math.max(
          strictestEntryModeRank,
          ENTRY_MODE_STRICTNESS_AT_MIGRATION.indexOf(entryMode),
        );
      }
    } else if (
      lowercaseValue === FREE_ENTRY_OLD_VALUE &&
      hasCoverCategory &&
      !isOnline
    ) {
      coverPolicy = 'free';
    }
  }

  return {
    attributes,
    highlights: attributes
      .filter((slug) => !SENSITIVE_ATTRIBUTE_SLUGS_AT_MIGRATION.includes(slug))
      .slice(0, HIGHLIGHT_LIMIT_AT_MIGRATION),
    entryMode:
      strictestEntryModeRank === -1
        ? null
        : (ENTRY_MODE_STRICTNESS_AT_MIGRATION[strictestEntryModeRank] ?? null),
    coverPolicy,
    ...convertLanguagesUp(row.langs),
  };
}

/** `down`: the codes back to the old names (any other code as written), then the `langsOther` parts. */
export function convertListingLanguagesRowDown(
  row: ListingRowBeforeLanguagesDown,
): { langs: string[] } {
  const names: string[] = [];
  const addName = (name: string): void => {
    if (
      name !== '' &&
      !names.some(
        (existingName) => existingName.toLowerCase() === name.toLowerCase(),
      )
    ) {
      names.push(name);
    }
  };
  for (const code of presentStrings(row.langs)) {
    addName(OLD_LANGUAGE_NAME_BY_CODE_AT_MIGRATION.get(code) ?? code);
  }
  for (const part of (row.langsOther ?? '').split(',')) {
    addName(part.normalize('NFC').trim());
  }
  return { langs: names.slice(0, LANGS_MAX_ENTRIES_BEFORE_MIGRATION) };
}

/**
 * `down`: the `langs` a row goes back to. The backup `up` took wins and comes
 * back exactly as stored; a row with no backup (created after `up`) has its
 * codes converted by `convertListingLanguagesRowDown`.
 */
export function restoreListingLanguagesRowDown(
  row: ListingRowBeforeLanguagesRestore,
): { langs: (string | null)[] } {
  if (row.langsBeforeAttributes !== null) {
    return { langs: [...row.langsBeforeAttributes] };
  }
  return convertListingLanguagesRowDown({
    langs: row.langs,
    langsOther: row.langsOther,
  });
}
