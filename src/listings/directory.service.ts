import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import { MemberLookup } from '../common/member-ref';
import {
  DEFAULT_LIST_LIMIT,
  normalizePage,
  paginate,
  Paginated,
} from '../common/pagination';
import { Event, EventStatus } from '../events/entities/event.entity';
import { SavedItem, SavedKind } from '../saved/entities/saved-item.entity';
import { Profile } from '../users/entities/profile.entity';
import { CreateReviewDto } from './dto/create-review.dto';
import { ListDirectoryQuery } from './dto/list-directory.query';
import { ListingReview } from './entities/listing-review.entity';
import {
  Listing,
  ListingStatus,
  SafeSpaceStatus,
} from './entities/listing.entity';
import {
  AnySafeSpaceDetailDTO,
  DirectoryCardDTO,
  DirectoryDetailDTO,
  PartnerSpaceDTO,
  RemovedSpaceCardDTO,
  ReviewDTO,
  SafeSpaceCardDTO,
  SafeSpaceListDTO,
  toDirectoryCard,
  toDirectoryDetail,
  toPartnerSpace,
  toRemovedSpaceCard,
  toRemovedSpaceDetail,
  toReviewDTO,
  toSafeSpaceCard,
  toSafeSpaceDetail,
} from './listing-response';

/**
 * Public, read-only views over the `listings` (businesses) table for the
 * marketing surfaces — the host page's partner spaces here, and the
 * `/local/directory` grid + detail in later sub-projects. Kept separate from
 * `ListingsService` (which is the owner-scoped submission-tracking surface) so
 * the growing public read logic — filters, ratings, event joins — has its own
 * home and never accidentally exposes owner/moderation fields.
 */
@Injectable()
export class DirectoryService {
  constructor(
    @InjectRepository(Listing) private readonly listings: Repository<Listing>,
    @InjectRepository(ListingReview)
    private readonly reviews: Repository<ListingReview>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(SavedItem)
    private readonly savedItems: Repository<SavedItem>,
  ) {}

  /**
   * Every live listing flagged as a QueerPulse partner venue, for the public
   * host page. Only `status = live` rows surface — a listing still in review
   * must never appear as a partner space even if the flag is set.
   */
  async listPartnerSpaces(): Promise<PartnerSpaceDTO[]> {
    const rows = await this.listings.find({
      where: {
        status: ListingStatus.Live,
        isPartneredWithQueerpulse: true,
      },
      order: { name: 'ASC' },
      take: DEFAULT_LIST_LIMIT,
    });
    return rows.map(toPartnerSpace);
  }

  /**
   * Every live listing for the public `/local/directory` grid, optionally
   * filtered by category and free-text search. Returns the full result set
   * (the directory is a curated, bounded city registry and the frontend renders
   * a "showing X of Y" count over all of it) rather than a page.
   */
  async listDirectory(query: ListDirectoryQuery): Promise<DirectoryCardDTO[]> {
    const qb = this.listings
      .createQueryBuilder('listing')
      .where('listing.status = :status', { status: ListingStatus.Live });

    if (query.cat) {
      // `cats` is a text[] column — match when the category is one of its values.
      qb.andWhere(':cat = ANY(listing.cats)', { cat: query.cat });
    }

    if (query.q) {
      const term = `%${escapeLikeTerm(query.q.trim().toLowerCase())}%`;
      qb.andWhere(
        new Brackets((where) => {
          where
            .where('LOWER(listing.name) LIKE :term', { term })
            .orWhere('LOWER(listing.blurb) LIKE :term', { term })
            .orWhere('LOWER(listing.hood) LIKE :term', { term });
        }),
      );
    }

    const rows = await qb
      .orderBy('listing.name', 'ASC')
      .take(DEFAULT_LIST_LIMIT)
      .getMany();
    return rows.map(toDirectoryCard);
  }

