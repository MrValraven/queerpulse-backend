import {
  DIRECTORY_PARTNER_NOTE_MAX,
  directoryPartnerError,
  type DirectoryPartnerPublicState,
} from './directory-partners.constants';
import {
  type Listing,
  ListingOperatingState,
  ListingStatus,
} from './entities/listing.entity';
import { isAdultListing } from './listing-categories';

/** Trims a partner note and stores a blank one as null. The length is counted
 *  in code points after trimming, which matches Postgres `varchar(140)`.
 *  Throws `note_too_long` past the limit. */
export function normalizePartnerNote(
  note: string | null | undefined,
): string | null {
  const trimmedNote = note?.trim();
  if (!trimmedNote) {
    return null;
  }
  if (Array.from(trimmedNote).length > DIRECTORY_PARTNER_NOTE_MAX) {
    throw directoryPartnerError('note_too_long');
  }
  return trimmedNote;
}

/** Whether a requested order names every current id exactly once. Ids are
 *  compared lowercase, the form Postgres hands a uuid back in. */
export function listsEveryIdOnce(
  currentIds: string[],
  requestedIds: string[],
): boolean {
  if (currentIds.length !== requestedIds.length) {
    return false;
  }
  const requestedSet = new Set(requestedIds.map((id) => id.toLowerCase()));
  return (
    requestedSet.size === requestedIds.length &&
    currentIds.every((id) => requestedSet.has(id.toLowerCase()))
  );
}

/**
 * Why a picked listing does or does not show in the public partner row. This
 * mirrors `status = live` plus `DirectoryService.PUBLICLY_LISTED` plus
 * `dropModeratedListings`, the public row's own filter. The first matching
 * reason wins: not live, closed for good, hidden by the owner, moderated,
 * then 18+. A temporarily closed or moved listing still shows, as it does in
 * the grid.
 */
export function partnerPublicStateOf(
  listing: Pick<
    Listing,
    'status' | 'operatingState' | 'isHiddenByOwner' | 'cats'
  >,
  isModerated: boolean,
): DirectoryPartnerPublicState {
  if (listing.status !== ListingStatus.Live) {
    return 'not_live';
  }
  if (listing.operatingState === ListingOperatingState.PermanentlyClosed) {
    return 'closed_for_good';
  }
  if (listing.isHiddenByOwner) {
    return 'hidden_by_owner';
  }
  if (isModerated) {
    return 'moderated';
  }
  if (isAdultListing(listing.cats)) {
    return 'adult_only';
  }
  return 'showing';
}
