import { EntityManager, In } from 'typeorm';
import { MediaCropService } from '../media-crops/media-crops.service';
import { ListingTeamMemberStatus } from './entities/listing-team-member.entity';
import { Listing } from './entities/listing.entity';
import { listingCardPhotoKeys } from './listing-response';
import {
  LISTING_TEAM_LISTING_COLUMNS,
  toListingTeamListing,
  toListingWorksAt,
  type ListingWorksAt,
} from './listing-team-response';
import {
  notAdultListingSql,
  publiclyVisibleListingSql,
} from './listing-team-visibility';

/** The most listings one persona view names under "works at". */
export const WORKS_AT_LIMIT = 10;

interface WorksAtLinkRow {
  listing_id: string;
  role_label: string | null;
}

/**
 * The listings a persona works at, as its public view shows them: accepted
 * links to publicly visible listings, oldest answer first, at most
 * `WORKS_AT_LIMIT`. An 18+ listing appears only to an active member viewer.
 * The caller decides first whether the viewer may see the persona at all.
 *
 * Two reads: the ordered links, then the listings they name, plus one crop
 * lookup. A persona with no links reads nothing past the first query.
 */
export async function loadWorksAt(
  manager: EntityManager,
  mediaCropService: MediaCropService,
  subprofileId: string,
  isActiveMemberViewer: boolean,
): Promise<ListingWorksAt[]> {
  const conditions = [
    `"member"."subprofile_id" = $1`,
    `"member"."status" = '${ListingTeamMemberStatus.Accepted}'`,
    publiclyVisibleListingSql('listing'),
  ];
  if (!isActiveMemberViewer) {
    conditions.push(notAdultListingSql('listing'));
  }
  const linkRows = await manager.query<WorksAtLinkRow[]>(
    `SELECT "member"."listing_id", "member"."role_label"
       FROM "listing_team_members" "member"
      INNER JOIN "listings" "listing" ON "listing"."id" = "member"."listing_id"
      WHERE ${conditions.join(' AND ')}
      ORDER BY "member"."answered_at" ASC, "member"."id" ASC
      LIMIT ${WORKS_AT_LIMIT}`,
    [subprofileId],
  );
  if (linkRows.length === 0) {
    return [];
  }
  const listings = await manager.find(Listing, {
    select: LISTING_TEAM_LISTING_COLUMNS,
    where: { id: In(linkRows.map((linkRow) => linkRow.listing_id)) },
  });
  const crops = await mediaCropService.getMany(
    listings.flatMap(listingCardPhotoKeys),
  );
  const listingsById = new Map(
    listings.map((listing) => [listing.id, listing]),
  );
  const worksAt: ListingWorksAt[] = [];
  for (const linkRow of linkRows) {
    const listing = listingsById.get(linkRow.listing_id);
    if (!listing) continue;
    worksAt.push(
      toListingWorksAt(
        toListingTeamListing(listing, crops),
        linkRow.role_label,
      ),
    );
  }
  return worksAt;
}
