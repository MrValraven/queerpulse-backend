import { StudioSpotlightSlot } from './studio.constants';
import {
  artistRefFromColumns,
  personaColumnsFromRow,
} from './studio-discovery-sql';
import { StudioArtistRef } from './studio-response';

/*
 * Studio spotlight curation, staff view. The persona is a reference only:
 * no member id, name or avatar is part of any shape here.
 */

export interface AdminStudioSpotlightArtist {
  /** The spotlight row id. */
  id: string;
  slot: StudioSpotlightSlot;
  /** 1-based and contiguous per slot. */
  position: number;
  note: string | null;
  /** ISO. "Picked {date}" and the stale-month line read it. */
  createdAt: string;
  /** The persona is listenable and has a published release. Blocks are
   *  ignored for staff. */
  isListenable: boolean;
  artist: StudioArtistRef;
}

export interface AdminStudioSpotlight {
  artistOfTheMonth: AdminStudioSpotlightArtist | null;
  newStars: AdminStudioSpotlightArtist[];
}

export interface AdminStudioSpotlightArtistOption {
  artist: StudioArtistRef;
  /** The newest published release, for the result row. */
  latestReleaseTitle: string | null;
  isInArtistOfTheMonth: boolean;
  isInNewStars: boolean;
}

// Row types are type aliases so a row is assignable to the
// `Readonly<Record<string, unknown>>` the persona column reader takes.
// Persona columns come from `personaColumnsSql('persona', 'artist')`.

type SpotlightArtistColumns = {
  artist_id: string;
  artist_handle: string | null;
  artist_display_name: string;
  artist_kind: string;
  artist_avatar_url: string | null;
};

export type AdminSpotlightArtistRow = SpotlightArtistColumns & {
  id: string;
  slot: StudioSpotlightSlot;
  position: number;
  note: string | null;
  created_at: Date;
  is_listenable: boolean;
};

export type AdminSpotlightArtistOptionRow = SpotlightArtistColumns & {
  latest_release_title: string | null;
  is_in_artist_of_the_month: boolean;
  is_in_new_stars: boolean;
};

export function toAdminStudioSpotlightArtist(
  row: AdminSpotlightArtistRow,
): AdminStudioSpotlightArtist {
  return {
    id: row.id,
    slot: row.slot,
    position: row.position,
    note: row.note,
    createdAt: row.created_at.toISOString(),
    isListenable: row.is_listenable,
    artist: artistRefFromColumns(personaColumnsFromRow(row, 'artist')),
  };
}

/** Splits the read by slot and keeps the order the read already gives. */
export function groupAdminSpotlight(
  artists: AdminStudioSpotlightArtist[],
): AdminStudioSpotlight {
  return {
    artistOfTheMonth:
      artists.find((artist) => artist.slot === 'artist_of_the_month') ?? null,
    newStars: artists.filter((artist) => artist.slot === 'new_stars'),
  };
}

export function toAdminStudioSpotlightArtistOption(
  row: AdminSpotlightArtistOptionRow,
): AdminStudioSpotlightArtistOption {
  return {
    artist: artistRefFromColumns(personaColumnsFromRow(row, 'artist')),
    latestReleaseTitle: row.latest_release_title,
    isInArtistOfTheMonth: row.is_in_artist_of_the_month,
    isInNewStars: row.is_in_new_stars,
  };
}
