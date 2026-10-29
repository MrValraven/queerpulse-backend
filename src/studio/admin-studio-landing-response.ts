import { toImageUrl } from '../common/image-url';
import {
  artistRefFromColumns,
  personaColumnsFromRow,
} from './studio-discovery-sql';
import {
  STUDIO_LANDING_INELIGIBLE_REASONS,
  StudioLandingIneligibleReason,
} from './studio-landing-sql';
import {
  STUDIO_LIMITS,
  StudioLandingPhotoSlot,
  StudioLandingPreviewStatus,
} from './studio.constants';
import { StudioArtistRef } from './studio-response';

// Staff wire shapes of the Studio landing v2 contract
// (QUEERPULSE-STUDIO-LANDING-V2-CONTRACT-2026-10-28.md), section 9.1. Staff
// reads carry persona ids and staff names; none of it reaches a public route.

/** Contract 9.1: a staff member by the batched name (`modAudit.nameForUserId`). */
export interface AdminStudioStaffRef {
  id: string;
  displayName: string;
}

export interface AdminStudioLandingPreview {
  id: string;
  status: StudioLandingPreviewStatus;
  position: number;
  track: { id: string; title: string; durationSeconds: number | null };
  release: { id: string; title: string; coverUrl: string | null };
  artist: StudioArtistRef;
  ineligibleReason: StudioLandingIneligibleReason | null;
  /** Approved, eligible, and within the first 5 eligible approved rows. */
  isOnLanding: boolean;
  requestedBy: AdminStudioStaffRef | null;
  requestedAt: string;
  /** Staff only: the persona member who took the latest owner action. */
  decidedBy: AdminStudioStaffRef | null;
  decidedAt: string | null;
}

export interface AdminStudioLandingTrackOption {
  track: { id: string; title: string; durationSeconds: number | null };
  release: { id: string; title: string; coverUrl: string | null };
  artist: StudioArtistRef;
  ineligibleReason: StudioLandingIneligibleReason | null;
  hasOpenPreview: boolean;
}

export interface AdminStudioLandingArtistCard {
  id: string;
  artist: StudioArtistRef;
  quote: string | null;
  position: number;
  consentedAt: string;
  createdBy: AdminStudioStaffRef | null;
  /** The persona passes landingArtistPersonaSql now. */
  isShown: boolean;
  isFoundingArtist: boolean;
}

export interface AdminStudioLandingPersonaOption {
  artist: StudioArtistRef;
  isEligible: boolean;
  hasCard: boolean;
  isFoundingArtist: boolean;
}

export interface AdminStudioLandingPhoto {
  slot: StudioLandingPhotoSlot;
  /** The stored landing-scoped key; a PUT that keeps the photo sends it back. */
  imageKey: string;
  url: string;
  altText: { en: string; pt: string };
  credit: string | null;
  consentedAt: string;
  updatedBy: AdminStudioStaffRef | null;
}

export interface AdminStudioFoundingArtist {
  id: string;
  artist: StudioArtistRef;
  position: number;
  addedBy: AdminStudioStaffRef | null;
  createdAt: string;
  /** The persona passes landingArtistPersonaSql now. */
  isListed: boolean;
}

export interface AdminStudioLandingSettings {
  isFoundingShelfVisible: boolean;
}

export interface AdminStudioLanding {
  /** Open rows (pending, approved) by position asc; then up to 30 decided rows, decided_at desc. */
  previews: AdminStudioLandingPreview[];
  artistCards: AdminStudioLandingArtistCard[];
  photos: {
    hero: AdminStudioLandingPhoto | null;
    manifesto: AdminStudioLandingPhoto | null;
  };
  foundingArtists: AdminStudioFoundingArtist[];
  settings: AdminStudioLandingSettings;
}

/** The part of the staff read that the content service builds. */
export type AdminStudioLandingContent = Pick<
  AdminStudioLanding,
  'artistCards' | 'foundingArtists' | 'settings'
>;

// Row types are type aliases so a row is assignable to the
// `Readonly<Record<string, unknown>>` the persona column reader takes.
// Persona columns come from `personaColumnsSql('persona', 'artist')`.

type AdminArtistColumns = {
  artist_id: string;
  artist_handle: string | null;
  artist_display_name: string;
  artist_kind: string;
  artist_avatar_url: string | null;
};

export type AdminLandingPreviewRow = AdminArtistColumns & {
  id: string;
  status: StudioLandingPreviewStatus;
  position: number;
  track_id: string;
  track_title: string;
  track_duration_seconds: number | null;
  release_id: string;
  release_title: string;
  release_cover_key: string | null;
  ineligible_reason: string | null;
  requested_by_id: string | null;
  requested_at: Date;
  decided_by_id: string | null;
  decided_at: Date | null;
};

export type AdminLandingTrackOptionRow = AdminArtistColumns & {
  track_id: string;
  track_title: string;
  track_duration_seconds: number | null;
  release_id: string;
  release_title: string;
  release_cover_key: string | null;
  ineligible_reason: string | null;
  has_open_preview: boolean;
};

export type AdminLandingArtistCardRow = AdminArtistColumns & {
  id: string;
  quote: string | null;
  position: number;
  consented_at: Date;
  created_by_id: string | null;
  is_shown: boolean;
  is_founding_artist: boolean;
};

