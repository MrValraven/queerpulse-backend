import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { actorFromLookup, presentActorIds } from '../common/nullable-actor';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { toStoredPlainText } from '../communities/community-plain-text';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import {
  DecideHousingListingDto,
  HousingListingDecision,
} from './dto/decide-housing-listing.dto';
import {
  HOUSING_REVIEW_QUEUE_STATUS_ALL,
  HousingReviewQueueQuery,
  HousingReviewQueueSort,
} from './dto/housing-review-queue.query';
import {
  HousingListing,
  HousingListingStatus,
} from './entities/housing-listing.entity';
import {
  AdminHousingListingDTO,
  HousingListerHistoryDTO,
  toAdminHousingListingDTO,
} from './housing-listing-response';
import { HousingListerLookup } from './housing-lister-lookup';
import { computeExpiry } from './housing-listings.service';
import {
  HOUSING_LISTING_WENT_LIVE,
  HousingListingWentLiveEvent,
} from './housing-listing.events';
import { deriveListingVerified } from './housing-verified';

/**
 * The status each decision moves a listing INTO, and whether the moderator has
 * to say why. Only `approve` may go without a reason (there it is an optional
 * note): telling somebody their home was refused, pulled, or needs changes
 * without a sentence explaining it is the thing this endpoint exists to stop.
 */
const DECISION_TARGETS: Record<
  HousingListingDecision,
  {
    status: HousingListingStatus;
    isReasonRequired: boolean;
    auditAction: string;
  }
> = {
  [HousingListingDecision.Approve]: {
    status: HousingListingStatus.Live,
    isReasonRequired: false,
    auditAction: 'housing_listing_approved',
  },
  [HousingListingDecision.RequestChanges]: {
    status: HousingListingStatus.Question,
    isReasonRequired: true,
    auditAction: 'housing_listing_changes_requested',
  },
  [HousingListingDecision.Reject]: {
    status: HousingListingStatus.Rejected,
    isReasonRequired: true,
    auditAction: 'housing_listing_rejected',
  },
  [HousingListingDecision.TakeDown]: {
    status: HousingListingStatus.TakenDown,
    isReasonRequired: true,
    auditAction: 'housing_listing_taken_down',
  },
};

/**
 * The moderator side of member-submitted housing listings: the review queue and
 * the four decisions that move a listing through it.
 *
 * WHY THIS EXISTS (LOC-01). `create()` forces every listing to `review`, public
 * browse serves `live` only, and the one transition endpoint that existed was a
 * bare `PATCH :ref/status` that took any status, required no reason, notified
 * nobody, wrote no audit row, and had no client. The result in production was a
 * permanently empty housing board: every member listing invisible forever to
 * everyone but its author, and with it every downstream capability the domain
 * has already built (risk scoring, viewings, address privacy, saved-search
 * alerts) unable to fire, because all of it hangs off a listing going live.
 *
 * Split out of `HousingListingsService` rather than added to it: that service is
 * the OWNER's surface (an owner-scoped `loadOwnedOr404` on every path, so a
 * stranger's ref 404s), and moderation is the one caller legitimately allowed to
 * load somebody else's listing. Keeping the two apart means the owner service
 * has no method that can read across members.
 */
@Injectable()
export class HousingListingModerationService {
  private readonly logger = new Logger(HousingListingModerationService.name);

