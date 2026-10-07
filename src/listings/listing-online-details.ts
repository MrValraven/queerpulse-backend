/**
 * The structured "Ordering & delivery" facts of a listing that sells online:
 * an online-only business (`online === true`), or a place that also sells
 * online (`hasOnlineShop === true`). Stored as one jsonb column
 * (`listings.online_details`) and normalised on every read and write, the way
 * `menu` is, so a row written before the column existed (`'{}'`) reads as a
 * complete, empty value.
 *
 * Every vocabulary here is mirrored string for string by the frontend; see the
 * wire contract `QUEERPULSE-ONLINE-LISTINGS-CONTRACT-2026-10-07.md`.
 */

export const ONLINE_MAIN_LINK_KINDS = [
  'shop',
  'booking',
  'website',
  'newsletter',
] as const;
export type OnlineMainLinkKind = (typeof ONLINE_MAIN_LINK_KINDS)[number];

/** The fixed platform list for "More links", so a page can show the right label and icon. */
export const ONLINE_LINK_PLATFORMS = [
  'etsy',
  'vinted',
  'bandcamp',
  'kofi',
  'patreon',
  'substack',
  'tiktok',
  'linktree',
  'other',
] as const;
export type OnlineLinkPlatform = (typeof ONLINE_LINK_PLATFORMS)[number];

/** "How people get it", in canonical order. */
export const ONLINE_FULFILMENT_OPTIONS = [
  'shipsPortugal',
  'shipsEu',
  'shipsWorldwide',
  'digital',
  'pickupLisbon',
] as const;
export type OnlineFulfilment = (typeof ONLINE_FULFILMENT_OPTIONS)[number];

/** Where orders ship from. The wire uses `''` for unanswered. */
export const ONLINE_SHIPS_FROM_OPTIONS = [
  'portugal',
  'eu',
  'outsideEu',
] as const;
export type OnlineShipsFrom = (typeof ONLINE_SHIPS_FROM_OPTIONS)[number];

export const ONLINE_PAYMENT_METHODS = [
  'mbway',
  'multibanco',
  'card',
  'paypal',
  'bankTransfer',
] as const;
export type OnlinePaymentMethod = (typeof ONLINE_PAYMENT_METHODS)[number];

export const ONLINE_SESSION_FORMATS = [
  'video',
  'phone',
  'chat',
  'inPerson',
] as const;
export type OnlineSessionFormat = (typeof ONLINE_SESSION_FORMATS)[number];

/** Professional bodies a registration can name. The wire uses `''` for none. */
export const PROFESSIONAL_REGISTRATION_BODIES = [
  'opp',
  'ordemMedicos',
  'other',
] as const;
export type ProfessionalRegistrationBody =
  (typeof PROFESSIONAL_REGISTRATION_BODIES)[number];

export const MAX_ONLINE_MORE_LINKS = 4;
export const MAX_ONLINE_NOTE_LENGTH = 140;
export const MAX_REGISTRATION_NUMBER_LENGTH = 40;
/**
 * The same ceiling `social.website` has, counted after any `http://` or
 * `https://`: what a member typed when they left the scheme out, and the
 * same count again once the server has prefixed `https://`.
 */
export const MAX_ONLINE_URL_LENGTH = 300;

export interface ListingOnlineMainLink {
  url: string;
  kind: OnlineMainLinkKind;
}

export interface ListingOnlineMoreLink {
  url: string;
  platform: OnlineLinkPlatform;
}

/** Shown as stated by the business ("Registered with the OPP, no. 12345"); never verified. */
export interface ListingProfessionalRegistration {
  body: ProfessionalRegistrationBody | '';
  number: string;
}

export interface ListingOnlineDetails {
  /** The card's Visit action. Required once a listing sells online. */
  mainLink: ListingOnlineMainLink | null;
  moreLinks: ListingOnlineMoreLink[];
  fulfilment: OnlineFulfilment[];
  pickupNote: string;
  shipsFrom: OnlineShipsFrom | '';
  /** Only meaningful when orders ship from outside the EU; false otherwise. */
  isVatIncluded: boolean;
  payments: OnlinePaymentMethod[];
  sessionFormats: OnlineSessionFormat[];
  registration: ListingProfessionalRegistration;
  replyNote: string;
  /**
   * When the 18+ terms were first accepted, ISO-8601. Stamped by the server
   * (`resolveOnlineListingFields`); a value a client sends is ignored. On the
   * owner wire only.
   */
  adultTermsAcceptedAt: string | null;
}

