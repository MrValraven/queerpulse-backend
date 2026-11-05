import {
  PERSONA_WALL_FILL_ORDERS,
  PERSONA_WALL_SEARCH_QUERY_MAX,
  PERSONA_WALL_TIME_ZONE,
  type PersonaWallFillOrder,
  type PersonaWallPublicState,
} from './persona-wall.constants';
import {
  type Subprofile,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';

/**
 * Why a picked persona does or does not show on the public wall. This mirrors
 * the four persona predicates of `directoryBaseQuery` (kept, free of a
 * takedown, published and open). The first matching state wins: removed,
 * taken down, draft, then not open.
 */
export function personaWallPublicStateOf(
  persona: Pick<Subprofile, 'status' | 'visibility' | 'removedAt'>,
  isTakenDown: boolean,
): PersonaWallPublicState {
  if (persona.removedAt) {
    return 'removed';
  }
  if (isTakenDown) {
    return 'taken_down';
  }
  if (persona.status !== SubprofileStatus.Published) {
    return 'draft';
  }
  if (persona.visibility !== SubprofileVisibility.Open) {
    return 'not_open';
  }
  return 'shown';
}

/** Whether a request value is one of the four fill orders. */
export function isPersonaWallFillOrder(
  value: unknown,
): value is PersonaWallFillOrder {
  return (
    typeof value === 'string' &&
    (PERSONA_WALL_FILL_ORDERS as readonly string[]).includes(value)
  );
}

const LISBON_WALL_DAY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: PERSONA_WALL_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** `YYYY-MM-DD` of `now` in Lisbon, the seed day of the daily shuffle. */
export function lisbonWallDay(now: Date): string {
  const parts = LISBON_WALL_DAY_FORMAT.formatToParts(now);
  const partOf = (partType: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === partType)?.value ?? '';
  return `${partOf('year')}-${partOf('month')}-${partOf('day')}`;
}

/** Trims the admin search text. A blank or non-string value gives `''` (the
 *  caller answers an empty list) and a long one is cut to its first 100 code
 *  points, so no length rule can answer a generic 400. */
export function normalizeWallSearchTerm(query: unknown): string {
  if (typeof query !== 'string') {
    return '';
  }
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return '';
  }
  return Array.from(trimmedQuery)
    .slice(0, PERSONA_WALL_SEARCH_QUERY_MAX)
    .join('');
}
