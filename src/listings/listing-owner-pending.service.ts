import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  Report,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { LISTING_DISPUTE_REASON_CODE } from './dto/dispute-listing.dto';
import {
  OwnerListingPendingDTO,
  toOwnerPendingDisputeDTO,
  toOwnerPendingEditSuggestionDTO,
  toOwnerPendingListingQuestionDTO,
  toOwnerPendingOwnershipClaimDTO,
} from './dto/owner-listing-pending.dto';
import {
  ListingClaim,
  ListingClaimStatus,
} from './entities/listing-claim.entity';
import {
  ListingEditSuggestion,
  ListingEditSuggestionStatus,
} from './entities/listing-edit-suggestion.entity';
import { ListingQuestion } from './entities/listing-question.entity';
import { Listing } from './entities/listing.entity';
import { ListingCoManagersService } from './listing-co-managers.service';

/**
 * How many items of each kind one response carries. The `counts` block is
 * always the true total, so a listing sitting on 300 pending suggestions
 * reports 300 and ships the newest 50, so the frontend badge stays honest while
 * the payload stays bounded. Mirrors the `DEFAULT_LIST_LIMIT` reasoning every
 * other whole-array listing response follows, sized down because this endpoint
 * returns four arrays at once and is polled for a badge.
 */
export const OWNER_PENDING_ITEM_CAP = 50;

/**
 * C8: what is currently waiting on a listing, for the person who owns it.
 *
 * Edit suggestions, ownership claims and ownership disputes all queue to
 * moderators, and until now the owner found out when a moderator acted, if at
 * all. Most suggestions are true and the owner is the fastest person alive to
 * confirm one, so this endpoint puts the queue in front of them.
 *
 * Kept as its own service rather than folded into `ListingsService` for the
 * same reason `ListingEditSuggestionsService` and `ListingClaimsService` are:
 * it reads across four tables none of which `ListingsService` owns all of, and
 * `ListingsService` is already the largest class in the domain. It follows the
 * same file-local `loadOwnedOrCoManagedOr404`/`loadOr404` copy convention those two
 * services document rather than importing a private helper.
 *
 * IDENTITY IS NEVER MAPPED HERE. Not withheld at the edge, not nulled in the
 * mapper: the DTO interfaces in `owner-listing-pending.dto.ts` have no field
 * for a suggester, a claimant or a reporter, so there is nowhere for one to
 * land. See those interfaces for why each one is withheld.
 */
@Injectable()
export class ListingOwnerPendingService {
  constructor(
    @InjectRepository(Listing) private readonly listings: Repository<Listing>,
    @InjectRepository(ListingEditSuggestion)
    private readonly suggestions: Repository<ListingEditSuggestion>,
    @InjectRepository(ListingClaim)
    private readonly claims: Repository<ListingClaim>,
    @InjectRepository(ListingQuestion)
    private readonly questions: Repository<ListingQuestion>,
    // From `ReportsModule`'s re-exported `TypeOrmModule` (the same seam
    // `ModerationModule` uses). A listing dispute is a `listing_dispute`-coded
    // `Report`, not an entity this domain owns.
    @InjectRepository(Report) private readonly reports: Repository<Report>,
    // The second management gate's data source — see
    // `loadOwnedOrCoManagedOr404` below.
    private readonly coManagers: ListingCoManagersService,
  ) {}