/** What a public page may show: everything but the acceptance record. */
export type ListingPublicOnlineDetails = Omit<
  ListingOnlineDetails,
  'adultTermsAcceptedAt'
>;

/** What a directory card needs: the Visit action and the status slot. */
export interface ListingOnlineSummary {
  mainLink: ListingOnlineMainLink | null;
  fulfilment: OnlineFulfilment[];
  sessionFormats: OnlineSessionFormat[];
}

/** The flags and the column a reader needs to decide whether a listing sells online. */
export interface OnlineSellingSource {
  online?: boolean | null;
  hasOnlineShop?: boolean | null;
  onlineDetails?: unknown;
}

/** A fresh empty value. A function so no caller shares one mutable object. */
export function emptyListingOnlineDetails(): ListingOnlineDetails {
  return {
    mainLink: null,
    moreLinks: [],
    fulfilment: [],
    pickupNote: '',
    shipsFrom: '',
    isVatIncluded: false,
    payments: [],
    sessionFormats: [],
    registration: { body: '', number: '' },
    replyNote: '',
    adultTermsAcceptedAt: null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A string trimmed and cut to `maxLength` characters (code points); anything else reads as `''`. */
function trimmedText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return Array.from(value.trim()).slice(0, maxLength).join('');
}

function isInVocabulary<Value extends string>(
  vocabulary: readonly Value[],
  value: unknown,
): value is Value {
  return (
    typeof value === 'string' &&
    (vocabulary as readonly string[]).includes(value)
  );
}

/** The vocabulary entries a raw list names, each once, in vocabulary order. */
function canonicalSubset<Value extends string>(
  vocabulary: readonly Value[],
  raw: unknown,
): Value[] {
  if (!Array.isArray(raw)) return [];
  const wantedValues = new Set(
    (raw as unknown[]).filter(
      (entry): entry is string => typeof entry === 'string',
    ),
  );
  return vocabulary.filter((value) => wantedValues.has(value));
}

const WEB_SCHEME_PATTERN = /^https?:\/\//i;
// Any other scheme (`mailto:`, `javascript:`). The lookahead lets a host with
// a port through (`shop.example.pt:8080`).
const ANY_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:(?!\d)/i;
// Whitespace or a backslash inside a link. `URL` drops a newline or a tab and
// reads `\` as `/`, so the address a page shows and the one it opens differ
// (`etsy.com\@evil.pt` opens evil.pt).
const WHITESPACE_OR_BACKSLASH_PATTERN = /[\s\\]/;

/**
 * A link a member typed, as the server stores it, or `null` when it is no web
 * address. A domain with no protocol gets `https://`; `http:` and `https:` are
 * the only schemes kept. The host needs a dot, and credentials in the URL
 * (`name@host`) are refused because they are a classic way to dress one site
 * up as another; whitespace and backslashes inside the link are refused for
 * the same reason. The length ceiling counts the link after its `http://` or
 * `https://`, so a stored value (prefixed by this function) reads back exactly
 * as it was written.
 */
export function normalizeOnlineListingUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmedUrl = raw.trim();
  const urlAfterWebScheme = trimmedUrl.replace(WEB_SCHEME_PATTERN, '');
  if (
    trimmedUrl === '' ||
    urlAfterWebScheme.length > MAX_ONLINE_URL_LENGTH ||
    WHITESPACE_OR_BACKSLASH_PATTERN.test(trimmedUrl)
  ) {
    return null;
  }
  let candidateUrl: string;
  if (WEB_SCHEME_PATTERN.test(trimmedUrl)) {
    candidateUrl = trimmedUrl;
  } else if (
    ANY_SCHEME_PATTERN.test(trimmedUrl) ||
    trimmedUrl.startsWith('//')
  ) {
    return null;
  } else {
    candidateUrl = `https://${trimmedUrl}`;
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(candidateUrl);
  } catch {
    return null;
  }
  const isWebProtocol =
    parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:';
  const hasCredentials = parsedUrl.username !== '' || parsedUrl.password !== '';
  if (!isWebProtocol || hasCredentials || !parsedUrl.hostname.includes('.')) {
    return null;
  }
  return candidateUrl;
}

function normalizeMainLink(raw: unknown): ListingOnlineMainLink | null {
  const source = asRecord(raw);
  const kind = source?.kind;
  if (!isInVocabulary(ONLINE_MAIN_LINK_KINDS, kind)) return null;
  const url = normalizeOnlineListingUrl(source?.url);
  return url === null ? null : { url, kind };
}