export type AdminLandingPersonaOptionRow = AdminArtistColumns & {
  is_eligible: boolean;
  has_card: boolean;
  is_founding_artist: boolean;
};

export type AdminLandingPhotoRow = {
  slot: StudioLandingPhotoSlot;
  image_key: string;
  alt_text_en: string;
  alt_text_pt: string;
  credit: string | null;
  consented_at: Date;
  updated_by_id: string | null;
};

export type AdminFoundingArtistRow = AdminArtistColumns & {
  id: string;
  position: number;
  added_by_id: string | null;
  created_at: Date;
  is_listed: boolean;
};

/** A user by the batched name map (staff and persona owners); a deleted user (no entry) reads null. */
function toStaffRef(
  userId: string | null,
  userNames: ReadonlyMap<string, string>,
): AdminStudioStaffRef | null {
  if (userId === null) {
    return null;
  }
  const displayName = userNames.get(userId);
  return displayName === undefined ? null : { id: userId, displayName };
}

function toArtistRef(row: AdminArtistColumns): StudioArtistRef {
  return artistRefFromColumns(personaColumnsFromRow(row, 'artist'));
}

/** A stored reason outside the six contract values reads as null. */
function toIneligibleReason(
  value: string | null,
): StudioLandingIneligibleReason | null {
  const reason = STUDIO_LANDING_INELIGIBLE_REASONS.find(
    (candidate) => candidate === value,
  );
  return reason ?? null;
}

export function toAdminStudioLandingPreview(
  row: AdminLandingPreviewRow,
  userNames: ReadonlyMap<string, string>,
  isOnLanding: boolean,
): AdminStudioLandingPreview {
  return {
    id: row.id,
    status: row.status,
    position: row.position,
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
    artist: toArtistRef(row),
    ineligibleReason: toIneligibleReason(row.ineligible_reason),
    isOnLanding,
    requestedBy: toStaffRef(row.requested_by_id, userNames),
    requestedAt: row.requested_at.toISOString(),
    decidedBy: toStaffRef(row.decided_by_id, userNames),
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
  };
}

export function toAdminStudioLandingTrackOption(
  row: AdminLandingTrackOptionRow,
): AdminStudioLandingTrackOption {
  return {
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
    artist: toArtistRef(row),
    ineligibleReason: toIneligibleReason(row.ineligible_reason),
    hasOpenPreview: row.has_open_preview,
  };
}

export function toAdminStudioLandingArtistCard(
  row: AdminLandingArtistCardRow,
  userNames: ReadonlyMap<string, string>,
): AdminStudioLandingArtistCard {
  return {
    id: row.id,
    artist: toArtistRef(row),
    quote: row.quote,
    position: row.position,
    consentedAt: row.consented_at.toISOString(),
    createdBy: toStaffRef(row.created_by_id, userNames),
    isShown: row.is_shown,
    isFoundingArtist: row.is_founding_artist,
  };
}

export function toAdminStudioLandingPersonaOption(
  row: AdminLandingPersonaOptionRow,
): AdminStudioLandingPersonaOption {
  return {
    artist: toArtistRef(row),
    isEligible: row.is_eligible,
    hasCard: row.has_card,
    isFoundingArtist: row.is_founding_artist,
  };
}

/** Staff photo: the stored key goes back to the staff member as `imageKey`. A key `toImageUrl` cannot serve reads null. */
export function toAdminStudioLandingPhoto(
  row: AdminLandingPhotoRow,
  userNames: ReadonlyMap<string, string>,
): AdminStudioLandingPhoto | null {
  const url = toImageUrl(row.image_key);
  if (url === null) {
    return null;
  }
  return {
    slot: row.slot,
    imageKey: row.image_key,
    url,
    altText: { en: row.alt_text_en, pt: row.alt_text_pt },
    credit: row.credit,
    consentedAt: row.consented_at.toISOString(),
    updatedBy: toStaffRef(row.updated_by_id, userNames),
  };
}

export function toAdminStudioFoundingArtist(
  row: AdminFoundingArtistRow,
  userNames: ReadonlyMap<string, string>,
): AdminStudioFoundingArtist {
  return {
    id: row.id,
    artist: toArtistRef(row),
    position: row.position,
    addedBy: toStaffRef(row.added_by_id, userNames),
    createdAt: row.created_at.toISOString(),
    isListed: row.is_listed,
  };
}

/**
 * The ids of the rows the public landing shows: the first
 * `STUDIO_LIMITS.landingPreviewsShown` approved rows with no ineligible
 * reason, in the order given (the read orders by position then id).
 */
export function markPreviewsOnLanding(
  rows: readonly {
    id: string;
    status: string;
    ineligible_reason: string | null;
  }[],
): Set<string> {
  const idsOnLanding = new Set<string>();
  for (const row of rows) {
    if (idsOnLanding.size >= STUDIO_LIMITS.landingPreviewsShown) {
      break;
    }
    if (row.status === 'approved' && row.ineligible_reason === null) {
      idsOnLanding.add(row.id);
    }
  }
  return idsOnLanding;
}
