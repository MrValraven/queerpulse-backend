import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { Event, EventStatus } from '../events/entities/event.entity';
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
      const term = `%${query.q.trim().toLowerCase()}%`;
      qb.andWhere(
        new Brackets((where) => {
          where
            .where('LOWER(listing.name) LIKE :term', { term })
            .orWhere('LOWER(listing.blurb) LIKE :term', { term })
            .orWhere('LOWER(listing.hood) LIKE :term', { term });
        }),
      );
    }

    const rows = await qb.orderBy('listing.name', 'ASC').getMany();
    return rows.map(toDirectoryCard);
  }

  /**
   * One live directory listing by slug, for the detail page. 404s unless the
   * listing exists AND is live — a listing still in review must never be
   * reachable through the public directory even if its slug is guessed.
   */
  async getDirectoryBySlug(slug: string): Promise<DirectoryDetailDTO> {
    const listing = await this.loadLiveOr404(slug);
    const reviews = await this.reviews.find({
      where: { listingId: listing.id },
      order: { helpful: 'DESC', createdAt: 'DESC' },
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
    return toDirectoryDetail(listing, reviews, upcoming);
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
    });
    // Fetch every verified listing's reviews in ONE query, then group by
    // listing id in memory — avoids an N+1 review query per verified listing.
    const verifiedListings = rows.filter(
      (listing) => listing.safeSpaceStatus === SafeSpaceStatus.Verified,
    );
    const reviewsByListingId = new Map<string, ListingReview[]>();
    if (verifiedListings.length > 0) {
      const allReviews = await this.reviews.find({
        where: { listingId: In(verifiedListings.map((listing) => listing.id)) },
      });
      for (const review of allReviews) {
        const bucket = reviewsByListingId.get(review.listingId) ?? [];
        bucket.push(review);
        reviewsByListingId.set(review.listingId, bucket);
      }
    }

    const verified: SafeSpaceCardDTO[] = [];
    const removed: RemovedSpaceCardDTO[] = [];
    let reviewTotal = 0;
    for (const listing of rows) {
      if (listing.safeSpaceStatus === SafeSpaceStatus.Verified) {
        const reviews = reviewsByListingId.get(listing.id) ?? [];
        reviewTotal += reviews.length;
        verified.push(toSafeSpaceCard(listing, reviews));
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
    const reviews = await this.reviews.find({
      where: { listingId: listing.id },
      order: { helpful: 'DESC', createdAt: 'DESC' },
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
