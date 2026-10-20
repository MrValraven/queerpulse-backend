import { HttpException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { Repository } from 'typeorm';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { Community } from '../communities/entities/community.entity';
import {
  ListingCoManager,
  ListingCoManagerStatus,
} from '../listings/entities/listing-co-manager.entity';
import { Listing, ListingStatus } from '../listings/entities/listing.entity';
import { CREATOR_DRAFT_LIMITS } from './creator-drafts.constants';

/** The shape `ListingsService.nextRef` mints: `QPL-<year>-<sequence>`, the
 *  sequence zero-padded to at least four digits (`QPL-2026-0007`). */
const LISTING_REF_PATTERN = /^QPL-\d{4}-\d{4,}$/;

/** True for a string shaped like a listing ref and short enough to look up. */
export function isListingRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= CREATOR_DRAFT_LIMITS.listingRefMaxLength &&
    LISTING_REF_PATTERN.test(value)
  );
}

export interface DraftRef {
  id: string;
  slug: string;
  name: string;
}

export interface ManageableListing {
  id: string;
  ref: string;
  slug: string;
  name: string;
  isLive: boolean;
}

export interface EventDraftRefs {
  community: DraftRef | null;
  runByListing: DraftRef | null;
  venueListing: DraftRef | null;
  madeForCommunityId: string | null;
  madeForListingId: string | null;
}

/**
 * Resolves what an event draft is made for. The payload is written by the
 * creator, so every claim is checked against the author: a community counts
 * only when the author is on its roster, a listing only when the author owns
 * it or actively co-manages it. A claim that fails the check is dropped.
 */
@Injectable()
export class CreatorDraftMadeForService {
  constructor(
    private readonly membership: CommunityMembershipService,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(Listing)
    private readonly listings: Repository<Listing>,
    @InjectRepository(ListingCoManager)
    private readonly coManagers: Repository<ListingCoManager>,
  ) {}

  async resolveEventRefs(
    authorId: string,
    payload: Record<string, unknown>,
  ): Promise<EventDraftRefs> {
    const community = await this.resolveCommunity(
      authorId,
      payload.communitySlug,
    );
    const runByListing = await this.resolveListingRef(
      authorId,
      payload.runByListingId,
    );
    const venueListing = await this.resolveListingRef(
      authorId,
      payload.venueListingId,
    );
    return {
      community,
      runByListing,
      venueListing,
      madeForCommunityId: community?.id ?? null,
      madeForListingId: community
        ? null
        : ((runByListing ?? venueListing)?.id ?? null),
    };
  }

  /** A ref of any other shape (a NUL, a stray path segment) answers null
   *  before any query runs. */
  async findManageableListingByRef(
    userId: string,
    listingRef: string,
  ): Promise<ManageableListing | null> {
    if (!isListingRef(listingRef)) return null;
    const listing = await this.listings.findOne({ where: { ref: listingRef } });
    return this.toManageable(userId, listing);
  }

  /** The id of the listing behind a ref, whoever manages it. Only for keying
   *  the caller's own slot, so an author who lost management can still
   *  discard their draft. */
  async findListingIdByRef(listingRef: string): Promise<string | null> {
    if (!isListingRef(listingRef)) return null;
    const listing = await this.listings.findOne({
      where: { ref: listingRef },
      select: { id: true },
    });
    return listing?.id ?? null;
  }

  async findManageableListingById(
    userId: string,
    listingId: string,
  ): Promise<ManageableListing | null> {
    if (typeof listingId !== 'string' || !isUUID(listingId)) return null;
    const listing = await this.listings.findOne({ where: { id: listingId } });
    return this.toManageable(userId, listing);
  }

  private async toManageable(
    userId: string,
    listing: Listing | null,
  ): Promise<ManageableListing | null> {
    if (!listing || !(await this.canManage(userId, listing))) return null;
    return {
      id: listing.id,
      ref: listing.ref,
      slug: listing.slug,
      name: listing.name,
      isLive: listing.status === ListingStatus.Live,
    };
  }

  private async canManage(userId: string, listing: Listing): Promise<boolean> {
    if (listing.ownerId === userId) return true;
    const activeRows = await this.coManagers.count({
      where: {
        listingId: listing.id,
        userId,
        status: ListingCoManagerStatus.Active,
      },
    });
    return activeRows > 0;
  }

  private async resolveCommunity(
    authorId: string,
    rawSlug: unknown,
  ): Promise<DraftRef | null> {
    if (typeof rawSlug !== 'string') return null;
    const slug = rawSlug.trim();
    if (
      slug.length === 0 ||
      slug.length > CREATOR_DRAFT_LIMITS.communitySlugMaxLength
    ) {
      return null;
    }
    let communityId: string;
    try {
      communityId = await this.membership.assertMemberBySlug(slug, authorId);
    } catch (error) {
      if (error instanceof HttpException) return null;
      throw error;
    }
    const community = await this.communities.findOne({
      where: { id: communityId },
    });
    if (!community) return null;
    return { id: community.id, slug: community.slug, name: community.name };
  }

  private async resolveListingRef(
    authorId: string,
    rawListingId: unknown,
  ): Promise<DraftRef | null> {
    if (typeof rawListingId !== 'string' || !isUUID(rawListingId)) return null;
    const listing = await this.listings.findOne({
      where: { id: rawListingId },
    });
    if (!listing || !(await this.canManage(authorId, listing))) return null;
    return { id: listing.id, slug: listing.slug, name: listing.name };
  }
}
