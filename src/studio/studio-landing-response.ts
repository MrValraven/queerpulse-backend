import { toImageUrl } from '../common/image-url';
import { MemberRef } from '../common/member-ref';
import {
  artistRefFromColumns,
  personaColumnsFromRow,
} from './studio-discovery-sql';
import { landingImageUrl } from './studio-landing-sql';
import {
  STUDIO_FALLBACK_ARTIST_PERSONA_KIND,
  STUDIO_STATS_THRESHOLD,
  StudioArtistPersonaKind,
  StudioLandingPreviewStatus,
  isStudioArtistPersonaKind,
} from './studio.constants';
import { StudioArtistRef } from './studio-response';

// Wire shapes of the Studio landing v2 contract (QUEERPULSE-STUDIO-LANDING-V2-CONTRACT-2026-10-28.md):
// section 2 (the public read), section 3 (the preview stream), section 10 (the
// owner approvals), section 11.1 (founding artists) and section 12 (access
// requests). The public persona carries no id: every id a row selects for a
// join or a render key stays inside the mapper.

/** Contract 2: the public Studio page. */
export interface StudioLandingResponse {
  counts: {
    /** Personas passing landingLiveArtistSql. Null below 5. */
    artists: number | null;
    /** Published releases of those personas. Null below 5. */
    releases: number | null;
    /** Events this calendar month (Europe/Lisbon) with a Studio artist. Null below 5. */
    eventsThisMonth: number | null;
  };
  nextEvent: StudioLandingNextEvent | null;
  /** Max 5, staff order. */
  previews: StudioLandingPreviewCard[];
  /** Max 6: founding artists first, then staff order. */
  artists: StudioLandingArtistCard[];
  photos: {
    hero: StudioLandingPhoto | null;
    manifesto: StudioLandingPhoto | null;
  };
}

/** Contract 2: public persona fields. No persona id, no member field. */
export interface StudioLandingPersona {
  name: string;
  handle: string;
  kind: StudioArtistPersonaKind;
  avatarUrl: string | null;
}

/** Contract 2: the next event with a Studio artist. Area level only. */
export interface StudioLandingNextEvent {
  slug: string;
  title: string;
  startAt: string;
  timezone: string;
  area: string | null;
  isOnline: boolean;
  artist: StudioLandingPersona;
}

/** Contract 2: one approved, eligible preview. `id` is the key of the stream route. */
export interface StudioLandingPreviewCard {
  id: string;
  trackTitle: string;
  durationSeconds: number;
  coverUrl: string | null;
  artist: StudioLandingPersona;
}

/** Contract 2: one artist card. `id` is a render key. */
export interface StudioLandingArtistCard {
  id: string;
  artist: StudioLandingPersona;
  quote: string | null;
  isFoundingArtist: boolean;
}

/** Contract 2: a staff-curated landing photo. */
export interface StudioLandingPhoto {
  url: string;
  altText: { en: string; pt: string };
  credit: string | null;
}

/** Contract 3: the answer of the preview stream route. */
export interface StudioLandingPreviewStream {
  url: string;
  expiresAt: string;
}

/** Contract 10: one row of the artist dashboard approvals. */
export interface StudioLandingPreviewOwnerItem {
  id: string;
  status: StudioLandingPreviewStatus;
  /** This persona's link to the track. */
  relation: 'main' | 'credited';
  track: { id: string; title: string; durationSeconds: number | null };
  release: { id: string; title: string; coverUrl: string | null };
  mainArtist: StudioArtistRef;
  requestedAt: string;
  decidedAt: string | null;
  isEligible: boolean;
  canApprove: boolean;
  canDecline: boolean;
  canWithdraw: boolean;
}

/** Contract 10: pending rows first (requestedAt asc), then approved (decidedAt desc). */
export interface StudioLandingPreviewOwnerList {
  items: StudioLandingPreviewOwnerItem[];
}

/** Contract 11.1: the member read of the founding artists. */
export interface StudioFoundingArtists {
  isShelfVisible: boolean;
  artists: StudioArtistRef[];
}

/** Contract 12.1: the caller's own waiting request. */
export interface StudioAccessRequestState {
  hasPendingRequest: true;
  wantsToRelease: boolean;
  requestedAt: string;
}

/** Contract 12.3: one staff row of Waiting for Studio. Member ids appear here and nowhere public. */
export interface AdminStudioAccessRequest {
  id: string;
  member: {
    id: string;
    slug: string;
    displayName: string;
    avatarUrl: string | null;
  };
  wantsToRelease: boolean;
  requestedAt: string;
  isFromInvite: boolean;
}