  /**
   * Every live directory listing owned by one member, addressed by the member's
   * profile slug — backs the "businesses run by <member>" strip on public
   * profiles. Returns the SAME redacted `DirectoryCardDTO` shape as the public
   * grid (never the owner-scoped `ListingDTO`, which carries contact/consent
   * PII). An unknown or inactive slug simply yields an empty array (200): a
   * member may run no listings, so this is not a 404 case.
   */
  async listByMemberSlug(memberSlug: string): Promise<DirectoryCardDTO[]> {
    const ownerUserId = await new MemberLookup(this.profiles).userIdForSlug(
      memberSlug,
    );
    if (!ownerUserId) return [];

    const rows = await this.listings.find({
      where: { ownerId: ownerUserId, status: ListingStatus.Live },
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    return rows.map(toDirectoryCard);
  }

  /**
   * One live directory listing by slug, for the detail page. 404s unless the
   * listing exists AND is live — a listing still in review must never be
   * reachable through the public directory even if its slug is guessed.
   */
  async getDirectoryBySlug(slug: string): Promise<DirectoryDetailDTO> {
    const listing = await this.loadLiveOr404(slug);
    // Bounded: the detail card embeds the review list AND derives its rating
    // aggregate from this same array, so `take` must sit well above any real
    // listing's review count (DEFAULT_LIST_LIMIT is sized for exactly that) to
    // avoid skewing the rating — full pagination is served separately by
    // `listReviews`. Order matches `listReviews` (most-helpful, then newest).
    const reviews = await this.reviews.find({
      where: { listingId: listing.id },
      order: { helpful: 'DESC', createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    // Upcoming, published events at this venue — soonest first, capped so the
    // sidebar card stays short. `new Date()` here is server "now" at request
    // time (not a cached value), which is exactly the cutoff we want.
    const upcoming = await this.events.find({
      where: {
        listingId: listing.id,
        status: EventStatus.Published,
        startAt: MoreThanOrEqual(new Date()),
      },
      order: { startAt: 'ASC' },
      take: 4,
    });
    // How many members bookmarked this listing — `subjectId` is the listing
    // SLUG (the frontend's Save button builds `listing:${slug}` as the
    // composite ref; see `DirectoryActionBar.tsx`), not the `ref`/uuid.
    const savedCount = await this.savedItems.count({
      where: { subjectType: SavedKind.Listing, subjectId: listing.slug },
    });
    return toDirectoryDetail(listing, reviews, upcoming, savedCount);
  }

  /** Paginated reviews for one live listing. */
  async listReviews(
    slug: string,
    page?: number,
  ): Promise<Paginated<ReviewDTO>> {
    const listing = await this.loadLiveOr404(slug);
    const qb = this.reviews
      .createQueryBuilder('review')
      .where('review.listing_id = :listingId', { listingId: listing.id })
      .orderBy('review.helpful', 'DESC')
      .addOrderBy('review.created_at', 'DESC');
    return paginate(qb, normalizePage(page), (rows) => rows.map(toReviewDTO));
  }

  /**
   * Submit a review as the current member. The author's name/pronouns are
   * snapshotted from their profile at submit time so the review reads
   * consistently even if they later edit their profile.
   */
  async addReview(
    slug: string,
    userId: string,
    dto: CreateReviewDto,
  ): Promise<ReviewDTO> {
    const listing = await this.loadLiveOr404(slug);
    const profile = await this.profiles.findOne({ where: { userId } });
    const reviewerName = profile
      ? `${profile.firstName} ${profile.lastName}`.trim()
      : 'A QueerPulse member';
    const saved = await this.reviews.save(
      this.reviews.create({
        listingId: listing.id,
        reviewerId: userId,
        reviewerName,
        byline: profile?.pronouns ?? '',
        stars: dto.stars,
        text: dto.text,
        helpful: 0,
      }),
    );
    return toReviewDTO(saved);
  }

  /**
   * Verified + removed safe spaces for the public Safe Spaces page. Only
   * `status = live` listings whose `safeSpaceStatus <> none` surface. Ratings
   * come from real reviews; `stats` feeds the page's hero numbers.
   */
  async listSafeSpaces(): Promise<SafeSpaceListDTO> {
    const rows = await this.listings.find({
      where: {
        status: ListingStatus.Live,
        safeSpaceStatus: Not(SafeSpaceStatus.None),
      },
      order: { name: 'ASC' },
      take: DEFAULT_LIST_LIMIT,
    });
    // The card's rating only needs a per-listing COUNT + AVG of stars (never the
    // review bodies), so aggregate in ONE grouped query — O(verified listings),
    // not O(reviews). This stays bounded no matter how large the review corpus
    // grows, unlike loading every verified listing's full review rows. COUNT/SUM
    // come back as bigint strings; we recompute the score with the SAME
    // `sum / count` arithmetic `ratingFromReviews` uses so the numbers are
    // byte-identical to fetching the rows.
    const verifiedListings = rows.filter(
      (listing) => listing.safeSpaceStatus === SafeSpaceStatus.Verified,
    );
    const ratingByListingId = new Map<
      string,
      { count: number; starSum: number }
    >();
    if (verifiedListings.length > 0) {
      const ratingRows = await this.reviews
        .createQueryBuilder('review')
        .select('review.listing_id', 'listingId')
        .addSelect('COUNT(*)', 'reviewCount')
        .addSelect('SUM(review.stars)', 'starSum')
        .where('review.listing_id IN (:...verifiedListingIds)', {
          verifiedListingIds: verifiedListings.map((listing) => listing.id),
        })
        .groupBy('review.listing_id')
        .getRawMany<{
          listingId: string;
          reviewCount: string;
          starSum: string;
        }>();
      for (const ratingRow of ratingRows) {
        ratingByListingId.set(ratingRow.listingId, {
          count: Number(ratingRow.reviewCount),
          starSum: Number(ratingRow.starSum),
        });
      }
    }

    const verified: SafeSpaceCardDTO[] = [];
    const removed: RemovedSpaceCardDTO[] = [];
    let reviewTotal = 0;
    for (const listing of rows) {
      if (listing.safeSpaceStatus === SafeSpaceStatus.Verified) {
        // `toSafeSpaceCard` derives `rating`/`reviews` from the passed array;
        // we feed it `[]` (yielding the score '0' / count 0 baseline) and then
        // overwrite exactly those two fields from the aggregate. No other card
        // field depends on reviews, so this reproduces the row-fetch result.
        const card = toSafeSpaceCard(listing, []);
        const rating = ratingByListingId.get(listing.id);
        if (rating) {
          card.rating = (rating.starSum / rating.count).toFixed(1);
          card.reviews = rating.count;
          reviewTotal += rating.count;
        }
        verified.push(card);
      } else {
        removed.push(toRemovedSpaceCard(listing));
      }
    }
    return {
      verified,
      removed,
      stats: {
        verified: verified.length,
        reviews: reviewTotal,
        removed: removed.length,
      },
    };
  }

  /** One safe space (verified or removed) by slug. 404 unless live + safe. */
  async getSafeSpaceBySlug(slug: string): Promise<AnySafeSpaceDetailDTO> {
    const listing = await this.listings.findOne({
      where: { slug, status: ListingStatus.Live },
    });
    if (!listing || listing.safeSpaceStatus === SafeSpaceStatus.None) {
      throw new NotFoundException('Safe space not found');
    }
    if (listing.safeSpaceStatus === SafeSpaceStatus.Removed) {
      return toRemovedSpaceDetail(listing);
    }
    // Bounded like `getDirectoryBySlug`: the safe-space card derives its rating
    // aggregate from this same array, so the cap sits above any real listing's
    // review count rather than truncating to a short preview.
    const reviews = await this.reviews.find({
      where: { listingId: listing.id },
      order: { helpful: 'DESC', createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    return toSafeSpaceDetail(listing, reviews);
  }

  private async loadLiveOr404(slug: string): Promise<Listing> {
    const listing = await this.listings.findOne({
      where: { slug, status: ListingStatus.Live },
    });
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
    return listing;
  }
}
