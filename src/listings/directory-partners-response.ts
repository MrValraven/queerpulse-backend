import type { DirectoryPartnerPick } from './entities/directory-partner-pick.entity';
import type { DirectoryPartnerPublicState } from './directory-partners.constants';
import type { Listing } from './entities/listing.entity';
import {
  type DirectoryTint,
  initialsForName,
  tintForSlug,
  toCoverPhoto,
} from './listing-response';

/** One partner in the admin list. Carries no creator field. */
export interface AdminDirectoryPartnerDTO {
  /** The pick id. */
  id: string;
  listingId: string;
  /** For linking to `/admin/listings/:ref`. */
  listingRef: string;
  slug: string;
  name: string;
  cat: string;
  hood: string;
  /** The image the public card shows: the owner's own cover, then the first
   *  gallery photo, `null` when the listing has neither. */
  coverImage: string | null;
  tint: DirectoryTint;
  av: string;
  note: string | null;
  position: number;
  publicState: DirectoryPartnerPublicState;
}

/** One row of the admin picker search. */
export interface AdminDirectoryPartnerSearchResultDTO {
  listingId: string;
  slug: string;
  name: string;
  cat: string;
  hood: string;
  tint: DirectoryTint;
  av: string;
  isPartner: boolean;
}

/** The columns the picker search reads from a listing. */
export type ListedListingSearchRow = Pick<
  Listing,
  'id' | 'slug' | 'name' | 'cats' | 'hood'
>;

export function toAdminDirectoryPartner(
  pick: Pick<DirectoryPartnerPick, 'id' | 'note' | 'position'>,
  listing: Listing,
  publicState: DirectoryPartnerPublicState,
): AdminDirectoryPartnerDTO {
  return {
    id: pick.id,
    listingId: listing.id,
    listingRef: listing.ref,
    slug: listing.slug,
    name: listing.name,
    cat: listing.cats[0] ?? '',
    hood: listing.hood,
    coverImage: toCoverPhoto(listing)?.image ?? null,
    tint: tintForSlug(listing.slug),
    av: initialsForName(listing.name),
    note: pick.note,
    position: pick.position,
    publicState,
  };
}

export function toAdminDirectoryPartnerSearchResult(
  row: ListedListingSearchRow,
  isPartner: boolean,
): AdminDirectoryPartnerSearchResultDTO {
  return {
    listingId: row.id,
    slug: row.slug,
    name: row.name,
    cat: row.cats[0] ?? '',
    hood: row.hood,
    tint: tintForSlug(row.slug),
    av: initialsForName(row.name),
    isPartner,
  };
}