function normalizeMoreLinks(raw: unknown): ListingOnlineMoreLink[] {
  if (!Array.isArray(raw)) return [];
  const moreLinks: ListingOnlineMoreLink[] = [];
  for (const entry of raw as unknown[]) {
    const source = asRecord(entry);
    const platform = source?.platform;
    const url = normalizeOnlineListingUrl(source?.url);
    if (url === null || !isInVocabulary(ONLINE_LINK_PLATFORMS, platform)) {
      continue;
    }
    moreLinks.push({ url, platform });
    if (moreLinks.length === MAX_ONLINE_MORE_LINKS) break;
  }
  return moreLinks;
}

function normalizeRegistration(raw: unknown): ListingProfessionalRegistration {
  const source = asRecord(raw);
  const body = source?.body;
  if (!isInVocabulary(PROFESSIONAL_REGISTRATION_BODIES, body)) {
    return { body: '', number: '' };
  }
  return {
    body,
    number: trimmedText(source?.number, MAX_REGISTRATION_NUMBER_LENGTH),
  };
}

/**
 * Any stored or submitted value, read as a complete `ListingOnlineDetails`:
 * unknown values drop out, lists come back once each in canonical order,
 * links are stored with `https://`, notes are trimmed and capped, and
 * `isVatIncluded` holds only for shipping from outside the EU. Idempotent, so
 * it runs on reads and writes alike.
 */
export function normalizeListingOnlineDetails(
  raw: unknown,
): ListingOnlineDetails {
  const source = asRecord(raw) ?? {};
  const shipsFromValue = source.shipsFrom;
  const shipsFrom: OnlineShipsFrom | '' = isInVocabulary(
    ONLINE_SHIPS_FROM_OPTIONS,
    shipsFromValue,
  )
    ? shipsFromValue
    : '';
  const stampValue = source.adultTermsAcceptedAt;
  return {
    mainLink: normalizeMainLink(source.mainLink),
    moreLinks: normalizeMoreLinks(source.moreLinks),
    fulfilment: canonicalSubset(ONLINE_FULFILMENT_OPTIONS, source.fulfilment),
    pickupNote: trimmedText(source.pickupNote, MAX_ONLINE_NOTE_LENGTH),
    shipsFrom,
    isVatIncluded: shipsFrom === 'outsideEu' && source.isVatIncluded === true,
    payments: canonicalSubset(ONLINE_PAYMENT_METHODS, source.payments),
    sessionFormats: canonicalSubset(
      ONLINE_SESSION_FORMATS,
      source.sessionFormats,
    ),
    registration: normalizeRegistration(source.registration),
    replyNote: trimmedText(source.replyNote, MAX_ONLINE_NOTE_LENGTH),
    adultTermsAcceptedAt:
      typeof stampValue === 'string' && stampValue !== '' ? stampValue : null,
  };
}

/** "Sells online": an online-only listing, or a place that also sells online. */
export function listingSellsOnline(listing: OnlineSellingSource): boolean {
  return listing.online === true || listing.hasOnlineShop === true;
}

/** The detail page's "Ordering & delivery" block, or `null` for a listing that does not sell online. */
export function toListingPublicOnlineDetails(
  listing: OnlineSellingSource,
): ListingPublicOnlineDetails | null {
  if (!listingSellsOnline(listing)) return null;
  const { adultTermsAcceptedAt: _adultTermsAcceptedAt, ...publicDetails } =
    normalizeListingOnlineDetails(listing.onlineDetails);
  return publicDetails;
}

/** The card's online summary, or `null` for a listing that does not sell online. */
export function toListingOnlineSummary(
  listing: OnlineSellingSource,
): ListingOnlineSummary | null {
  if (!listingSellsOnline(listing)) return null;
  const details = normalizeListingOnlineDetails(listing.onlineDetails);
  return {
    mainLink: details.mainLink,
    fulfilment: details.fulfilment,
    sessionFormats: details.sessionFormats,
  };
}

/**
 * The claim path's requirement for an online-only listing: some way people
 * get it, either a delivery option or (for a therapist or a teacher) a
 * session format.
 */
export function hasOnlineFulfilmentOrSessionFormat(raw: unknown): boolean {
  const details = normalizeListingOnlineDetails(raw);
  return details.fulfilment.length > 0 || details.sessionFormats.length > 0;
}
