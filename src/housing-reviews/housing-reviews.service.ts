import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { Profile } from '../users/entities/profile.entity';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
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

  constructor(
    @InjectRepository(HousingReview)
    private readonly reviews: Repository<HousingReview>,
    @InjectRepository(HousingListing)
    private readonly listings: Repository<HousingListing>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly viewings: HousingViewingsService,
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
      const authors = await this.hydrate([saved.authorId]);
      return toHousingReviewDTO(saved, authors.get(saved.authorId) ?? null);
    } catch (err) {
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

    const authorIds = [yours, theirs]
      .filter((row): row is HousingReview => row !== null)
      .map((row) => row.authorId);
    const authors = await this.hydrate(authorIds);

    return {
      viewingId,
      canReview:
        viewing.status === HousingViewingStatus.Completed && yours === null,
      youReviewed: yours !== null,
      yourReview: yours
        ? toHousingReviewDTO(yours, authors.get(yours.authorId) ?? null)
        : null,
      counterpartySubmitted: theirs !== null,
      counterpartyReview:
        theirs && theirsRevealed
          ? toHousingReviewDTO(theirs, authors.get(theirs.authorId) ?? null)
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
   */
  async forListing(slug: string): Promise<HousingListingReviewsDTO> {
    const listing = await this.listings.findOne({ where: { slug } });
    if (!listing) {
      throw new NotFoundException('Housing listing not found');
    }
    // All reviews tied to this listing (both directions), so pair-completeness
    // per viewing is known without a second query.
    const all = await this.reviews.find({
      where: { listingId: listing.id },
      order: { submittedAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    const submittedCountByViewing = new Map<string, number>();
    for (const row of all) {
      submittedCountByViewing.set(
        row.viewingId,
        (submittedCountByViewing.get(row.viewingId) ?? 0) + 1,
      );
    }
    // Public display = reviews ABOUT the lister that have passed the blind gate.
    const revealed = all.filter(
      (row) =>
        row.subjectId === listing.ownerId &&
        this.isRevealed(
          row,
          (submittedCountByViewing.get(row.viewingId) ?? 0) >= 2,
        ),
    );
    const authors = await this.hydrate(revealed.map((row) => row.authorId));
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
        toHousingReviewDTO(row, authors.get(row.authorId) ?? null),
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

  private async hydrate(userIds: string[]): Promise<Map<string, MemberRef>> {
    if (!userIds.length) return new Map();
    return new MemberLookup(this.profiles).byUserIds([...new Set(userIds)]);
  }
}