/** Contract 12.3: 30 rows per page. */
export interface AdminStudioAccessRequestPage {
  items: AdminStudioAccessRequest[];
  nextCursor: string | null;
  totalCount: number;
  artistCount: number;
}

// Row types are type aliases so a row is assignable to the
// `Readonly<Record<string, unknown>>` the persona mapper reads. Each persona
// column group is named by its prefix (`artist_handle`, `artist_kind`, ...).

export type LandingNextEventRow = {
  slug: string;
  title: string;
  start_at: Date;
  timezone: string;
  neighbourhood: string | null;
  is_online: boolean;
  artist_handle: string | null;
  artist_display_name: string;
  artist_kind: string;
  artist_avatar_url: string | null;
  artist_link_visibility: string;
};

export type LandingPreviewRow = {
  id: string;
  track_title: string;
  duration_seconds: number;
  cover_key: string | null;
  artist_handle: string | null;
  artist_display_name: string;
  artist_kind: string;
  artist_avatar_url: string | null;
  artist_link_visibility: string;
};

export type LandingArtistCardRow = {
  id: string;
  quote: string | null;
  is_founding_artist: boolean;
  artist_handle: string | null;
  artist_display_name: string;
  artist_kind: string;
  artist_avatar_url: string | null;
  artist_link_visibility: string;
};

export type LandingPhotoRow = {
  image_key: string;
  alt_text_en: string;
  alt_text_pt: string;
  credit: string | null;
};

export type OwnerPreviewRow = {
  id: string;
  status: StudioLandingPreviewStatus;
  relation: 'main' | 'credited';
  track_id: string;
  track_title: string;
  track_duration_seconds: number | null;
  release_id: string;
  release_title: string;
  release_cover_key: string | null;
  main_artist_id: string;
  main_artist_handle: string | null;
  main_artist_display_name: string;
  main_artist_kind: string;
  main_artist_avatar_url: string | null;
  requested_at: Date;
  decided_at: Date | null;
  is_eligible: boolean;
};

export type AccessRequestRow = {
  id: string;
  user_id: string;
  wants_to_release: boolean;
  is_from_invite: boolean;
  created_at: Date;
};

/**
 * The persona columns a public landing read selects: handle, display name,
 * kind, avatar and link visibility under `<columnPrefix>_...`. The persona id
 * is left out, so no public row can carry it.
 */