  /**
   * CO-MANAGER-ALLOWED (`loadOwnedOrCoManagedOr404`, the same gate as
   * `update`): every item still awaiting a decision on a listing the caller
   * manages, newest first, with true totals alongside the capped arrays.
   *
   * A CO-MANAGER MAY SEE PENDING DISPUTES AND CLAIMS, and that is a deliberate
   * decision rather than an oversight. This inbox is how anyone running the
   * listing learns there is something to answer, and a co-manager who could
   * edit the page but not see that its ownership is being contested would be
   * working blind on the one thing that most affects their own access.
   *
   * What stays true either way: the endpoint never reveals WHO filed anything.
   * That is not withheld at the edge, it is structural — the DTO interfaces in
   * `owner-listing-pending.dto.ts` have no field for a suggester, a claimant or
   * a reporter, so widening the audience of this response cannot widen what it
   * discloses about them. See those interfaces for why each is withheld.
   *
   * The one item a co-manager can see but not act on is an unanswered moderator
   * question. Answering those is owner-only (see
   * `ListingsService.answerQuestion`); the co-manager's job here is to know one
   * is waiting.
   *
   * All four reads run in parallel and each is a single-table `findAndCount`
   * with no join, so none of them can hit the `.skip()/.take()`-with-a-joined
   * ORDER BY `distinctAlias` trap. `take` bounds the rows while the count stays
   * the full total.
   *
   * SCOPING, the one thing that must not go wrong here: every query filters on
   * this LISTING. A claim in particular is filed BY somebody contesting the
   * current owner, so scoping the claims read by `claimantId: userId` would
   * have quietly answered a completely different question ("claims this owner
   * has filed elsewhere") and shown every owner an empty list forever. The
   * caller's `userId` is used for exactly one thing on this path: proving they
   * own the listing.
   */
  async getPendingForOwner(
    ref: string,
    userId: string,
  ): Promise<OwnerListingPendingDTO> {
    const listing = await this.loadOwnedOrCoManagedOr404(ref, userId);

    const [
      [suggestionRows, editSuggestionCount],
      [claimRows, ownershipClaimCount],
      [disputeRows, disputeCount],
      [questionRows, unansweredQuestionCount],
    ] = await Promise.all([
      this.suggestions.findAndCount({
        where: {
          listingId: listing.id,
          status: ListingEditSuggestionStatus.Pending,
        },
        order: { createdAt: 'DESC' },
        take: OWNER_PENDING_ITEM_CAP,
      }),
      this.claims.findAndCount({
        // Scoped by `listingId` ONLY, never by `claimantId`. See the method
        // doc comment.
        where: { listingId: listing.id, status: ListingClaimStatus.Pending },
        order: { createdAt: 'DESC' },
        take: OWNER_PENDING_ITEM_CAP,
      }),
      this.reports.findAndCount({
        // A dispute is addressed by the listing's `slug`, which is what
        // `ListingsService.dispute` files it under. Narrowed to the
        // `listing_dispute` reason code on purpose: `subjectType: listing`
        // also covers abuse reports against the business, and telling an owner
        // "somebody has reported you for hate speech" is a moderation
        // disclosure this endpoint has no business making. Only the
        // ownership/accuracy dispute pathway is surfaced.
        //
        // `Open` only, deliberately excluding `Escalated`. Escalation is an
        // internal judgement that a case is serious, and surfacing it would
        // leak that judgement to its subject. The badge undercounts in that
        // one case, which is the safe direction to be wrong in.
        where: {
          subjectType: ReportSubjectType.Listing,
          subjectId: listing.slug,
          reasonCode: LISTING_DISPUTE_REASON_CODE,
          status: ReportStatus.Open,
        },
        order: { createdAt: 'DESC' },
        take: OWNER_PENDING_ITEM_CAP,
      }),
      this.questions.findAndCount({
        // The one queue waiting on the OWNER rather than on a moderator: an
        // unanswered question is theirs to clear via
        // `POST /listings/:ref/questions/:id/answer`.
        where: { listingId: listing.id, answeredAt: IsNull() },
        order: { createdAt: 'DESC' },
        take: OWNER_PENDING_ITEM_CAP,
      }),
    ]);

    return {
      counts: {
        editSuggestions: editSuggestionCount,
        ownershipClaims: ownershipClaimCount,
        disputes: disputeCount,
        unansweredQuestions: unansweredQuestionCount,
        total:
          editSuggestionCount +
          ownershipClaimCount +
          disputeCount +
          unansweredQuestionCount,
      },
      editSuggestions: suggestionRows.map(toOwnerPendingEditSuggestionDTO),
      ownershipClaims: claimRows.map(toOwnerPendingOwnershipClaimDTO),
      disputes: disputeRows.map(toOwnerPendingDisputeDTO),
      unansweredQuestions: questionRows.map(toOwnerPendingListingQuestionDTO),
    };
  }

  /** Mirrors `ListingsService.loadOwnedOrCoManagedOr404`: the OWNER or an
   * active CO-MANAGER gets in, and anyone else gets the same 404 a
   * non-existent ref gets rather than a 403 confirming the listing exists.
   * Kept as a local copy rather than a shared import, the same call
   * `ListingClaimsService`/`ListingEditSuggestionsService` make for their own
   * `loadOr404`/`loadLiveOr404` copies.
   *
   * The ownership test runs against the row already in hand, so the seat lookup
   * only ever runs for a caller who is not the owner. */
  private async loadOwnedOrCoManagedOr404(
    ref: string,
    userId: string,
  ): Promise<Listing> {
    const listing = await this.listings.findOne({ where: { ref } });
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
    if (listing.ownerId === userId) return listing;
    if (await this.coManagers.isActiveCoManager(listing.id, userId)) {
      return listing;
    }
    throw new NotFoundException('Listing not found');
  }
}
