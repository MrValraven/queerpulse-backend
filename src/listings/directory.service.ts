import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Brackets,
  DataSource,
  EntityManager,
  In,
  IsNull,
  MoreThanOrEqual,
  Not,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { toImageUrl } from '../common/image-url';
import { StorageService } from '../storage/storage.service';
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
import { MediaCropService } from '../media-crops/media-crops.service';
import { SavedItem, SavedKind } from '../saved/entities/saved-item.entity';
import { Profile } from '../users/entities/profile.entity';
import {
  SafeSpaceMemberVouch,
  safeSpaceVouchByline,
} from '../safe-space-vouches/entities/safe-space-vouch.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { AskListingPublicQuestionDto } from './dto/ask-listing-public-question.dto';
import { CreateReviewDto } from './dto/create-review.dto';
import { ListDirectoryQuery } from './dto/list-directory.query';
import {
  ListingPublicQuestionDTO,
  ListingQuestionAsker,
  toListingPublicQuestionDTO,
} from './dto/listing-public-question.dto';
import { UpdateReviewDto } from './dto/update-review.dto';
import { ListingPublicQuestion } from './entities/listing-public-question.entity';
import { ListingReviewHelpfulVote } from './entities/listing-review-helpful-vote.entity';
import { ListingReview } from './entities/listing-review.entity';
import {
  Listing,
  ListingOperatingState,
  ListingStatus,
  SafeSpaceStatus,
  type SafeSpaceVouch,
} from './entities/listing.entity';
import {
  AnySafeSpaceDetailDTO,
  DIRECTORY_DETAIL_QUESTION_LIMIT,
  DirectoryCardDTO,
  DirectoryDetailDTO,
  MovedToListingView,
  PartnerSpaceDTO,
  RemovedSpaceCardDTO,
  ReviewAuthor,
  ReviewDTO,
  ReviewHelpfulDTO,
  SafeSpaceCardDTO,
  SafeSpaceListDTO,
  listingPhotoKeys,
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
    @InjectRepository(ListingReviewHelpfulVote)
    private readonly helpfulVotes: Repository<ListingReviewHelpfulVote>,
    @InjectRepository(ListingPublicQuestion)
    private readonly publicQuestions: Repository<ListingPublicQuestion>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(SavedItem)
    private readonly savedItems: Repository<SavedItem>,
    @InjectRepository(SafeSpaceMemberVouch)
    private readonly memberVouches: Repository<SafeSpaceMemberVouch>,
    private readonly contentModeration: ContentModerationService,
    private readonly notifications: NotificationsService,
    // Batched crop lookup (`MediaCropService.getMany`) for `photoGallery`'s
    // per-slot `photoCrops` sibling.
    private readonly mediaCropService: MediaCropService,
    // A review edit that replaces or clears its photo leaves the previous
    // object in the bucket serving forever otherwise. Best-effort delete, same
    // posture as `ListingsService.deleteOrphanedObjects`.
    private readonly storage: StorageService,
    // The helpful-vote write and the recount of `listing_reviews.helpful` are
    // two statements that must not be observable apart, so they run in one
    // transaction.
    private readonly dataSource: DataSource,
  ) {}

  private readonly logger = new Logger(DirectoryService.name);

  // Rate-limit constants for the public question box — see `askQuestion` for
  // what each one is actually defending against.
  private static readonly MAX_OPEN_QUESTIONS_PER_LISTING = 3;
  private static readonly MAX_QUESTIONS_PER_DAY = 10;
  private static readonly QUESTION_WINDOW_MS = 24 * 60 * 60 * 1000;
  // Post-trim floor, so `@MinLength(8)` cannot be satisfied with whitespace.
  private static readonly MIN_QUESTION_LENGTH = 8;

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

  // A public question (and the answer under it) is reported and taken down
  // under the `listing_public_question` code, keyed by the question's uuid.
  // Same posture as reviews above: the directory is a public marketing surface
  // with no per-viewer staff role, so a hidden OR removed question simply stops
  // rendering for everyone rather than leaving a tombstone. The question and its
  // answer move together — see `ReportSubjectType.ListingPublicQuestion` for
  // why one subject covers the pair.
  private static readonly QUESTION_SUBJECT_TYPE = 'listing_public_question';

  // In-query twin of `dropModeratedQuestions`, for the paginated question read.
  // Same contract as `excludeModeratedReviews`: `questionIdColumn` is spliced
  // verbatim into raw SQL, so pass a column reference and never user input, and
  // it is cast to text because `content_moderation.subject_id` is varchar while
  // a question id is uuid.
  private excludeModeratedQuestions(
    qb: SelectQueryBuilder<ListingPublicQuestion>,
    questionIdColumn: string,
  ): void {
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "content_moderation" "cmq"
        WHERE "cmq"."subject_type" = :questionSubjectType
          AND "cmq"."subject_id" = ${questionIdColumn}::text
          AND ("cmq"."hidden_at" IS NOT NULL OR "cmq"."removed_at" IS NOT NULL)
      )`,
      { questionSubjectType: DirectoryService.QUESTION_SUBJECT_TYPE },
    );
  }

  // Post-query variant for the `find`-based question read on the detail page,
  // mirroring `dropModeratedReviews` exactly.
  private async dropModeratedQuestions(
    questions: ListingPublicQuestion[],
  ): Promise<ListingPublicQuestion[]> {
    if (!questions.length) return questions;
    const states = await this.contentModeration.statesFor(
      DirectoryService.QUESTION_SUBJECT_TYPE,
      questions.map((question) => question.id),
    );
    return questions.filter((question) => {
      const state = states.get(question.id);
      return !state || (!state.hidden && !state.removed);
    });
  }

  // A business the owner has reported as PERMANENTLY closed is withdrawn from
  // every public result set: browse, search, the map, the by-member strip, the
  // partner-spaces card, the safe-spaces hub, and every count derived from
  // them. Its detail page still resolves (see `loadLiveOr404`), so existing
  // links, its reviews and its closure notice all survive; it simply stops
  // being offered as somewhere to go.
  //
  // `temporarily_closed` and `moved` are deliberately NOT excluded. Those
  // businesses still exist, and a reader looking for them is better served by
  // finding the listing with a "reopens in September" banner than by finding
  // nothing at all.
  //
  // Expressed as a `<>` predicate rather than an `IN (open, temporarily_closed,
  // moved)` allowlist so a future state added to the enum keeps appearing by
  // default: a new state should have to argue its way OUT of the directory,
  // not be silently dropped from it.
  //
  // A listing its OWNER has paused (`isHiddenByOwner`) is withdrawn from the
  // very same result sets, which is why both predicates live in this one
  // helper rather than as a second condition scattered alongside it. The two
  // answer different questions and must not be folded into each other:
  // `operating_state` is about whether the BUSINESS is trading, and
  // `is_hidden_by_owner` is about whether the owner is currently showing the
  // LISTING. A thriving business can pause its listing; a permanently closed
  // one can leave its listing up so its page and reviews stay where every
  // shared link points.
  //
  // Owner-hidden goes further than permanently-closed in one respect, and
  // deliberately so: it also withholds the DETAIL page (see `loadLiveOr404`).
  // A closed business keeps its page because every link, bookmark and review
  // points there and a 404 would erase the record. A paused listing has no
  // such claim on being readable: the owner asked for it not to be shown, and
  // leaving the page live would answer that request with "shown anyway,
  // just harder to find".
  private excludeHiddenFromDirectory(qb: SelectQueryBuilder<Listing>): void {
    qb.andWhere('listing.operatingState != :permanentlyClosedState', {
      permanentlyClosedState: ListingOperatingState.PermanentlyClosed,
    });
    qb.andWhere('listing.isHiddenByOwner = false');
  }

  // `find()`-option twin of `excludeHiddenFromDirectory` for the read paths
  // that do not build a query builder (`listPartnerSpaces`, `listByMemberSlug`,
  // `listSafeSpaces`, `resolveMovedToListing`). Spread into the `where` object
  // so the filters are applied IN the query, keeping any `take` honest.
  private static readonly PUBLICLY_LISTED = {
    operatingState: Not(ListingOperatingState.PermanentlyClosed),
    isHiddenByOwner: false,
  } as const;

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
        // A partner venue that shut for good is no longer a place anyone can
        // be hosted at, so it drops off the host page entirely, and a venue
        // whose owner paused the listing is not on offer either.
        ...DirectoryService.PUBLICLY_LISTED,
      },
      order: { name: 'ASC' },
      take: DEFAULT_LIST_LIMIT,
    });
    return (await this.dropModeratedListings(rows)).map(toPartnerSpace);
  }

  /**
   * Builds the shared `WHERE`/`ORDER BY` for the public directory grid — cat/
   * q/safe filters, the moderation takedown exclusion, and the
   * verified-safe-space-first ordering — factored out so both the bare
   * (`listDirectory`) and paginated (`listDirectoryPage`) read paths apply
   * IDENTICAL filtering/ordering and only differ in how the result set is
   * bounded (`take` vs `paginate`'s `skip`/`take`).
   */
  private buildDirectoryQuery(
    query: Pick<ListDirectoryQuery, 'cat' | 'q' | 'safe'>,
  ): SelectQueryBuilder<Listing> {
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
    // Applied here, in the ONE query both the bare list and the paginated page
    // share, so browse, category filters, free-text search, the map pins and
    // the "related places" strip all drop permanently closed businesses and
    // owner-paused listings together, and `listDirectoryPage`'s `total`
    // counts only what a visitor can actually reach.
    this.excludeHiddenFromDirectory(qb);

    // Verified safe spaces surface first regardless of `safe` filter (a
    // no-op when `safe=verified` already restricts the set to verified-only,
    // but keeps the default/unfiltered grid boosting them ahead of the
    // existing name order, which remains the tiebreaker). Boost happens in
    // the SQL `ORDER BY` — not a JS re-sort — so it stays correct across
    // `take`/pagination.
    return qb
      .orderBy(
        `CASE WHEN listing.safeSpaceStatus = '${SafeSpaceStatus.Verified}' THEN 0 ELSE 1 END`,
        'ASC',
      )
      .addOrderBy('listing.name', 'ASC');
  }

  /**
   * Every live listing for the public `/local/directory` grid, optionally
   * filtered by category and free-text search. Returns the full result set
   * capped at `DEFAULT_LIST_LIMIT` (never a `Paginated` envelope) — kept for
   * the frontend's whole-catalog callers (venue picker, @mention suggestions,
   * "related places", and `SearchService`'s cross-domain search) that need
   * the working set client-side rather than a browsable page. The
   * `/local/directory` grid itself instead calls `listDirectoryPage` (below)
   * when it wants real pagination — see `ListDirectoryQuery.page`'s doc
   * comment for why the two coexist.
   */
  async listDirectory(query: ListDirectoryQuery): Promise<DirectoryCardDTO[]> {
    const rows = await this.buildDirectoryQuery(query)
      .take(DEFAULT_LIST_LIMIT)
      .getMany();
    // ONE batched crop lookup for every card's cover photo on the page, never
    // a per-row query. `toDirectoryCard` is deliberately not passed straight to
    // `map`: the array index would arrive as its crop Map.
    const crops = await this.mediaCropService.getMany(
      rows.flatMap((row) => listingPhotoKeys(row)),
    );
    return rows.map((row) => toDirectoryCard(row, crops));
  }

  /**
   * Paginated variant of `listDirectory` backing the `/local/directory` grid
   * (HSG-5 of the 2026-08-20 gap audit): real `PAGE_SIZE`-at-a-time offset
   * pagination via the shared `paginate()` helper, with an honest `total`
   * across every matching row (not the old silent `DEFAULT_LIST_LIMIT` cap).
   * Same filters/ordering as `listDirectory` (shared `buildDirectoryQuery`).
   */
  async listDirectoryPage(
    query: ListDirectoryQuery,
  ): Promise<Paginated<DirectoryCardDTO>> {
    const qb = this.buildDirectoryQuery(query);
    return paginate(qb, normalizePage(query.page), async (rows) => {
      // ONE batched crop lookup for the page's cover photos (see
      // `listDirectory`), never a per-row query.
      const crops = await this.mediaCropService.getMany(
        rows.flatMap((row) => listingPhotoKeys(row)),
      );
      return rows.map((row) => toDirectoryCard(row, crops));
    });
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
      where: {
        ownerId: ownerUserId,
        status: ListingStatus.Live,
        // "Businesses run by <member>" is a present-tense claim about what
        // they run now, so a business they closed for good leaves the strip,
        // and so does one whose listing they have paused.
        ...DirectoryService.PUBLICLY_LISTED,
      },
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    const visibleRows = await this.dropModeratedListings(rows);
    // ONE batched crop lookup for the strip's cover photos (see
    // `listDirectory`), never a per-row query.
    const crops = await this.mediaCropService.getMany(
      visibleRows.flatMap((row) => listingPhotoKeys(row)),
    );
    return visibleRows.map((row) => toDirectoryCard(row, crops));
  }

  /**
   * One live directory listing by slug, for the detail page. 404s unless the
   * listing exists AND is live: a listing still in review must never be
   * reachable through the public directory even if its slug is guessed.
   *
   * Deliberately does NOT apply the permanently-closed exclusion the list
   * reads do. A closed business still has to have a page: every link ever
   * shared to it, every bookmark, every search-engine result and every review
   * members wrote points here, and answering those with a 404 would erase the
   * record instead of correcting it. The page renders the closure notice from
   * `operatingState` and stops being somewhere the directory sends people.
   */
  async getDirectoryBySlug(slug: string): Promise<DirectoryDetailDTO> {
    const listing = await this.loadLiveOr404(slug);
    // Bounded: the detail card embeds the review list AND derives its rating
    // aggregate from this same array, so `take` must sit well above any real
    // listing's review count (DEFAULT_LIST_LIMIT is sized for exactly that) to
    // avoid skewing the rating — full pagination is served separately by
    // `listReviews`. Order matches `listReviews` (newest first).
    const allReviews = await this.reviews.find({
      where: { listingId: listing.id },
      order: { createdAt: 'DESC' },
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
    const ownerIdentity = await this.resolveOwnerIdentity(listing);
    const memberVouches = await this.loadSafeSpaceMemberVouches(listing.id);
    const crops = await this.mediaCropService.getMany(
      listingPhotoKeys(listing),
    );
    const movedToListing = await this.resolveMovedToListing(listing);
    // The public Q&A block. Two queries on top of what this read already does
    // (the capped question fetch and its moderation-state lookup), plus a third
    // only when there is at least one question with a member author to resolve.
    // The cap is `DIRECTORY_DETAIL_QUESTION_LIMIT`, not `DEFAULT_LIST_LIMIT`:
    // nothing on the page is DERIVED from the questions the way the star rating
    // is derived from the review array, so there is no aggregate to skew by
    // truncating, and the full list is one request away at
    // `GET /directory/:slug/questions`.
    const questions = await this.loadDetailQuestions(listing.id);
    return toDirectoryDetail(
      listing,
      reviews,
      upcoming,
      savedCount,
      reviewAuthors,
      ownerIdentity.slug,
      ownerIdentity.avatarUrl,
      memberVouches,
      crops,
      movedToListing,
      questions,
    );
  }

  /**
   * The capped, moderation-filtered, newest-first Q&A block the detail page
   * embeds.
   *
   * `take` is applied BEFORE the moderation filter, which means a taken-down
   * question can shorten the block by one rather than being backfilled. That is
   * the same trade `getDirectoryBySlug` already makes for its review array, and
   * it is the right one here: backfilling would cost a second round trip on the
   * hottest read in the module to recover a row nobody is missing, and the
   * complete list is available from `listQuestions`, which filters in-query
   * precisely because pagination there cannot tolerate the gap.
   */
  private async loadDetailQuestions(
    listingId: string,
  ): Promise<ListingPublicQuestionDTO[]> {
    const rows = await this.publicQuestions.find({
      where: { listingId },
      order: { createdAt: 'DESC' },
      take: DIRECTORY_DETAIL_QUESTION_LIMIT,
    });
    const visible = await this.dropModeratedQuestions(rows);
    const askers = await this.resolveQuestionAskers(visible);
    return visible.map((question) =>
      toListingPublicQuestionDTO(
        question,
        question.askerId ? (askers.get(question.askerId) ?? null) : null,
      ),
    );
  }

  /**
   * Batch-resolve each asker's live profile identity (slug + avatar), keyed by
   * `askerId`. One `IN (...)` query, never N+1 — the same shape as
   * `resolveReviewAuthors`, and it exposes the same two fields and no others.
   *
   * The avatar goes through `DirectoryService.publicAvatarUrl`, like every
   * other member reference this service resolves.
   */
  private async resolveQuestionAskers(
    questions: ListingPublicQuestion[],
  ): Promise<Map<string, ListingQuestionAsker>> {
    const askerIds = [
      ...new Set(
        questions
          .map((question) => question.askerId)
          .filter((id): id is string => id !== null),
      ),
    ];
    if (askerIds.length === 0) return new Map();
    const profiles = await this.profiles.find({
      where: { userId: In(askerIds) },
      select: { userId: true, slug: true, avatarUrl: true, photoVisible: true },
    });
    return new Map(
      profiles.map((profile) => [
        profile.userId,
        {
          slug: profile.slug,
          avatarUrl: DirectoryService.publicAvatarUrl(profile),
        },
      ]),
    );
  }

  /**
   * The successor listing a `moved` business points at, resolved to the slug
   * and name its banner links with. `null` unless the state is actually
   * `moved` and a successor was recorded.
   *
   * The successor is re-checked at READ time, not trusted from the write: it
   * has to still be live and must not itself be permanently closed, because a
   * "we moved here" link that lands on a 404 or on another closed business is
   * worse than no link. The owner-side write check
   * (`ListingsService.resolveSuccessorListingId`) cannot cover this, since the
   * successor can be taken down or shut long after the move was recorded.
   */
  private async resolveMovedToListing(
    listing: Listing,
  ): Promise<MovedToListingView | null> {
    if (
      listing.operatingState !== ListingOperatingState.Moved ||
      listing.movedToListingId === null
    ) {
      return null;
    }
    const successor = await this.listings.findOne({
      where: {
        id: listing.movedToListingId,
        status: ListingStatus.Live,
        ...DirectoryService.PUBLICLY_LISTED,
      },
      select: { slug: true, name: true },
    });
    if (!successor) return null;
    // A moderator takedown on the successor hides it from the directory too,
    // so the link would lead to a 404 (`assertNotModerated`).
    const survivingSuccessors = await this.dropModeratedListings([successor]);
    const survivingSuccessor = survivingSuccessors[0];
    if (!survivingSuccessor) return null;
    return {
      slug: survivingSuccessor.slug,
      name: survivingSuccessor.name,
    };
  }

  /**
   * The publicly renderable avatar for any member reference on a directory
   * surface (listing owner, review author, question asker).
   *
   * A raw `profiles.avatarUrl` column value is a bare STORAGE KEY for every
   * member who UPLOADED their photo (only a Google sign-in leaves an absolute
   * URL there), and a bare key renders as a broken relative image on the
   * client. `toImageUrl` turns it into the `/files/:key` URL the browser can
   * actually load. It also honours the member's own `photoVisible` switch, so
   * someone who turned their face off does not have it reappear here. This is
   * the same contract `toMemberRef` applies to every other cross-domain member
   * reference.
   */
  private static publicAvatarUrl(profile: {
    avatarUrl: string | null;
    photoVisible: boolean;
  }): string | null {
    return profile.photoVisible ? toImageUrl(profile.avatarUrl) : null;
  }

  /**
   * The listing owner's public profile slug + avatar for the "Who runs it"
   * card ("View profile" deep link + real photo) — but only when they linked
   * their profile (`linkToProfile`) AND their chosen visibility exposes their
   * identity. `anon`/`role` deliberately reveal neither (mirrors
   * `ownerIdentity`'s redaction in listing-response), and an owner whose
   * profile no longer exists resolves to both `null`.
   */
  private async resolveOwnerIdentity(
    listing: Listing,
  ): Promise<{ slug: string | null; avatarUrl: string | null }> {
    if (
      !listing.linkToProfile ||
      listing.visibility === 'anon' ||
      listing.visibility === 'role'
    ) {
      return { slug: null, avatarUrl: null };
    }
    const profile = await this.profiles.findOne({
      where: { userId: listing.ownerId },
      select: { slug: true, avatarUrl: true, photoVisible: true },
    });
    return {
      slug: profile?.slug ?? null,
      avatarUrl: profile ? DirectoryService.publicAvatarUrl(profile) : null,
    };
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
      select: { userId: true, slug: true, avatarUrl: true, photoVisible: true },
    });
    return new Map(
      profiles.map((profile) => [
        profile.userId,
        {
          slug: profile.slug,
          avatarUrl: DirectoryService.publicAvatarUrl(profile),
        },
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
      .orderBy('review.created_at', 'DESC');
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
    // BE-HSG-14: the owner cannot review their own listing. A five-star
    // self-review counted toward the public card's `rating` and the Safe Spaces
    // hero stats. The self-review case was already known here (the notification
    // below skips it) but was allowed through; the sibling surfaces have always
    // blocked the equivalent (`ListingEditSuggestionsService.submit` blocks the
    // owner, and a member cannot request a viewing on their own home).
    if (listing.ownerId === userId) {
      throw new BadRequestException('You cannot review your own listing');
    }
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
          // `''` is the "no photo" representation, matching every other image
          // field here; the global `StorageKeyOwnershipInterceptor` has already
          // normalised a resolved `/files/<key>` URL back to a bare key and
          // rejected any key the caller did not upload.
          photo: dto.photo ?? '',
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
      profile
        ? {
            slug: profile.slug,
            avatarUrl: DirectoryService.publicAvatarUrl(profile),
          }
        : null,
    );
  }

  /**
   * The REVIEWER edits their own review.
   *
   * A member gets exactly one review per listing, enforced by
   * `UQ_listing_reviews_reviewer`. Without an edit path, that rule meant the
   * one review someone ever wrote about a place stood unchanged forever: a
   * complaint about a thing the business then fixed, a five-star note about
   * staff who have since left, a typo. The one-review rule is worth keeping,
   * and this is what makes it fair to keep.
   *
   * Gated on being the AUTHOR, and 403 rather than 404 when someone else's
   * review is targeted. The don't-leak-existence 404 that `loadOwnedOr404` uses
   * for listing refs is about a guessable, sequential id; a review id is a uuid
   * already published in the public detail payload, so there is no existence to
   * protect and a 403 says what actually happened.
   *
   * WHAT AN EDIT DOES TO AN OWNER REPLY, which is the interesting case:
   *
   *  - The reply is KEPT, always, and both its text and `ownerRepliedAt` are
   *    untouched. Clearing it on edit would hand the reviewer a delete button
   *    for the business's public response, usable by changing one character.
   *  - `editedAt` is stamped, and `ReviewDTO.isEditedAfterOwnerReply` goes true
   *    whenever it lands after `ownerRepliedAt`. Silence here is the real
   *    hazard: without it a reviewer could post something mild, collect a warm
   *    reply, then rewrite the review into an accusation, leaving the owner
   *    apparently replying agreeably to words they never saw. The page can now
   *    say the review changed after the reply, so a reader can weigh both.
   *  - Nothing is hidden and nothing is versioned. Keeping and displaying prior
   *    revisions of a review would mean publishing text a member has actively
   *    withdrawn, which on this platform is a worse failure than the ordering
   *    problem it would solve.
   *
   * The edit stamp is only applied when something ACTUALLY changed, so
   * re-saving an identical body cannot manufacture an "edited after the reply"
   * flag against an owner. A genuine one-character change still can, and that
   * is the honest reading: the review did change after the reply.
   *
   * The aggregate rating needs no maintenance here and that is by design. There
   * is no denormalized rating column on `listings`: every rating path
   * recomputes from the review rows themselves (`ratingFromReviews` on the
   * detail and safe-space reads, a grouped `COUNT`/`SUM` on the safe-spaces
   * hub), so changing `stars` on this row IS the aggregate update, and it
   * cannot drift from the reviews it summarises.
   */
  async updateReview(
    slug: string,
    reviewId: string,
    userId: string,
    dto: UpdateReviewDto,
  ): Promise<ReviewDTO> {
    const listing = await this.loadLiveOr404(slug);
    const review = await this.reviews.findOne({
      where: { id: reviewId, listingId: listing.id },
    });
    if (!review) {
      throw new NotFoundException('Review not found');
    }
    if (!review.reviewerId || review.reviewerId !== userId) {
      throw new ForbiddenException('You can only edit your own review');
    }

    // Trimmed for the same reason `replyToReview` trims: `@MinLength(1)` passes
    // a body of `" "`, which would store a review that renders as blank.
    const text = dto.text.trim();
    if (!text) {
      throw new BadRequestException('Review cannot be empty');
    }
    const photo = dto.photo ?? '';
    const previousPhoto = review.photo;
    const isChanged =
      review.stars !== dto.stars ||
      review.text !== text ||
      previousPhoto !== photo;

    review.stars = dto.stars;
    review.text = text;
    review.photo = photo;
    if (isChanged) {
      review.editedAt = new Date();
    }
    const saved = await this.reviews.save(review);

    // The superseded object would otherwise keep serving from the bucket with
    // nothing referencing it. Best-effort and post-commit, mirroring
    // `ListingsService.deleteOrphanedObjects`: the row already committed, and a
    // stranded object is a storage cost rather than a correctness problem.
    if (previousPhoto && previousPhoto !== photo) {
      await this.deleteOrphanedReviewPhoto(previousPhoto, saved.id);
    }

    const profile = await this.profiles.findOne({
      where: { userId },
      select: { slug: true, avatarUrl: true, photoVisible: true },
    });
    return toReviewDTO(
      saved,
      profile
        ? {
            slug: profile.slug,
            avatarUrl: DirectoryService.publicAvatarUrl(profile),
          }
        : null,
    );
  }

  /** Best-effort delete of a review photo no row references any more. Never
   * throws: the review write it follows has already committed. */
  private async deleteOrphanedReviewPhoto(
    reference: string,
    reviewId: string,
  ): Promise<void> {
    try {
      await this.storage.deleteObjectByReference(reference);
    } catch (error) {
      this.logger.warn(
        `Failed to delete superseded photo for review ${reviewId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Mark a review helpful, as the current member. Idempotent: voting again
   * returns the same count rather than a 409.
   *
   * "One vote per member per review" is a DATABASE rule
   * (`UQ_listing_review_helpful_votes_voter`), not an application one, exactly
   * as "one review per member per listing" already is. A read-then-insert in
   * application code is two statements with a gap, and a double-tap on a slow
   * connection fits through it. The insert here is `ON CONFLICT DO NOTHING`, so
   * the second tap lands on the existing row, changes nothing, and still
   * answers with the current tally.
   *
   * The one rule the database cannot hold is the self-vote ban: `voter_id` here
   * against `reviewer_id` on another table is a cross-table predicate, which no
   * CHECK constraint can express. It is checked below, and both the entity and
   * the migration say so where a reader would look.
   *
   * `listing_reviews.helpful` is RECOMPUTED from `COUNT(*)`, not incremented,
   * inside the same transaction as the vote row. An increment is only correct
   * as long as no write is ever retried, replayed, or interleaved with a
   * withdrawal; a recount is right afterwards no matter what happened, and it
   * costs one index-only scan of a single review's votes.
   */
  async voteHelpful(
    slug: string,
    reviewId: string,
    userId: string,
  ): Promise<ReviewHelpfulDTO> {
    const review = await this.loadReviewForVote(slug, reviewId);
    if (review.reviewerId === userId) {
      throw new BadRequestException(
        'You cannot mark your own review as helpful',
      );
    }

    const helpful = await this.dataSource.transaction(async (manager) => {
      await this.lockReviewRow(manager, review.id);
      await manager
        .createQueryBuilder()
        .insert()
        .into(ListingReviewHelpfulVote)
        .values({ reviewId: review.id, voterId: userId })
        .orIgnore()
        .execute();
      return this.recountHelpful(manager, review.id);
    });

    return { reviewId: review.id, helpful, hasVoted: true };
  }

  /**
   * Withdraw a helpful vote. Also idempotent: withdrawing a vote that was never
   * cast deletes nothing and answers with the unchanged count.
   *
   * A vote with no way back is a worse control than no vote at all — the first
   * mis-tap would be permanent, and the count would slowly accumulate them.
   * It shares the recount with `voteHelpful` for exactly the same reason:
   * decrementing would be wrong the moment a delete removed no row.
   */
  async withdrawHelpfulVote(
    slug: string,
    reviewId: string,
    userId: string,
  ): Promise<ReviewHelpfulDTO> {
    const review = await this.loadReviewForVote(slug, reviewId);

    const helpful = await this.dataSource.transaction(async (manager) => {
      await this.lockReviewRow(manager, review.id);
      await manager.delete(ListingReviewHelpfulVote, {
        reviewId: review.id,
        voterId: userId,
      });
      return this.recountHelpful(manager, review.id);
    });

    return { reviewId: review.id, helpful, hasVoted: false };
  }

  /** Shared load for both vote paths: the listing must be live and visible, and
   * the review must belong to it, so a review id from one business can never be
   * voted on through another business's URL. */
  private async loadReviewForVote(
    slug: string,
    reviewId: string,
  ): Promise<ListingReview> {
    const listing = await this.loadLiveOr404(slug);
    const review = await this.reviews.findOne({
      where: { id: reviewId, listingId: listing.id },
      select: { id: true, reviewerId: true },
    });
    if (!review) {
      throw new NotFoundException('Review not found');
    }
    return review;
  }

  /**
   * Take a write lock on the review row, as the FIRST statement of both vote
   * transactions.
   *
   * Without it the recount is subtly wrong under concurrency, and the unique
   * index does not save it. Two members voting on the same review at the same
   * time insert two DIFFERENT rows, so neither conflicts; each then runs its
   * own `COUNT(*)`, and under READ COMMITTED neither sees the other's
   * uncommitted row. Both compute 1, both write `helpful = 1`, and the column
   * ends up one short of the two rows it claims to count. Locking the review
   * first makes the second transaction wait, so its count runs against a
   * snapshot that already includes the first vote.
   *
   * Taken on the same row by both paths and always before any write, so there
   * is one lock-acquisition order and no deadlock between a vote and a
   * withdrawal. The row is held only for the two statements that follow.
   */
  private async lockReviewRow(
    manager: EntityManager,
    reviewId: string,
  ): Promise<void> {
    await manager.findOne(ListingReview, {
      where: { id: reviewId },
      select: { id: true },
      lock: { mode: 'pessimistic_write' },
    });
  }

  /** Recompute `listing_reviews.helpful` from the vote rows and return it. Runs
   * inside the caller's transaction, after `lockReviewRow`, so the tally and
   * the rows it counts are never observable apart and cannot race a sibling
   * vote on the same review. */
  private async recountHelpful(
    manager: EntityManager,
    reviewId: string,
  ): Promise<number> {
    const helpful = await manager.count(ListingReviewHelpfulVote, {
      where: { reviewId },
    });
    await manager.update(ListingReview, { id: reviewId }, { helpful });
    return helpful;
  }

  /**
   * Ask the business a question, in public, as the current member.
   *
   * RATE LIMITING, because an unmoderated public question box on a queer
   * venue's page is an abuse surface before it is a feature. Someone can use it
   * to plant an insinuation the business then has to answer in public, and to
   * do it over and over. Three layers, each covering what the others cannot:
   *
   *  1. The HTTP throttle on the route (`@Throttle` in `DirectoryController`)
   *     stops a burst. On its own it is close to useless here: the global
   *     throttler tracks by IP over a 60-second window, and the shape that
   *     actually hurts is one question an hour for a week from one account.
   *  2. `MAX_OPEN_QUESTIONS_PER_LISTING`, counted out of this table: a member
   *     may have at most this many UNANSWERED questions outstanding on any one
   *     listing. Answered ones do not count, so an engaged member asking real
   *     questions of a responsive business is never blocked, while someone
   *     stacking questions on a business that has not replied is. This is the
   *     layer aimed at the campaign against a single venue.
   *  3. `MAX_QUESTIONS_PER_DAY`, across all listings, so the same behaviour
   *     spread thin over the whole directory is bounded too.
   *
   * Both counted caps are per MEMBER, and only active members can reach this
   * route at all (`ActiveMemberGuard`), so there is no anonymous path in. Both
   * answer with 429 rather than a silent drop: a member who has hit a limit is
   * told, because the alternative teaches people their questions vanish.
   *
   * The listing's OWNER cannot ask a question on their own listing. Mirrors
   * `addReview`'s self-review block and `ListingEditSuggestionsService.submit`.
   * An owner who wants a question-and-answer on their page can write both
   * halves of it, and passing that off as a member asking would be inventing a
   * member. The FAQ they actually want is `services`/`whatItIs`.
   */
  async askQuestion(
    slug: string,
    userId: string,
    dto: AskListingPublicQuestionDto,
  ): Promise<ListingPublicQuestionDTO> {
    const listing = await this.loadLiveOr404(slug);
    if (listing.ownerId === userId) {
      throw new BadRequestException(
        'You cannot ask a question on your own listing',
      );
    }

    const body = dto.body.trim();
    if (body.length < DirectoryService.MIN_QUESTION_LENGTH) {
      throw new BadRequestException('Please write a fuller question');
    }

    await this.assertQuestionQuota(listing.id, userId);

    const profile = await this.profiles.findOne({ where: { userId } });
    const askerName = profile
      ? `${profile.firstName} ${profile.lastName}`.trim()
      : 'A QueerPulse member';

    const saved = await this.publicQuestions.save(
      this.publicQuestions.create({
        listingId: listing.id,
        askerId: userId,
        askerName,
        body,
      }),
    );

    // Tell the owner someone asked, so the question does not sit unanswered
    // because nobody knew it was there. Best-effort and never rethrown — the
    // question has already committed, and the same ordering every other
    // notification in this module uses. Skipped for a listing with no real
    // owner (`friendly`/`suggested` rows), which is also the case a moderator
    // answer exists for. The asker is the actor, so a blocked or muted asker is
    // filtered by `NotificationsService.create` rather than here.
    if (listing.ownerId) {
      try {
        await this.notifications.create(
          listing.ownerId,
          NotificationType.ListingPublicQuestion,
          {
            actorId: userId,
            source: 'listing',
            listingSlug: listing.slug,
            listingName: listing.name,
          },
          userId,
        );
      } catch {
        // Intentionally ignored — the question already committed.
      }
    }

    return toListingPublicQuestionDTO(
      saved,
      profile
        ? {
            slug: profile.slug,
            avatarUrl: DirectoryService.publicAvatarUrl(profile),
          }
        : null,
    );
  }

  /** The two counted rate limits described on `askQuestion`. Two indexed
   * COUNTs, both bounded, run before anything is written. */
  private async assertQuestionQuota(
    listingId: string,
    userId: string,
  ): Promise<void> {
    const openOnThisListing = await this.publicQuestions.count({
      where: { listingId, askerId: userId, answer: IsNull() },
    });
    if (openOnThisListing >= DirectoryService.MAX_OPEN_QUESTIONS_PER_LISTING) {
      throw new HttpException(
        'You already have unanswered questions on this listing. Give them a chance to reply first.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const since = new Date(Date.now() - DirectoryService.QUESTION_WINDOW_MS);
    const askedRecently = await this.publicQuestions.count({
      where: { askerId: userId, createdAt: MoreThanOrEqual(since) },
    });
    if (askedRecently >= DirectoryService.MAX_QUESTIONS_PER_DAY) {
      throw new HttpException(
        "You've asked a lot of questions today. Try again tomorrow.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Paginated public questions for one live listing, newest first, answers
   * inline — the "see all" behind the detail page's capped block, and the exact
   * counterpart of `listReviews`.
   *
   * Filtered IN-QUERY rather than after the fetch, for the reason
   * `listReviews`'s own comment gives: filtering a fixed-size page afterwards
   * under-fills it, and under OFFSET pagination it permanently skips the row
   * just past a taken-down one.
   *
   * No join, so `paginate`'s `skip`/`take` is safe here. The documented
   * `distinctAlias` failure applies to `skip`/`take` combined with a join and
   * an ORDER BY on the joined alias; this query orders by its own column and
   * resolves asker identities in a separate batched lookup precisely so it
   * never has to join.
   */
  async listQuestions(
    slug: string,
    page?: number,
  ): Promise<Paginated<ListingPublicQuestionDTO>> {
    const listing = await this.loadLiveOr404(slug);
    const qb = this.publicQuestions
      .createQueryBuilder('question')
      .where('question.listing_id = :listingId', { listingId: listing.id })
      .orderBy('question.created_at', 'DESC');
    this.excludeModeratedQuestions(qb, 'question.id');
    return paginate(qb, normalizePage(page), async (rows) => {
      const askers = await this.resolveQuestionAskers(rows);
      return rows.map((question) =>
        toListingPublicQuestionDTO(
          question,
          question.askerId ? (askers.get(question.askerId) ?? null) : null,
        ),
      );
    });
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
        // Filtered here rather than after the fetch, so the hub's hero
        // numbers (`stats.verified`, `stats.removed`, `stats.reviews`, all
        // derived from these rows below) count only spaces someone could
        // still walk into. A safe space that shut for good is not a safe
        // space you can go to, and a removed one that also shut is doubly
        // not. A paused listing is likewise not on offer.
        ...DirectoryService.PUBLICLY_LISTED,
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

  /** One safe space (verified or removed) by slug. 404 unless live + safe.
   *
   * Like `getDirectoryBySlug`, this detail read deliberately keeps resolving
   * for a permanently closed business: the vouches and the verification
   * narrative are a record of what that space was, and the page is where a
   * link to it lands. The safe-spaces LIST (`listSafeSpaces`) is where the
   * exclusion belongs, and it is applied there.
   *
   * An owner-PAUSED listing is the opposite case and does 404 here, for the
   * same reason it does on the directory detail: the owner asked for the
   * listing not to be shown, and a safe-space page is still the listing being
   * shown. Nothing is deleted; unhiding brings the page straight back. */
  async getSafeSpaceBySlug(slug: string): Promise<AnySafeSpaceDetailDTO> {
    const listing = await this.listings.findOne({
      where: { slug, status: ListingStatus.Live, isHiddenByOwner: false },
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
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    const reviews = await this.dropModeratedReviews(allReviews);
    const memberVouches = await this.loadSafeSpaceMemberVouches(listing.id);
    return toSafeSpaceDetail(listing, reviews, memberVouches);
  }

  // Shared detail-page load for `getDirectoryBySlug`, `listReviews` and
  // `addReview`. Gates on the MODERATION status and on the owner's own pause.
  //
  // The permanently-closed exclusion is deliberately NOT applied here: it
  // belongs to the list reads, and folding it in would 404 the detail page and
  // the review history of every business that ever closed.
  //
  // `isHiddenByOwner` IS applied, and the difference is the point. A closure is
  // news about a business that readers arrived here looking for; a pause is the
  // owner asking not to be shown, and honouring that halfway (findable by
  // direct link, just not by browsing) would not be honouring it. Nothing is
  // deleted: the reviews, photos and history all sit untouched behind the 404,
  // and unhiding restores the page exactly as it was. The owner reaches their
  // own paused listing through the owner-scoped `GET /listings/:ref`.
  private async loadLiveOr404(slug: string): Promise<Listing> {
    const listing = await this.listings.findOne({
      where: { slug, status: ListingStatus.Live, isHiddenByOwner: false },
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
