import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { actorFromLookup, presentActorIds } from '../common/nullable-actor';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { Profile } from '../users/entities/profile.entity';
import {
  HousingListing,
  HousingListingStatus,
} from '../housing-listings/entities/housing-listing.entity';
import { HousingViewingStatus } from '../housing-viewings/entities/housing-viewing.entity';
import { HousingViewingsService } from '../housing-viewings/housing-viewings.service';
import { SubmitHousingReviewDto } from './dto/submit-housing-review.dto';
import {
  HousingReview,
  HousingReviewAuthorRole,
} from './entities/housing-review.entity';
import {
  HousingListingReviewsDTO,
  HousingReviewDTO,
  HousingViewingReviewPairDTO,
  toHousingReviewDTO,
} from './housing-review-response';

/**
 * Two-sided BLIND reviews gated on a completed viewing (P2.4). No completed
 * viewing → no review (the interaction gate). Reveal is enforced entirely on
 * the read path so a submitted review is never leaked early: the counterparty's
 * review becomes visible only once BOTH parties have submitted OR the reveal
 * window has elapsed since submission. Aggregate ratings are computed on read
 * over revealed reviews only — never stored as a raw-writable number.
 */
@Injectable()
export class HousingReviewsService {
  // Anti-retaliation window: a submitted review stays hidden from the
  // not-yet-submitted counterparty for this long, then reveals regardless (so a
  // party who simply never reviews back cannot suppress the other's review
  // forever).
  private static readonly REVEAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

  // Content-moderation subject types. `housing` keys a takedown on the LISTING
  // (by slug), matching `HousingDirectoryService.SUBJECT_TYPE`; `review` keys a
  // takedown on one review row (by uuid), matching
  // `DirectoryService.REVIEW_SUBJECT_TYPE` on the business side.
  private static readonly LISTING_SUBJECT_TYPE = 'housing';
  private static readonly REVIEW_SUBJECT_TYPE = 'review';

  constructor(
    @InjectRepository(HousingReview)
    private readonly reviews: Repository<HousingReview>,
    @InjectRepository(HousingListing)
    private readonly listings: Repository<HousingListing>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly viewings: HousingViewingsService,
    // BE-HSG-13: the public reviews block honours the same moderator takedowns
    // every other public housing read does.
    private readonly contentModeration: ContentModerationService,
  ) {}

  async submit(
    authorId: string,
    dto: SubmitHousingReviewDto,
  ): Promise<HousingReviewDTO> {
    // Gate: the caller must have a COMPLETED viewing they took part in.
    const viewing = await this.viewings.loadCompletedForReview(
      dto.viewingId,
      authorId,
    );
    const isRequester = viewing.requesterId === authorId;
    const subjectId = isRequester ? viewing.listerId : viewing.requesterId;
    const authorRole = isRequester
      ? HousingReviewAuthorRole.Requester
      : HousingReviewAuthorRole.Lister;
    try {
      const saved = await this.reviews.save(
        this.reviews.create({
          viewingId: viewing.id,
          listingId: viewing.listingId,
          authorId,
          subjectId,
          authorRole,
          rating: dto.rating,
          text: dto.text,
          submittedAt: new Date(),
        }),
      );
      const authors = await this.hydrate(presentActorIds([saved.authorId]));
      return toHousingReviewDTO(
        saved,
        actorFromLookup(authors, saved.authorId) ?? null,
      );
    } catch (err) {
      // Two distinct uniqueness rules land here, and they mean different things
      // to the member, so they get different messages (BE-HSG-09).
      if (isUniqueViolation(err, 'UQ_housing_reviews_listing_author')) {
        throw new ConflictException(
          'You have already reviewed this listing. One review per home, however many times you view it.',
        );
      }
      // One review per party per viewing.
      if (isUniqueViolation(err)) {
        throw new ConflictException('You have already reviewed this viewing');
      }
      throw err;
    }
  }

  /** The blind-review pair for one viewing, from the caller's perspective. */
  async forViewing(
    viewingId: string,
    userId: string,
  ): Promise<HousingViewingReviewPairDTO> {
    // Participation check (throws 404/403 as appropriate).
    const viewing = await this.viewings.loadParticipantViewing(
      viewingId,
      userId,
    );
    const rows = await this.reviews.find({ where: { viewingId } });
    const bothSubmitted = rows.length >= 2;
    const yours = rows.find((row) => row.authorId === userId) ?? null;
    const theirs = rows.find((row) => row.authorId !== userId) ?? null;
    const theirsRevealed =
      theirs !== null && this.isRevealed(theirs, bothSubmitted);

    // `authorId` is NULL once the reviewer erased their account
    // (`SetNullContentAuthorFksOnUserErasure1794610000000`): the review
    // survives, unattributed, because the next tenant still needs to read it.
    const authorIds = presentActorIds(
      [yours, theirs]
        .filter((row): row is HousingReview => row !== null)
        .map((row) => row.authorId),
    );
    const authors = await this.hydrate(authorIds);

    return {
      viewingId,
      canReview:
        viewing.status === HousingViewingStatus.Completed && yours === null,
      youReviewed: yours !== null,
      yourReview: yours
        ? toHousingReviewDTO(
            yours,
            actorFromLookup(authors, yours.authorId) ?? null,
          )
        : null,
      counterpartySubmitted: theirs !== null,
      counterpartyReview:
        theirs && theirsRevealed
          ? toHousingReviewDTO(
              theirs,
              actorFromLookup(authors, theirs.authorId) ?? null,
            )
          : null,
      revealsAt:
        theirs && !theirsRevealed
          ? new Date(
              theirs.submittedAt.getTime() +
                HousingReviewsService.REVEAL_WINDOW_MS,
            ).toISOString()
          : null,
    };
  }