  constructor(
    @InjectRepository(HousingListing)
    private readonly listings: Repository<HousingListing>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(ModAuditLog)
    private readonly modAuditLogs: Repository<ModAuditLog>,
    private readonly verification: VerificationService,
    private readonly notifications: NotificationsService,
    // Fire-and-forget domain events (global EventEmitter2). Used to announce a
    // listing going live so the saved-search alerts listener can match + notify.
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * The review queue. Defaults to `status=review` sorted riskiest-first, which
   * is the moderator's actual working set; `?status=all` restores the old
   * unfiltered list.
   *
   * Every row carries what a decision needs without a second request: who the
   * lister is and how assured their account really is, their prior record, the
   * rent and the neighbourhood, the risk score AND the individual signals that
   * produced it, the photos, when it arrived, and any decision already recorded
   * on it.
   */
  async reviewQueue(
    query: HousingReviewQueueQuery,
  ): Promise<Paginated<AdminHousingListingDTO>> {
    const page = normalizePage(query.page);
    const status = query.status ?? HousingListingStatus.Review;
    const sort = query.sort ?? HousingReviewQueueSort.Risk;

    const qb = this.listings.createQueryBuilder('l');
    if (status !== HOUSING_REVIEW_QUEUE_STATUS_ALL) {
      qb.where('l.status = :status', { status });
    }
    // Backed by IDX_housing_listings_review_queue (status, risk_score DESC,
    // created_at DESC) from AddHousingListingDecisionAudit1794721000000.
    // Ties on score break oldest-first so nothing at a given score is starved.
    if (sort === HousingReviewQueueSort.Risk) {
      qb.orderBy('l.risk_score', 'DESC').addOrderBy('l.created_at', 'ASC');
    } else if (sort === HousingReviewQueueSort.Oldest) {
      qb.orderBy('l.created_at', 'ASC');
    } else {
      qb.orderBy('l.created_at', 'DESC');
    }

    return paginate(qb, page, (rows) => this.mapRowsForAdmin(rows));
  }

  /**
   * Record one moderator decision on one listing.
   *
   * Four things happen, in this order, and the first two are what make the
   * transition safe rather than a raw status write:
   *  1. the decision is validated against the listing's CURRENT status (a
   *     take-down only makes sense on something that is actually live, and a
   *     no-op re-decision is refused rather than re-notifying the lister);
   *  2. a reason is required for everything except an approval;
   *  3. the lister is told, in-app and on their phone, with the reason
   *     verbatim (`notifyLister`). QueerPulse sends no email;
   *  4. an immutable `mod_audit_logs` row is written alongside the
   *     denormalised last-decision columns on the listing itself.
   *
   * Approving also emits `HOUSING_LISTING_WENT_LIVE`, which is what the housing
   * saved-search alert listener consumes.
   */
  async decide(
    ref: string,
    moderatorId: string,
    dto: DecideHousingListingDto,
  ): Promise<AdminHousingListingDTO> {
    const target = DECISION_TARGETS[dto.decision];
    // Stripped at the write boundary like every other stored free-text field:
    // this one is written by staff, but it is still shown to a member verbatim.
    const reason = toStoredPlainText(dto.reason ?? '');
    if (target.isReasonRequired && reason.length === 0) {
      throw new BadRequestException(
        'A reason is required for this decision, and the lister is shown it verbatim',
      );
    }

    const listing = await this.loadOr404(ref);
    const wasLive = listing.status === HousingListingStatus.Live;

    if (dto.decision === HousingListingDecision.TakeDown && !wasLive) {
      throw new BadRequestException(
        'Only a live listing can be taken down; reject it instead',
      );
    }
    if (listing.status === target.status) {
      throw new BadRequestException(
        'This listing is already in that state; no decision was recorded',
      );
    }

    listing.status = target.status;
    // A listing can wait in the queue longer than its own 60-day window. Going
    // live already expired means public browse withholds it the instant it is
    // published (`status = live AND expires_at > now`), so the lister would be
    // told their home is live and see nothing on the board. Approval refreshes
    // the window; every other decision leaves it alone.
    if (
      dto.decision === HousingListingDecision.Approve &&
      listing.expiresAt.getTime() <= Date.now()
    ) {
      listing.expiresAt = computeExpiry();
    }
    listing.decisionReason = reason.length ? reason : null;
    listing.decidedById = moderatorId;
    listing.decidedAt = new Date();
    const saved = await this.listings.save(listing);

    // A listing transitioning INTO live (a new listing clearing review, or a
    // re-approval after an owner edit) is the moment saved-search alerts fire.
    // Compute the verified state once here — it needs the lister's assurance
    // level — and hand it to the alerts listener so it never re-derives it per
    // saved search.
    if (!wasLive && saved.status === HousingListingStatus.Live) {
      const level = await this.listerVerificationLevel(saved.ownerId);
      const event: HousingListingWentLiveEvent = {
        listing: saved,
        listingVerified: deriveListingVerified(saved, level).verified,
      };
      this.eventEmitter.emit(HOUSING_LISTING_WENT_LIVE, event);
    }

    await this.writeAuditRow(saved, moderatorId, target.auditAction, reason);
    await this.notifyLister(saved, dto.decision, reason);

    const [mapped] = await this.mapRowsForAdmin([saved]);
    // invariant: `mapRowsForAdmin` returns one row per input row.
    return mapped!;
  }

  // --- internals ------------------------------------------------------------

  /** Moderator-scoped load: the one place in housing that may read a listing
   * belonging to somebody else. Owner paths use `loadOwnedOr404` instead. */
  private async loadOr404(ref: string): Promise<HousingListing> {
    const listing = await this.listings.findOne({ where: { ref } });
    if (!listing) {
      throw new NotFoundException('Housing listing not found');
    }
    return listing;
  }

  /**
   * Tells the lister what was decided, in-app plus push, with the moderator's
   * reason verbatim. No actor id: the bell must never name which moderator
   * acted (the same call `CommunityBanned` makes), and a decision on your own
   * listing must not be suppressible by a block between the two of you.
   *
   * Best-effort. A notification failure must never fail the moderator's
   * decision, which is already committed by the time this runs.
   */
  private async notifyLister(
    listing: HousingListing,
    decision: HousingListingDecision,
    reason: string,
  ): Promise<void> {
    // NULL once the lister erased their account: there is no inbox left.
    if (listing.ownerId === null) return;
    try {
      await this.notifications.create(
        listing.ownerId,
        NotificationType.HousingListingDecision,
        {
          source: 'housing',
          slug: listing.slug,
          title: listing.title,
          decision,
          ...(reason.length ? { reason } : {}),
        },
      );
    } catch (error) {
      this.logger.warn(
        `Housing decision notification failed for ${listing.ref}: ${String(error)}`,
      );
    }
  }

  /**
   * One immutable row in the shared moderation trail, so a housing decision is
   * visible in the same audit feed as every other moderator action instead of
   * living only as three denormalised columns that the next decision overwrites.
   *
   * `targetUserId` + `targetName` name the LISTER (the member acted upon), the
   * same way `AdminMembersService`'s role actions do; `reportId` stays null
   * because a moderation decision on a listing is not a response to any
   * particular report.
   */
  private async writeAuditRow(
    listing: HousingListing,
    moderatorId: string,
    action: string,
    reason: string,
  ): Promise<void> {
    const listerName = await this.listerDisplayName(listing.ownerId);
    await this.modAuditLogs.save(
      this.modAuditLogs.create({
        reportId: null,
        actorId: moderatorId,
        action,
        targetUserId: listing.ownerId,
        targetName: listerName,
        reasonCode: null,
        // The listing's own ref belongs in the trail: without it a row says a
        // member was acted upon but not which of their homes it was about.
        note: reason.length ? `${listing.ref}: ${reason}` : listing.ref,
        duration: null,
      }),
    );
  }

  private async listerDisplayName(
    ownerId: string | null,
  ): Promise<string | null> {
    if (ownerId === null) return null;
    const refs = await new MemberLookup(this.profiles).byUserIds([ownerId]);
    const ref = refs.get(ownerId);
    return ref ? `${ref.firstName} ${ref.lastName}`.trim() : null;
  }

  /**
   * The lister's assurance level, tolerating an erased lister (mirrors
   * `HousingListingsService.listerVerificationLevel`).
   */
  private async listerVerificationLevel(
    ownerId: string | null,
  ): Promise<VerificationLevel> {
    return ownerId === null
      ? VerificationLevel.Email
      : this.verification.levelForUser(ownerId);
  }

  /**
   * Admin rows: the public DTO with `precise: true` (a moderator reviewing a
   * real home sees its real address) plus the risk signals, the deciding
   * moderator, and the lister's prior record. Every hydration is batched across
   * the whole page — one profile query, one verification query, one history
   * query, one moderator query — so the queue costs a fixed number of
   * round-trips regardless of page size.
   */
  private async mapRowsForAdmin(
    rows: HousingListing[],
  ): Promise<AdminHousingListingDTO[]> {
    if (!rows.length) return [];
    const ownerIds = presentActorIds(rows.map((row) => row.ownerId));
    const listers = await new HousingListerLookup(this.profiles).byUserIds(
      ownerIds,
    );
    const levels = await this.verification.levelsForUsers(ownerIds);
    const histories = await this.listerHistories(ownerIds);
    const moderatorIds = presentActorIds(rows.map((row) => row.decidedById));
    const moderators = await new MemberLookup(this.profiles).byUserIds(
      moderatorIds,
    );

    return rows.map((row) =>
      toAdminHousingListingDTO(
        row,
        actorFromLookup(listers, row.ownerId) ?? null,
        actorFromLookup(levels, row.ownerId) ?? VerificationLevel.Email,
        actorFromLookup(histories, row.ownerId) ?? null,
        actorFromLookup(moderators, row.decidedById) ?? null,
      ),
    );
  }

  /**
   * "Have we decided about this person before?" for every lister on the page,
   * in ONE grouped query rather than one per row.
   *
   * Counted from `housing_listings.status` rather than from the audit trail on
   * purpose: status is the current truth (a rejected listing the lister then
   * fixed is back in `review` and no longer counts against them), backed by
   * `IDX_housing_listings_owner_id`, and it cannot be skewed by a decision that
   * was later reversed.
   */
  private async listerHistories(
    ownerIds: string[],
  ): Promise<Map<string, HousingListerHistoryDTO>> {
    const historiesByOwnerId = new Map<string, HousingListerHistoryDTO>();
    if (!ownerIds.length) return historiesByOwnerId;

    const rows = await this.listings
      .createQueryBuilder('l')
      .select('l.owner_id', 'ownerId')
      .addSelect('l.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where({ ownerId: In(ownerIds) })
      .groupBy('l.owner_id')
      .addGroupBy('l.status')
      .getRawMany<{
        ownerId: string;
        status: HousingListingStatus;
        count: string;
      }>();

    for (const ownerId of ownerIds) {
      historiesByOwnerId.set(ownerId, {
        totalListings: 0,
        liveListings: 0,
        changesRequestedListings: 0,
        rejectedListings: 0,
        takenDownListings: 0,
        hasCleanRecord: true,
      });
    }
    for (const row of rows) {
      const history = historiesByOwnerId.get(row.ownerId);
      if (!history) continue;
      const count = Number(row.count);
      history.totalListings += count;
      if (row.status === HousingListingStatus.Live) {
        history.liveListings += count;
      } else if (row.status === HousingListingStatus.Question) {
        history.changesRequestedListings += count;
      } else if (row.status === HousingListingStatus.Rejected) {
        history.rejectedListings += count;
      } else if (row.status === HousingListingStatus.TakenDown) {
        history.takenDownListings += count;
      }
    }
    for (const history of historiesByOwnerId.values()) {
      history.hasCleanRecord =
        history.rejectedListings === 0 && history.takenDownListings === 0;
    }
    return historiesByOwnerId;
  }
}
