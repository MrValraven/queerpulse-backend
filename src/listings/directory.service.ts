import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Brackets,
  In,
  IsNull,
  MoreThanOrEqual,
  Not,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { isUniqueViolation } from '../common/db-errors';
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
import {
  SafeSpaceMemberVouch,
  safeSpaceVouchByline,
} from '../safe-space-vouches/entities/safe-space-vouch.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { ListDirectoryQuery } from './dto/list-directory.query';
import { ListingReview } from './entities/listing-review.entity';
import {
  Listing,
  ListingStatus,
  SafeSpaceStatus,
  type SafeSpaceVouch,
} from './entities/listing.entity';
import {
  AnySafeSpaceDetailDTO,
  DirectoryCardDTO,
  DirectoryDetailDTO,
  PartnerSpaceDTO,
  RemovedSpaceCardDTO,
  ReviewAuthor,
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
    @InjectRepository(SafeSpaceMemberVouch)
    private readonly memberVouches: Repository<SafeSpaceMemberVouch>,
    private readonly contentModeration: ContentModerationService,
    private readonly notifications: NotificationsService,
  ) {}

  // A directory business is reported (and taken down) under either the
  // `business` code (what the directory's own report control sends) or the
  // `listing` code, both keyed by the listing slug. Reads check both.
  private static readonly SUBJECT_TYPES = ['business', 'listing'];

  // A review is reported (and taken down) under the `review` code, keyed by the
  // review's uuid. A hidden OR removed review is dropped from every public
  // review read here — the directory is a public marketing surface with no
  // per-viewer staff role, so a takedown withholds the review from everyone (a
  // removed review isn't rendered as a tombstone here the way a post is; it just
  // vanishes, keeping the star aggregate honest).
  private static readonly REVIEW_SUBJECT_TYPE = 'review';

  // NOT EXISTS predicate dropping any review under a `review` takedown (hidden
  // OR removed) from a review query builder, in-query so pagination/aggregates
  // stay consistent. `reviewIdColumn` is spliced verbatim into raw SQL, so pass
  // an actual column reference (never user input); it is cast to text because
  // `content_moderation.subject_id` is varchar while a review id is uuid. Mirrors
  // `excludeModeratedListings` and `ContentModerationService.excludeHidden`.
  private excludeModeratedReviews(
    qb: SelectQueryBuilder<ListingReview>,
    reviewIdColumn: string,
  ): void {
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "content_moderation" "cmr"
        WHERE "cmr"."subject_type" = :reviewSubjectType
          AND "cmr"."subject_id" = ${reviewIdColumn}::text
          AND ("cmr"."hidden_at" IS NOT NULL OR "cmr"."removed_at" IS NOT NULL)
      )`,
      { reviewSubjectType: DirectoryService.REVIEW_SUBJECT_TYPE },
    );
  }

  // Post-query variant for the `find`-based review reads that already hold rows
  // (`getDirectoryBySlug`, `getSafeSpaceBySlug`). Drops any review carrying a
  // `review` takedown so it never renders and never skews the derived rating.
  private async dropModeratedReviews(
    reviews: ListingReview[],
  ): Promise<ListingReview[]> {
    if (!reviews.length) return reviews;
    const states = await this.contentModeration.statesFor(
      DirectoryService.REVIEW_SUBJECT_TYPE,
      reviews.map((review) => review.id),
    );
    return reviews.filter((review) => {
      const state = states.get(review.id);
      return !state || (!state.hidden && !state.removed);
    });
  }

  // Excludes moderator-taken-down listings from a directory query, in-query so
  // the "showing X of Y" count stays consistent. The directory is a public
  // marketing surface with no per-viewer staff role — a takedown hides the
  // business from everyone here; the owner still manages it through the
  // owner/admin routes, which do not go through this service.
  private excludeModeratedListings(qb: SelectQueryBuilder<Listing>): void {
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "content_moderation" "cm"
        WHERE "cm"."subject_type" IN (:...listingSubjectTypes)
          AND "cm"."subject_id" = listing.slug
          AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)
      )`,
      { listingSubjectTypes: DirectoryService.SUBJECT_TYPES },
    );
  }

  // Post-query variant for the `find`-based reads (`listByMemberSlug`,
  // `listSafeSpaces`, `listPartnerSpaces`) that don't build a querybuilder.
  // Drops any listing whose slug carries a takedown.
  private async dropModeratedListings<ListingLike extends { slug: string }>(
    rows: ListingLike[],
  ): Promise<ListingLike[]> {
    if (!rows.length) return rows;
    const states = await this.contentModeration.statesForAnyType(
      DirectoryService.SUBJECT_TYPES,
      rows.map((row) => row.slug),
    );
    return rows.filter((row) => {
      const state = states.get(row.slug);
      return !state || (!state.hidden && !state.removed);
    });
  }

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
    return (await this.dropModeratedListings(rows)).map(toPartnerSpace);
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

    if (query.safe === 'verified') {
      qb.andWhere('listing.safeSpaceStatus = :safeSpaceStatus', {
        safeSpaceStatus: SafeSpaceStatus.Verified,
      });
    }

    this.excludeModeratedListings(qb);

    // Verified safe spaces surface first regardless of `safe` filter (a
    // no-op when `safe=verified` already restricts the set to verified-only,
    // but keeps the default/unfiltered grid boosting them ahead of the
    // existing name order, which remains the tiebreaker). Boost happens in
    // the SQL `ORDER BY` — not a JS re-sort — so it stays correct across
    // `take`/pagination.
    const rows = await qb
      .orderBy(
        `CASE WHEN listing.safeSpaceStatus = '${SafeSpaceStatus.Verified}' THEN 0 ELSE 1 END`,
        'ASC',
      )
      .addOrderBy('listing.name', 'ASC')
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
    return (await this.dropModeratedListings(rows)).map(toDirectoryCard);
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
    const allReviews = await this.reviews.find({
      where: { listingId: listing.id },
      order: { helpful: 'DESC', createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    // Drop moderator-taken-down reviews before they reach the DTO or the derived
    // rating aggregate.
    const reviews = await this.dropModeratedReviews(allReviews);
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
    const reviewAuthors = await this.resolveReviewAuthors(reviews);
    const ownerSlug = await this.resolveOwnerSlug(listing);
    const memberVouches = await this.loadSafeSpaceMemberVouches(listing.id);
    return toDirectoryDetail(
      listing,
      reviews,
      upcoming,
      savedCount,
      reviewAuthors,
      ownerSlug,
      memberVouches,
    );
  }

  /**
   * The listing owner's public profile slug for the "View profile" deep link —
   * but only when they linked their profile (`linkToProfile`) AND their chosen
   * visibility exposes their identity. `anon`/`role` deliberately reveal no
   * clickable profile (mirrors `ownerIdentity`'s redaction in listing-response),
   * and an owner whose profile no longer exists resolves to `null`.
   */
  private async resolveOwnerSlug(listing: Listing): Promise<string | null> {
    if (
      !listing.linkToProfile ||
      listing.visibility === 'anon' ||
      listing.visibility === 'role'
    ) {
      return null;
    }
    const profile = await this.profiles.findOne({
      where: { userId: listing.ownerId },
      select: { slug: true },
    });
    return profile?.slug ?? null;
  }

  /**
   * Batch-resolve each review's author identity (profile slug + avatar), keyed
   * by `reviewerId`, so member-authored reviews carry a clickable name and a
   * real photo. Seeded/imported reviews (null `reviewerId`) and members whose
   * profile no longer exists are simply absent from the map — those rows render
   * with initials only, unlinked. One `IN (...)` query, never N+1.
   */
  private async resolveReviewAuthors(
    reviews: ListingReview[],
  ): Promise<Map<string, ReviewAuthor>> {
    const reviewerIds = [
      ...new Set(
        reviews
          .map((review) => review.reviewerId)
          .filter((id): id is string => id !== null),
      ),
    ];
    if (reviewerIds.length === 0) return new Map();
    const profiles = await this.profiles.find({
      where: { userId: In(reviewerIds) },
      select: { userId: true, slug: true, avatarUrl: true },
    });
    return new Map(
      profiles.map((profile) => [
        profile.userId,
        { slug: profile.slug, avatarUrl: profile.avatarUrl },
      ]),
    );
  }

  /**
   * The active member-written vouches for a space, resolved to the raw
   * `SafeSpaceVouch` display shape so `toDirectoryDetail`/`toSafeSpaceDetail`
   * can merge them alongside the moderator-curated jsonb vouches. Anonymous
   * rows never resolve a profile — the voucher's identity is shielded to a
   * generic name, matching the member-vouch module's anonymity guarantee. The
   * `note` is the vouch text; `byline` derives from the relationship;
   * `when` is a stable "Mon YYYY" label from the created date.
   */
  private async loadSafeSpaceMemberVouches(
    listingId: string,
  ): Promise<SafeSpaceVouch[]> {
    const rows = await this.memberVouches.find({
      where: { listingId, withdrawnAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
    if (rows.length === 0) return [];
    const namedVoucherIds = [
      ...new Set(
        rows.filter((row) => !row.anonymous).map((row) => row.voucherId),
      ),
    ];
    const profiles = namedVoucherIds.length
      ? await this.profiles.find({
          where: { userId: In(namedVoucherIds) },
          select: { userId: true, firstName: true, lastName: true },
        })
      : [];
    const profilesByUserId = new Map(
      profiles.map((profile) => [profile.userId, profile]),
    );
    const shieldedName = 'A QueerPulse member';
    return rows.map((row) => {
      const profile = row.anonymous
        ? undefined
        : profilesByUserId.get(row.voucherId);
      const resolvedName = profile
        ? `${profile.firstName} ${profile.lastName}`.trim()
        : '';
      return {
        name: resolvedName || shieldedName,
        byline: safeSpaceVouchByline(row.relationship),
        text: row.note ?? '',
        when: row.createdAt.toLocaleDateString('en-US', {
          month: 'short',
          year: 'numeric',
        }),
      };
    });
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
    // In-query so a page comes back full and `total` counts only visible
    // reviews — filtering after a fixed-size fetch would under-fill the page and
    // (under OFFSET) permanently skip the review just past a taken-down one.
    this.excludeModeratedReviews(qb, 'review.id');
    return paginate(qb, normalizePage(page), async (rows) => {
      const authors = await this.resolveReviewAuthors(rows);
      return rows.map((review) =>
        toReviewDTO(
          review,
          review.reviewerId ? (authors.get(review.reviewerId) ?? null) : null,
        ),
      );
    });
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
    let saved: ListingReview;
    try {
      saved = await this.reviews.save(
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
    } catch (error) {
      // One member gets one review per listing, guarded by the partial unique
      // index `UQ_listing_reviews_reviewer` (member reviews only). A duplicate
      // submit — a double-tap or a rating-spam attempt — surfaces as a clean 409
      // instead of a 500. Mirrors `SavedService.add`'s 23505 handling.
      if (isUniqueViolation(error, 'UQ_listing_reviews_reviewer')) {
        throw new ConflictException('You have already reviewed this listing.');
      }
      throw error;
    }
    // Tell the listing's owner about the new review (skip a self-review, and
    // listings with no real owner). Best-effort; deep-links to the business
    // detail page via `slug`. Actor is the reviewer, so a blocked/muted
    // reviewer is filtered by `NotificationsService.create`.
    if (listing.ownerId && listing.ownerId !== userId) {
      try {
        await this.notifications.create(
          listing.ownerId,
          NotificationType.ListingReview,
          { actorId: userId, source: 'listing', listingSlug: listing.slug },
          userId,
        );
      } catch {
        // Intentionally ignored — the review already committed.
      }
    }
    // The author is the current member: reuse the profile already loaded above
    // so the freshly-returned row is immediately clickable + shows their photo.
    return toReviewDTO(
      saved,
      profile ? { slug: profile.slug, avatarUrl: profile.avatarUrl } : null,
    );
  }

  /**
   * Verified + removed safe spaces for the public Safe Spaces page. Only
   * `status = live` listings whose `safeSpaceStatus <> none` surface. Ratings
   * come from real reviews; `stats` feeds the page's hero numbers.
   */
  async listSafeSpaces(): Promise<SafeSpaceListDTO> {
    const allRows = await this.listings.find({
      where: {
        status: ListingStatus.Live,
        safeSpaceStatus: Not(SafeSpaceStatus.None),
      },
      order: { name: 'ASC' },
      take: DEFAULT_LIST_LIMIT,
    });
    const rows = await this.dropModeratedListings(allRows);
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
      const ratingsQb = this.reviews
        .createQueryBuilder('review')
        .select('review.listing_id', 'listingId')
        .addSelect('COUNT(*)', 'reviewCount')
        .addSelect('SUM(review.stars)', 'starSum')
        .where('review.listing_id IN (:...verifiedListingIds)', {
          verifiedListingIds: verifiedListings.map((listing) => listing.id),
        })
        .groupBy('review.listing_id');
      // Keep the safe-space card rating consistent with the detail page: a
      // taken-down review must not count toward the COUNT/AVG here either.
      this.excludeModeratedReviews(ratingsQb, 'review.id');
      const ratingRows = await ratingsQb.getRawMany<{
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
    await this.assertNotModerated(slug);
    if (listing.safeSpaceStatus === SafeSpaceStatus.Removed) {
      return toRemovedSpaceDetail(listing);
    }
    // Bounded like `getDirectoryBySlug`: the safe-space card derives its rating
    // aggregate from this same array, so the cap sits above any real listing's
    // review count rather than truncating to a short preview.
    const allReviews = await this.reviews.find({
      where: { listingId: listing.id },
      order: { helpful: 'DESC', createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    const reviews = await this.dropModeratedReviews(allReviews);
    const memberVouches = await this.loadSafeSpaceMemberVouches(listing.id);
    return toSafeSpaceDetail(listing, reviews, memberVouches);
  }

  private async loadLiveOr404(slug: string): Promise<Listing> {
    const listing = await this.listings.findOne({
      where: { slug, status: ListingStatus.Live },
    });
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
    await this.assertNotModerated(slug);
    return listing;
  }

  // 404s a taken-down listing on the public detail/review paths — same
  // don't-leak-existence posture as an in-review listing. Shared chokepoint for
  // `getDirectoryBySlug`, `listReviews`, `addReview`, and `getSafeSpaceBySlug`.
  private async assertNotModerated(slug: string): Promise<void> {
    const states = await this.contentModeration.statesForAnyType(
      DirectoryService.SUBJECT_TYPES,
      [slug],
    );
    const state = states.get(slug);
    if (state && (state.hidden || state.removed)) {
      throw new NotFoundException('Listing not found');
    }
  }
}
