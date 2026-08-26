import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import {
  ListingCoManager,
  ListingCoManagerStatus,
} from '../listings/entities/listing-co-manager.entity';
import { Listing } from '../listings/entities/listing.entity';
import { SAFE_SPACE_REQUIRED_INDEPENDENT_VISITS } from '../safe-space-nominations/safe-space-policy';
import { SafeSpaceMemberVouch } from './entities/safe-space-vouch.entity';

/** What the review panel is shown about the three-visit bar for one space. */
export interface IndependentVisitTally {
  listingId: string;
  /** Distinct members whose vouch counts as an independent visit. */
  independentVisitCount: number;
  /** Always {@link SAFE_SPACE_REQUIRED_INDEPENDENT_VISITS}; carried on the
   * payload so the console never hardcodes the promise a second time. */
  requiredVisitCount: number;
  hasMetVisitBar: boolean;
  /**
   * Active vouches that were NOT counted because the voucher is not
   * independent of the place. Surfaced so a moderator can see the difference
   * between "nobody has been" and "only the people with a stake have been".
   */
  notIndependentVouchCount: number;
}

/**
 * Turns safe-space vouches into the "three independent member visits" the
 * published copy promises.
 *
 * A vouch was already a real, member-written record that a member has been to
 * a place; it just had no effect on anything. It IS the visit record, so this
 * counts it as one rather than inventing a second, parallel thing for a member
 * to fill in.
 *
 * INDEPENDENT means the voucher has no stake in the badge:
 *  - not the listing's owner (already refused at write time by
 *    `SafeSpaceVouchesService`, re-checked here because a listing can change
 *    hands after a vouch is written),
 *  - not an active co-manager of the listing,
 *  - not the member who nominated the place. A nominator vouching for their own
 *    nomination is one person counted twice, which is exactly the failure the
 *    three-visit bar exists to prevent.
 *
 * Withdrawn vouches never count. Nothing here awards anything: it reports a
 * number to a human, who decides.
 */
@Injectable()
export class SafeSpaceVisitsService {
  constructor(
    @InjectRepository(SafeSpaceMemberVouch)
    private readonly memberVouches: Repository<SafeSpaceMemberVouch>,
    @InjectRepository(Listing)
    private readonly listings: Repository<Listing>,
    @InjectRepository(ListingCoManager)
    private readonly coManagers: Repository<ListingCoManager>,
  ) {}

  /** The tally for one listing. `nominatorId` is the member who nominated it,
   * when the tally is being taken for a nomination. */
  async tallyForListing(
    listingId: string,
    nominatorId?: string | null,
  ): Promise<IndependentVisitTally> {
    const byListing = await this.tallyForListings(
      new Map([[listingId, nominatorId ?? null]]),
    );
    return byListing.get(listingId) ?? emptyTally(listingId);
  }

  /**
   * The tally for many listings at once, keyed by listing id, with each
   * listing's nominator (or null). Three queries whatever the page size, so
   * the admin queue never fans out per row.
   */
  async tallyForListings(
    nominatorByListingId: Map<string, string | null>,
  ): Promise<Map<string, IndependentVisitTally>> {
    const listingIds = [...nominatorByListingId.keys()];
    const tallies = new Map<string, IndependentVisitTally>();
    if (!listingIds.length) return tallies;

    const [vouches, listings, coManagerRows] = await Promise.all([
      this.memberVouches.find({
        where: { listingId: In(listingIds), withdrawnAt: IsNull() },
        select: { listingId: true, voucherId: true },
      }),
      this.listings.find({
        where: { id: In(listingIds) },
        select: { id: true, ownerId: true },
      }),
      this.coManagers.find({
        where: {
          listingId: In(listingIds),
          status: ListingCoManagerStatus.Active,
        },
        select: { listingId: true, userId: true },
      }),
    ]);

    const stakeholdersByListing = new Map<string, Set<string>>();
    const addStakeholder = (listingId: string, userId: string | null) => {
      if (!userId) return;
      const existing =
        stakeholdersByListing.get(listingId) ?? new Set<string>();
      existing.add(userId);
      stakeholdersByListing.set(listingId, existing);
    };
    for (const listingId of listingIds) {
      addStakeholder(listingId, nominatorByListingId.get(listingId) ?? null);
    }
    for (const listing of listings) {
      addStakeholder(listing.id, listing.ownerId);
    }
    for (const coManager of coManagerRows) {
      addStakeholder(coManager.listingId, coManager.userId);
    }

    for (const listingId of listingIds) {
      tallies.set(listingId, emptyTally(listingId));
    }
    for (const vouch of vouches) {
      const tally = tallies.get(vouch.listingId);
      if (!tally) continue;
      const isStakeholder = stakeholdersByListing
        .get(vouch.listingId)
        ?.has(vouch.voucherId);
      if (isStakeholder) {
        tally.notIndependentVouchCount += 1;
        continue;
      }
      tally.independentVisitCount += 1;
    }
    for (const tally of tallies.values()) {
      tally.hasMetVisitBar =
        tally.independentVisitCount >= SAFE_SPACE_REQUIRED_INDEPENDENT_VISITS;
    }
    return tallies;
  }
}

function emptyTally(listingId: string): IndependentVisitTally {
  return {
    listingId,
    independentVisitCount: 0,
    requiredVisitCount: SAFE_SPACE_REQUIRED_INDEPENDENT_VISITS,
    hasMetVisitBar: false,
    notIndependentVouchCount: 0,
  };
}
