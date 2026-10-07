/**
 * Frozen mapping tables and row conversions for migration
 * `AddListingOnlineDetails1830100200000` (see that file's doc comment). It moves the
 * facts online listings used to carry as tags, an hours note and a website
 * into the structured `online_details` column, and maps their place
 * categories onto the online category vocabulary.
 *
 * Lives in `src/database`, outside `src/migrations`: TypeORM requires every
 * `src/migrations/*.ts` file and calls `new` on every exported function as if
 * it were a migration class. Same convention as `work-taxonomy-migration.sql.ts`.
 *
 * Every table here is a literal copy of the vocabularies as they stood on
 * 2026-10-07. Do not import the live ones: a migration is frozen history, and
 * a later vocabulary change must leave what this one did untouched.
 */

type MovedTagField = 'fulfilment' | 'payments' | 'sessionFormats';

interface MovedTag {
  tag: string;
  field: MovedTagField;
  value: string;
}

/** The ten tags that became structured fields, in the order `down` restores them. */
export const ONLINE_TAG_MOVES_AT_MIGRATION: readonly MovedTag[] = [
  { tag: 'Ships to Portugal', field: 'fulfilment', value: 'shipsPortugal' },
  { tag: 'Ships across the EU', field: 'fulfilment', value: 'shipsEu' },
  { tag: 'Ships worldwide', field: 'fulfilment', value: 'shipsWorldwide' },
  { tag: 'Pick-up in Lisbon', field: 'fulfilment', value: 'pickupLisbon' },
  { tag: 'Digital downloads', field: 'fulfilment', value: 'digital' },
  { tag: 'MB WAY', field: 'payments', value: 'mbway' },
  { tag: 'Multibanco', field: 'payments', value: 'multibanco' },
  { tag: 'PayPal', field: 'payments', value: 'paypal' },
  { tag: 'Video sessions', field: 'sessionFormats', value: 'video' },
  { tag: 'Phone sessions', field: 'sessionFormats', value: 'phone' },
];

/** The canonical order of each structured list on 2026-10-07. */
const CANONICAL_ORDER_AT_MIGRATION: Readonly<
  Record<MovedTagField, readonly string[]>
> = {
  fulfilment: [
    'shipsPortugal',
    'shipsEu',
    'shipsWorldwide',
    'digital',
    'pickupLisbon',
  ],
  payments: ['mbway', 'multibanco', 'card', 'paypal', 'bankTransfer'],
  sessionFormats: ['video', 'phone', 'chat', 'inPerson'],
};

/** `space` and `nightlife` have no online match and are dropped. */
export const PLACE_TO_ONLINE_CATEGORY_AT_MIGRATION: Readonly<
  Record<string, string>
> = {
  design: 'handmade',
  culture: 'books-music',
  health: 'therapy',
  tech: 'digital',
  grooming: 'body-care',
  fitness: 'classes',
  food: 'food',
};

/** The reverse map `down` uses. Every other online category is dropped. */
export const ONLINE_TO_PLACE_CATEGORY_AT_MIGRATION: Readonly<
  Record<string, string>
> = {
  handmade: 'design',
  'books-music': 'culture',
  therapy: 'health',
  digital: 'tech',
  'body-care': 'grooming',
  classes: 'fitness',
  food: 'food',
};

export const REPLY_NOTE_MAX_LENGTH_AT_MIGRATION = 140;

/** The link ceiling on 2026-10-07, counted after `http://` or `https://`. */
export const MAIN_LINK_URL_MAX_LENGTH_AT_MIGRATION = 300;

/** A Postgres `text[]` may hold a `NULL` element, so the converters read each tag as maybe-null. */
type StoredTags = (string | null)[] | null;

export interface OnlineListingRowBeforeUp {
  cats: string[] | null;
  tags: StoredTags;
  hoursNote: string | null;
  social: Record<string, unknown> | null;
}

/** The complete `online_details` value `up` writes. */
export interface OnlineDetailsAtMigration {
  mainLink: { url: string; kind: 'website' } | null;
  moreLinks: { url: string; platform: string }[];
  fulfilment: string[];
  pickupNote: string;
  shipsFrom: string;
  isVatIncluded: boolean;
  payments: string[];
  sessionFormats: string[];
  registration: { body: string; number: string };
  replyNote: string;
  adultTermsAcceptedAt: string | null;
}

export interface OnlineListingRowAfterUp {
  cats: string[];
  tags: string[];
  hoursNote: string;
  /**
   * Always `''`. Until 2026-10-07 the write path stored `Lisbon` on every
   * listing whatever the submitter said, so on an online row it states
   * nothing; the owner fills "Based in" on their next edit.
   */
  city: string;
  /**
   * Always `''`, `''`, `false`, `null` and `null`: an online listing has no
   * neighbourhood, address or map pin, the same values the write path sets
   * from 2026-10-07 on.
   */
  hood: string;
  address: string;
  geocoded: boolean;
  latitude: null;
  longitude: null;
  onlineDetails: OnlineDetailsAtMigration;
}

export interface OnlineListingRowBeforeDown {
  cats: string[] | null;
  tags: StoredTags;
  hoursNote: string | null;
  onlineDetails: unknown;
}

export interface OnlineListingRowAfterDown {
  cats: string[];
  tags: string[];
  hoursNote: string;
}