export function landingPersonaColumnsSql(
  personaAlias: string,
  columnPrefix: string,
): string {
  const persona = `"${personaAlias}"`;
  return `${persona}."handle" AS "${columnPrefix}_handle",
          ${persona}."display_name" AS "${columnPrefix}_display_name",
          ${persona}."kind" AS "${columnPrefix}_kind",
          ${persona}."avatar_url" AS "${columnPrefix}_avatar_url",
          ${persona}."link_visibility" AS "${columnPrefix}_link_visibility"`;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Contract 2 persona. A missing link visibility reads as unlinked, the strictest image rule. */
export function toStudioLandingPersona(
  row: Readonly<Record<string, unknown>>,
  columnPrefix: string,
): StudioLandingPersona {
  const storedKind = textOrNull(row[`${columnPrefix}_kind`]) ?? '';
  const linkVisibility =
    textOrNull(row[`${columnPrefix}_link_visibility`]) ?? 'unlinked';
  return {
    name: textOrNull(row[`${columnPrefix}_display_name`]) ?? '',
    handle: textOrNull(row[`${columnPrefix}_handle`]) ?? '',
    kind: isStudioArtistPersonaKind(storedKind)
      ? storedKind
      : STUDIO_FALLBACK_ARTIST_PERSONA_KIND,
    avatarUrl: landingImageUrl(
      textOrNull(row[`${columnPrefix}_avatar_url`]),
      linkVisibility,
    ),
  };
}

function floorCount(value: number | string): number | null {
  const count = Number(value);
  return Number.isFinite(count) && count >= STUDIO_STATS_THRESHOLD
    ? count
    : null;
}

/** Contract 2 counts: each value below `STUDIO_STATS_THRESHOLD` (zero included) reads null. */
export function toStudioLandingCounts(row: {
  artists: number | string;
  releases: number | string;
  events_this_month: number | string;
}): StudioLandingResponse['counts'] {
  return {
    artists: floorCount(row.artists),
    releases: floorCount(row.releases),
    eventsThisMonth: floorCount(row.events_this_month),
  };
}

export function toStudioLandingNextEvent(
  row: LandingNextEventRow,
): StudioLandingNextEvent {
  return {
    slug: row.slug,
    title: row.title,
    startAt: row.start_at.toISOString(),
    timezone: row.timezone,
    area: row.neighbourhood,
    isOnline: row.is_online,
    artist: toStudioLandingPersona(row, 'artist'),
  };
}

/** Contract 2 preview card: the cover follows the release persona's link visibility. */
export function toStudioLandingPreviewCard(
  row: LandingPreviewRow,
): StudioLandingPreviewCard {
  return {
    id: row.id,
    trackTitle: row.track_title,
    durationSeconds: row.duration_seconds,
    coverUrl: landingImageUrl(row.cover_key, row.artist_link_visibility),
    artist: toStudioLandingPersona(row, 'artist'),
  };
}

export function toStudioLandingArtistCard(
  row: LandingArtistCardRow,
): StudioLandingArtistCard {
  return {
    id: row.id,
    artist: toStudioLandingPersona(row, 'artist'),
    quote: row.quote,
    isFoundingArtist: row.is_founding_artist,
  };
}

/** Contract 2 photo: the stored key is landing-scoped, so `toImageUrl` serves it. */
export function toStudioLandingPhoto(
  row: LandingPhotoRow,
): StudioLandingPhoto | null {
  const url = toImageUrl(row.image_key);
  if (url === null) {
    return null;
  }
  return {
    url,
    altText: { en: row.alt_text_en, pt: row.alt_text_pt },
    credit: row.credit,
  };
}

/** Contract 10 owner item. Members only see their own personas, so images use `toImageUrl`. No member field is selected or sent. */
export function toStudioLandingPreviewOwnerItem(
  row: OwnerPreviewRow,
): StudioLandingPreviewOwnerItem {
  const isMainPersona = row.relation === 'main';
  const isPending = row.status === 'pending';
  return {
    id: row.id,
    status: row.status,
    relation: row.relation,
    track: {
      id: row.track_id,
      title: row.track_title,
      durationSeconds: row.track_duration_seconds,
    },
    release: {
      id: row.release_id,
      title: row.release_title,
      coverUrl: toImageUrl(row.release_cover_key),
    },
    mainArtist: artistRefFromColumns(personaColumnsFromRow(row, 'main_artist')),
    requestedAt: row.requested_at.toISOString(),
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    isEligible: row.is_eligible,
    canApprove: isMainPersona && isPending,
    canDecline: isMainPersona && isPending,
    canWithdraw: row.status === 'approved',
  };
}

/** Contract 12.3 row. `memberRef` is null when the member has no profile: the slug reads '' and the name ''. */
export function toAdminStudioAccessRequest(
  row: AccessRequestRow,
  memberRef: MemberRef | null,
): AdminStudioAccessRequest {
  return {
    id: row.id,
    member: {
      id: row.user_id,
      slug: memberRef?.slug ?? '',
      displayName: memberRef
        ? `${memberRef.firstName} ${memberRef.lastName}`.trim()
        : '',
      avatarUrl: memberRef?.avatarUrl ?? null,
    },
    wantsToRelease: row.wants_to_release,
    requestedAt: row.created_at.toISOString(),
    isFromInvite: row.is_from_invite,
  };
}

/** The Waiting for Studio keyset position: `(wants_to_release DESC, created_at ASC, id ASC)`. */
export interface AccessRequestCursor {
  wantsToRelease: boolean;
  createdAt: Date;
  id: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Contract 12.3: base64url of `<0|1>|<createdAt ISO>|<id>`. */
export function encodeAccessRequestCursor(cursor: AccessRequestCursor): string {
  return Buffer.from(
    `${cursor.wantsToRelease ? 1 : 0}|${cursor.createdAt.toISOString()}|${cursor.id}`,
    'utf8',
  ).toString('base64url');
}

/** Never throws: anything malformed reads as no cursor (the first page). */
export function decodeAccessRequestCursor(
  cursor: string | undefined,
): AccessRequestCursor | null {
  if (!cursor) {
    return null;
  }
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const [flag, isoTimestamp, id, ...extraParts] = decoded.split('|');
  if (
    (flag !== '0' && flag !== '1') ||
    !isoTimestamp ||
    !id ||
    extraParts.length > 0 ||
    !UUID_PATTERN.test(id)
  ) {
    return null;
  }
  const createdAt = new Date(isoTimestamp);
  if (Number.isNaN(createdAt.getTime())) {
    return null;
  }
  return { wantsToRelease: flag === '1', createdAt, id };
}