  /**
   * Public reviews block for a listing: the revealed guest→lister reviews plus
   * the aggregate computed over them. Reviews about the lister are revealed per
   * the same blind rule (their pair is complete, or the window elapsed).
   *
   * BE-HSG-13 closed three holes here. The listing lookup had no `status` filter
   * and no takedown check, so reviews stayed publicly readable for a listing a
   * moderator had hidden or that had never cleared review at all, while every
   * read in `HousingDirectoryService` refused it. Individual reviews carried no
   * takedown exclusion either, unlike business reviews
   * (`DirectoryService.dropModeratedReviews`). And pair-completeness was counted
   * from the same 200-row page as the display, so on a busy listing a viewing
   * whose two reviews straddled the page boundary read as single-sided and the
   * blind-reveal rule was evaluated on incomplete data.
   */
  async forListing(slug: string): Promise<HousingListingReviewsDTO> {
    const listing = await this.listings.findOne({
      where: { slug, status: HousingListingStatus.Live },
    });
    if (!listing) {
      throw new NotFoundException('Housing listing not found');
    }
    // Same withhold-entirely behaviour as the public detail read: a moderator
    // takedown on the listing 404s its reviews too.
    const listingModeration = await this.contentModeration.stateFor(
      HousingReviewsService.LISTING_SUBJECT_TYPE,
      slug,
    );
    if (listingModeration.hidden || listingModeration.removed) {
      throw new NotFoundException('Housing listing not found');
    }
    // Pair-completeness is counted over ALL of the listing's reviews in one
    // grouped query, NOT over the display page below: a viewing whose two
    // reviews straddle the page boundary must not read as single-sided.
    const pairCounts = await this.reviews
      .createQueryBuilder('r')
      .select('r.viewing_id', 'viewingId')
      .addSelect('COUNT(*)', 'count')
      .where('r.listing_id = :listingId', { listingId: listing.id })
      .groupBy('r.viewing_id')
      .getRawMany<{ viewingId: string; count: string }>();
    const submittedCountByViewing = new Map<string, number>(
      // Annotated as a tuple: without it TypeScript widens the element to
      // `(string | number)[]`, which the Map constructor does not accept.
      pairCounts.map((row): [string, number] => [
        row.viewingId,
        Number(row.count),
      ]),
    );
    // The display page: reviews tied to this listing, newest first.
    const all = await this.reviews.find({
      where: { listingId: listing.id },
      order: { submittedAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    // Public display = reviews ABOUT the lister that have passed the blind gate.
    const candidates = all.filter(
      (row) =>
        row.subjectId === listing.ownerId &&
        this.isRevealed(
          row,
          (submittedCountByViewing.get(row.viewingId) ?? 0) >= 2,
        ),
    );
    // A taken-down review never renders AND never skews the average, mirroring
    // `DirectoryService.dropModeratedReviews` on the business side.
    const revealed = await this.dropModeratedReviews(candidates);
    const authors = await this.hydrate(
      presentActorIds(revealed.map((row) => row.authorId)),
    );
    const averageRating =
      revealed.length === 0
        ? null
        : Math.round(
            (revealed.reduce((sum, row) => sum + row.rating, 0) /
              revealed.length) *
              10,
          ) / 10;
    return {
      averageRating,
      count: revealed.length,
      reviews: revealed.map((row) =>
        toHousingReviewDTO(row, actorFromLookup(authors, row.authorId) ?? null),
      ),
    };
  }

  // --- internals ---

  /** A review is revealed when its pair is complete, or the anti-retaliation
   * window has elapsed since submission. */
  private isRevealed(review: HousingReview, bothSubmitted: boolean): boolean {
    if (bothSubmitted) return true;
    return (
      Date.now() - review.submittedAt.getTime() >=
      HousingReviewsService.REVEAL_WINDOW_MS
    );
  }

  /** Drops any review carrying a `review` takedown, so it neither renders nor
   * skews the derived average. Mirrors `DirectoryService.dropModeratedReviews`
   * exactly (BE-HSG-13). */
  private async dropModeratedReviews(
    reviews: HousingReview[],
  ): Promise<HousingReview[]> {
    if (!reviews.length) return reviews;
    const states = await this.contentModeration.statesFor(
      HousingReviewsService.REVIEW_SUBJECT_TYPE,
      reviews.map((review) => review.id),
    );
    return reviews.filter((review) => {
      const state = states.get(review.id);
      return !state || (!state.hidden && !state.removed);
    });
  }

  private async hydrate(userIds: string[]): Promise<Map<string, MemberRef>> {
    if (!userIds.length) return new Map();
    return new MemberLookup(this.profiles).byUserIds([...new Set(userIds)]);
  }
}