/** Each category through `mapping`, unmatched ones dropped, each result once, order kept. */
function mapCategories(
  cats: readonly string[] | null,
  mapping: Readonly<Record<string, string>>,
): string[] {
  const mappedCategories: string[] = [];
  for (const category of cats ?? []) {
    const mappedCategory = mapping[category];
    if (
      mappedCategory !== undefined &&
      !mappedCategories.includes(mappedCategory)
    ) {
      mappedCategories.push(mappedCategory);
    }
  }
  return mappedCategories;
}

/**
 * The website as a main link URL: `https://` added when it had no protocol,
 * `null` when it is no web address. A website longer than 300 characters after
 * its protocol, or holding whitespace or a backslash, is left out: the
 * readers' link rules (as of 2026-10-07) would read it as no link.
 */
function websiteAsMainLinkUrl(website: unknown): string | null {
  if (typeof website !== 'string') return null;
  const trimmedWebsite = website.trim();
  const websiteAfterWebScheme = trimmedWebsite.replace(/^https?:\/\//i, '');
  if (
    trimmedWebsite === '' ||
    websiteAfterWebScheme.length > MAIN_LINK_URL_MAX_LENGTH_AT_MIGRATION ||
    /[\s\\]/.test(trimmedWebsite)
  ) {
    return null;
  }
  if (/^https?:\/\//i.test(trimmedWebsite)) return trimmedWebsite;
  if (
    /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(trimmedWebsite) ||
    trimmedWebsite.startsWith('//')
  ) {
    return null;
  }
  return `https://${trimmedWebsite}`;
}

function firstCharacters(text: string, maxLength: number): string {
  return Array.from(text).slice(0, maxLength).join('');
}

/** The stored tags with any `NULL` element left out. */
function textTags(tags: StoredTags): string[] {
  return (tags ?? []).filter((tag): tag is string => typeof tag === 'string');
}

/** One `online = true` row, as `up` rewrites it. */
export function convertOnlineListingRowUp(
  row: OnlineListingRowBeforeUp,
): OnlineListingRowAfterUp {
  const storedTags = textTags(row.tags);
  const lowercaseStoredTags = new Set(
    storedTags.map((tag) => tag.trim().toLowerCase()),
  );
  const movedValues: Record<MovedTagField, Set<string>> = {
    fulfilment: new Set(),
    payments: new Set(),
    sessionFormats: new Set(),
  };
  const movedLowercaseTags = new Set<string>();
  for (const move of ONLINE_TAG_MOVES_AT_MIGRATION) {
    const lowercaseTag = move.tag.toLowerCase();
    if (lowercaseStoredTags.has(lowercaseTag)) {
      movedValues[move.field].add(move.value);
      movedLowercaseTags.add(lowercaseTag);
    }
  }
  const inCanonicalOrder = (field: MovedTagField): string[] =>
    CANONICAL_ORDER_AT_MIGRATION[field].filter((value) =>
      movedValues[field].has(value),
    );
  const mainLinkUrl = websiteAsMainLinkUrl(row.social?.website);
  return {
    cats: mapCategories(row.cats, PLACE_TO_ONLINE_CATEGORY_AT_MIGRATION),
    tags: storedTags.filter(
      (tag) => !movedLowercaseTags.has(tag.trim().toLowerCase()),
    ),
    hoursNote: '',
    city: '',
    hood: '',
    address: '',
    geocoded: false,
    latitude: null,
    longitude: null,
    onlineDetails: {
      mainLink:
        mainLinkUrl === null ? null : { url: mainLinkUrl, kind: 'website' },
      moreLinks: [],
      fulfilment: inCanonicalOrder('fulfilment'),
      pickupNote: '',
      shipsFrom: '',
      isVatIncluded: false,
      payments: inCanonicalOrder('payments'),
      sessionFormats: inCanonicalOrder('sessionFormats'),
      registration: { body: '', number: '' },
      replyNote: firstCharacters(
        (row.hoursNote ?? '').trim(),
        REPLY_NOTE_MAX_LENGTH_AT_MIGRATION,
      ),
      adultTermsAcceptedAt: null,
    },
  };
}

/** One `online = true` row, as `down` restores it. */
export function convertOnlineListingRowDown(
  row: OnlineListingRowBeforeDown,
): OnlineListingRowAfterDown {
  const details = (
    typeof row.onlineDetails === 'object' && row.onlineDetails !== null
      ? row.onlineDetails
      : {}
  ) as Record<string, unknown>;
  const restoredTags = textTags(row.tags);
  const lowercaseTags = new Set(
    restoredTags.map((tag) => tag.trim().toLowerCase()),
  );
  for (const move of ONLINE_TAG_MOVES_AT_MIGRATION) {
    const storedValues = details[move.field];
    const hasValue =
      Array.isArray(storedValues) &&
      (storedValues as unknown[]).includes(move.value);
    const lowercaseTag = move.tag.toLowerCase();
    if (hasValue && !lowercaseTags.has(lowercaseTag)) {
      restoredTags.push(move.tag);
      lowercaseTags.add(lowercaseTag);
    }
  }
  const storedHoursNote = row.hoursNote ?? '';
  const replyNote =
    typeof details.replyNote === 'string' ? details.replyNote : '';
  return {
    cats: mapCategories(row.cats, ONLINE_TO_PLACE_CATEGORY_AT_MIGRATION),
    tags: restoredTags,
    hoursNote: storedHoursNote.trim() === '' ? replyNote : storedHoursNote,
  };
}
