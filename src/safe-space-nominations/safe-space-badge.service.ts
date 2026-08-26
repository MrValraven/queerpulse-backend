import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import {
  Listing,
  ListingStatus,
  SafeSpaceStatus,
} from '../listings/entities/listing.entity';
import { SafeSpaceVisitsService } from '../safe-space-vouches/safe-space-visits.service';
import { SafeSpaceBadgeSuspension } from './entities/safe-space-badge-suspension.entity';
import { SafeSpaceFlag } from './entities/safe-space-flag.entity';
import {
  SAFE_SPACE_NOMINATION_OPEN_STATUSES,
  SafeSpaceNomination,
} from './entities/safe-space-nomination.entity';
import {
  SafeSpaceAuditAction,
  SafeSpaceAuditService,
} from './safe-space-audit.service';
import {
  AdminSafeSpaceSuspensionResponse,
  SafeSpaceBadgeStateResponse,
  SafeSpaceReReviewDueResponse,
  toAdminSafeSpaceSuspensionResponse,
  toSafeSpaceBadgeStateResponse,
} from './safe-space-badge-response';
import {
  SafeSpaceNotificationAction,
  SafeSpaceNotifierService,
} from './safe-space-notifier.service';
import {
  SAFE_SPACE_RE_REVIEW_INTERVAL_DAYS,
  reReviewDueAt,
  toDateColumnValue,
} from './safe-space-policy';

const DAY_IN_MS = 24 * 60 * 60 * 1000;

/**
 * The state of a safe-space badge, and the only writer of a temporary
 * suspension of one.
 *
 * WHAT A SUSPENSION IS. `listings.safe_space_status` stays `verified`
 * throughout: the badge WAS granted and that grant is not being rewritten. An
 * open `safe_space_badge_suspensions` row says the grant does not currently
 * speak for the place. Read paths must treat `verified + open suspension` as
 * NOT verified, which is what `getBadgeState` returns and what the directory
 * read path needs to join on (see the report's central-edit note).
 *
 * Nothing here awards a badge. Awarding is a decision a person makes, in
 * `SafeSpaceNominationsService.decide`.
 */
@Injectable()
export class SafeSpaceBadgeService {
  constructor(
    @InjectRepository(Listing)
    private readonly listings: Repository<Listing>,
    @InjectRepository(SafeSpaceFlag)
    private readonly flags: Repository<SafeSpaceFlag>,
    @InjectRepository(SafeSpaceBadgeSuspension)
    private readonly suspensions: Repository<SafeSpaceBadgeSuspension>,
    @InjectRepository(SafeSpaceNomination)
    private readonly nominations: Repository<SafeSpaceNomination>,
    private readonly visits: SafeSpaceVisitsService,
    private readonly audits: SafeSpaceAuditService,
    private readonly notifier: SafeSpaceNotifierService,
  ) {}

  // --- Lookups ------------------------------------------------------------

  /** Resolve a listing by its `ref` OR its `slug`, the way every other
   * `:ref`-addressed listing route does. Moderator-facing, so a listing still
   * in review resolves too. */
  async resolveByRef(ref: string): Promise<Listing> {
    const trimmed = ref.trim();
    const listing = await this.listings.findOne({
      where: [{ ref: trimmed }, { slug: trimmed }],
    });
    if (!listing) throw new NotFoundException('Listing not found');
    return listing;
  }

  /** Resolve a publicly reachable space by slug. Matches the 404 conditions of
   * `DirectoryService.getSafeSpaceBySlug`, so a member can never flag or read
   * the state of something they cannot see. */
  async resolvePublicSpaceBySlug(slug: string): Promise<Listing> {
    const listing = await this.listings.findOne({
      where: {
        slug: slug.trim(),
        status: ListingStatus.Live,
        isHiddenByOwner: false,
      },
    });
    if (!listing) throw new NotFoundException('Safe space not found');
    return listing;
  }

  /** The open (unlifted) suspension for a listing, if any. */
  async openSuspension(
    listingId: string,
  ): Promise<SafeSpaceBadgeSuspension | null> {
    return this.suspensions.findOne({
      where: { listingId, liftedAt: IsNull() },
    });
  }

  /** Open suspensions for many listings, keyed by listing id. One query. */
  async openSuspensionsByListing(
    listingIds: string[],
  ): Promise<Map<string, SafeSpaceBadgeSuspension>> {
    const byListing = new Map<string, SafeSpaceBadgeSuspension>();
    if (!listingIds.length) return byListing;
    const rows = await this.suspensions.find({
      where: { listingId: In(listingIds), liftedAt: IsNull() },
    });
    for (const row of rows) byListing.set(row.listingId, row);
    return byListing;
  }

  /** Open flag counts for many listings, keyed by listing id. One grouped
   * query, so a queue page never fans out per row. */
  async openFlagCounts(listingIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!listingIds.length) return counts;
    const rows = await this.flags
      .createQueryBuilder('flag')
      .select('flag.listingId', 'listingId')
      .addSelect('COUNT(*)', 'count')
      .where('flag.listingId IN (:...listingIds)', { listingIds })
      .andWhere('flag.withdrawnAt IS NULL')
      .andWhere('flag.resolvedAt IS NULL')
      .groupBy('flag.listingId')
      .getRawMany<{ listingId: string; count: string }>();
    for (const row of rows) {
      counts.set(row.listingId, Number(row.count));
    }
    return counts;
  }

  /** Open flags on one listing, newest first. Moderator-facing only. */
  async openFlagsForListing(listingId: string): Promise<SafeSpaceFlag[]> {
    return this.flags.find({
      where: { listingId, withdrawnAt: IsNull(), resolvedAt: IsNull() },
      order: { createdAt: 'ASC' },
    });
  }

  // --- The member-facing badge state --------------------------------------

  /**
   * What a member is told about a badge. Carries no flag count and no flagger
   * identity: see `SafeSpaceBadgeStateResponse`.
   */
  async getBadgeState(
    slug: string,
    viewerId: string,
  ): Promise<SafeSpaceBadgeStateResponse> {
    const listing = await this.resolvePublicSpaceBySlug(slug);
    const [suspension, openNominations, viewerFlag] = await Promise.all([
      this.openSuspension(listing.id),
      this.nominations.count({
        where: {
          listingId: listing.id,
          status: In(SAFE_SPACE_NOMINATION_OPEN_STATUSES),
        },
      }),
      this.flags.findOne({
        where: {
          listingId: listing.id,
          flaggerId: viewerId,
          withdrawnAt: IsNull(),
          resolvedAt: IsNull(),
        },
      }),
    ]);
    const nominatorId = await this.nominatorIdFor(listing.id);
    const visits = await this.visits.tallyForListing(listing.id, nominatorId);
    return toSafeSpaceBadgeStateResponse({
      listingId: listing.id,
      slug: listing.slug,
      safeSpaceStatus: listing.safeSpaceStatus,
      tier: listing.safeSpaceTier,
      verifier: listing.safeSpaceVerifier,
      badgeAwardedAt: listing.safeSpaceReVerifiedAt,
      suspension,
      hasOpenNomination: openNominations > 0,
      visits,
      viewerHasFlagged: viewerFlag !== null,
    });
  }

  /** The nominator of the most recent open nomination for a listing, so their
   * own vouch is excluded from the independent-visit count. */
  async nominatorIdFor(listingId: string): Promise<string | null> {
    const nomination = await this.nominations.findOne({
      where: {
        listingId,
        status: In(SAFE_SPACE_NOMINATION_OPEN_STATUSES),
      },
      order: { createdAt: 'DESC' },
    });
    return nomination?.nominatorId ?? null;
  }

  // --- Suspension ---------------------------------------------------------

  /**
   * The published promise, enforced: the third open flag against a badged space
   * suspends the badge immediately and raises a review.
   *
   * Idempotent by construction. A partial UNIQUE index over `listing_id` where
   * `lifted_at IS NULL` means two flags crossing the threshold at once cannot
   * open two suspensions; the loser reads the winner's row and returns it.
   *
   * `flaggerIds` are notified that a review is open, so the members who raised
   * it learn the platform acted. They are notified through
   * `SafeSpaceNotifierService`, which never attaches an actor, so the OWNER's
   * notification about the same event cannot name them.
   */
  async suspendForFlagThreshold(
    listing: Listing,
    flagCount: number,
    flaggerIds: (string | null)[],
  ): Promise<SafeSpaceBadgeSuspension> {
    const existing = await this.openSuspension(listing.id);
    if (existing) return existing;

    const reason =
      `Automatically suspended: ${flagCount} members flagged this space, ` +
      'which the safe-space policy says triggers an immediate review.';
    let suspension: SafeSpaceBadgeSuspension;
    try {
      suspension = await this.suspensions.save(
        this.suspensions.create({
          listingId: listing.id,
          cause: 'flag_threshold',
          flagCountAtSuspension: flagCount,
          suspendedBy: null,
          reason,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        const winner = await this.openSuspension(listing.id);
        if (winner) return winner;
      }
      throw error;
    }

    await this.audits.record({
      subjectType: 'badge',
      subjectId: suspension.id,
      listingId: listing.id,
      action: SafeSpaceAuditAction.BadgeSuspended,
      actorId: null,
      reason,
      metadata: { cause: 'flag_threshold', flagCount },
    });

    // The owner learns their badge is paused and why, and never who said so.
    await this.notifier.tell(
      [listing.ownerId],
      SafeSpaceNotificationAction.BadgeSuspended,
      'The safe-space badge on your listing is paused while we review it. ' +
        'Someone from the review team will be in touch.',
      listing.slug,
    );
    // The members who flagged learn the platform acted on it.
    await this.notifier.tell(
      flaggerIds,
      SafeSpaceNotificationAction.FlagReviewOpened,
      `The safe-space badge on ${listing.name} is paused while we review what was raised.`,
      listing.slug,
    );
    return suspension;
  }

  /** A moderator suspends a badge directly, without waiting for three flags. */
  async suspendByModerator(
    ref: string,
    actorId: string,
    reason: string,
  ): Promise<AdminSafeSpaceSuspensionResponse> {
    const listing = await this.resolveByRef(ref);
    if (listing.safeSpaceStatus !== SafeSpaceStatus.Verified) {
      throw new BadRequestException(
        'This listing does not carry a safe-space badge',
      );
    }
    const existing = await this.openSuspension(listing.id);
    if (existing) {
      throw new ConflictException('This badge is already suspended');
    }
    const openFlagCount = (await this.openFlagCounts([listing.id])).get(
      listing.id,
    );
    const suspension = await this.suspensions.save(
      this.suspensions.create({
        listingId: listing.id,
        cause: 'moderator',
        flagCountAtSuspension: openFlagCount ?? 0,
        suspendedBy: actorId,
        reason: reason.trim(),
      }),
    );
    await this.audits.record({
      subjectType: 'badge',
      subjectId: suspension.id,
      listingId: listing.id,
      action: SafeSpaceAuditAction.BadgeSuspended,
      actorId,
      reason: reason.trim(),
      metadata: { cause: 'moderator', openFlagCount: openFlagCount ?? 0 },
    });
    await this.notifier.tell(
      [listing.ownerId],
      SafeSpaceNotificationAction.BadgeSuspended,
      'The safe-space badge on your listing is paused while we review it. ' +
        'Someone from the review team will be in touch.',
      listing.slug,
    );
    return toAdminSafeSpaceSuspensionResponse(suspension);
  }

  /**
   * Lift a suspension and let the badge speak again.
   *
   * Any flag still open at this point is closed as `dismissed` with the lift
   * reason: leaving them open would hold the count at or above the threshold,
   * so the very next flag would re-suspend a badge a moderator has just
   * decided is sound. A moderator who wants a flag recorded as UPHELD resolves
   * it individually first, and this then finds nothing left to close.
   */
  async restore(
    ref: string,
    actorId: string,
    reason: string,
  ): Promise<AdminSafeSpaceSuspensionResponse> {
    const listing = await this.resolveByRef(ref);
    const suspension = await this.openSuspension(listing.id);
    if (!suspension) {
      throw new NotFoundException('This badge is not suspended');
    }
    const now = new Date();
    const trimmedReason = reason.trim();
    const stillOpen = await this.openFlagsForListing(listing.id);
    if (stillOpen.length) {
      await this.flags.update(
        { id: In(stillOpen.map((flag) => flag.id)) },
        {
          resolvedAt: now,
          resolvedBy: actorId,
          resolution: 'dismissed',
          resolutionNote: trimmedReason,
        },
      );
    }
    await this.suspensions.update(
      { id: suspension.id },
      { liftedAt: now, liftedBy: actorId, liftReason: trimmedReason },
    );
    await this.audits.record({
      subjectType: 'badge',
      subjectId: suspension.id,
      listingId: listing.id,
      action: SafeSpaceAuditAction.BadgeRestored,
      actorId,
      reason: trimmedReason,
      metadata: { dismissedFlagCount: stillOpen.length },
    });
    await this.notifier.tell(
      [listing.ownerId],
      SafeSpaceNotificationAction.BadgeRestored,
      'The review finished and the safe-space badge on your listing is live again.',
      listing.slug,
    );
    await this.notifier.tell(
      stillOpen.map((flag) => flag.flaggerId),
      SafeSpaceNotificationAction.BadgeRestored,
      `The review of ${listing.name} finished. Thank you for raising it.`,
      listing.slug,
    );
    const lifted = await this.suspensions.findOne({
      where: { id: suspension.id },
    });
    return toAdminSafeSpaceSuspensionResponse(lifted ?? suspension);
  }

  // --- Annual re-review ---------------------------------------------------

  /**
   * Badges that have been speaking for themselves for over a year, oldest
   * first. A badge with NO recorded award date is included: a badge whose
   * provenance nobody wrote down is exactly the kind this queue exists to
   * catch.
   */
  async listReReviewDue(
    limit = 100,
    now: Date = new Date(),
  ): Promise<SafeSpaceReReviewDueResponse[]> {
    const cutoff = toDateColumnValue(
      new Date(now.getTime() - SAFE_SPACE_RE_REVIEW_INTERVAL_DAYS * DAY_IN_MS),
    );
    const rows = await this.listings
      .createQueryBuilder('listing')
      .where('listing.safeSpaceStatus = :verified', {
        verified: SafeSpaceStatus.Verified,
      })
      .andWhere('listing.status = :live', { live: ListingStatus.Live })
      .andWhere(
        '(listing.safeSpaceReVerifiedAt IS NULL OR listing.safeSpaceReVerifiedAt <= :cutoff)',
        { cutoff },
      )
      .orderBy('listing.safeSpaceReVerifiedAt', 'ASC', 'NULLS FIRST')
      .limit(limit)
      .getMany();

    const listingIds = rows.map((listing) => listing.id);
    const [suspensions, flagCounts] = await Promise.all([
      this.openSuspensionsByListing(listingIds),
      this.openFlagCounts(listingIds),
    ]);

    return rows.map((listing) => {
      const due = reReviewDueAt(listing.safeSpaceReVerifiedAt);
      const daysOverdue = due
        ? Math.max(0, Math.floor((now.getTime() - due.getTime()) / DAY_IN_MS))
        : 0;
      return {
        listingId: listing.id,
        ref: listing.ref,
        slug: listing.slug,
        name: listing.name,
        tier: listing.safeSpaceTier,
        badgeAwardedAt: listing.safeSpaceReVerifiedAt,
        reReviewDueAt: due?.toISOString() ?? null,
        daysOverdue,
        isBadgeSuspended: suspensions.has(listing.id),
        openFlagCount: flagCounts.get(listing.id) ?? 0,
      };
    });
  }

  /** How many badges are currently past their annual re-review. Used by the
   * scheduled sweep, which only needs the number. */
  async countReReviewDue(now: Date = new Date()): Promise<number> {
    const cutoff = toDateColumnValue(
      new Date(now.getTime() - SAFE_SPACE_RE_REVIEW_INTERVAL_DAYS * DAY_IN_MS),
    );
    return this.listings
      .createQueryBuilder('listing')
      .where('listing.safeSpaceStatus = :verified', {
        verified: SafeSpaceStatus.Verified,
      })
      .andWhere('listing.status = :live', { live: ListingStatus.Live })
      .andWhere(
        '(listing.safeSpaceReVerifiedAt IS NULL OR listing.safeSpaceReVerifiedAt <= :cutoff)',
        { cutoff },
      )
      .getCount();
  }

  /** Listings with an open suspension, for the moderation queue's header. */
  async countOpenSuspensions(): Promise<number> {
    return this.suspensions.count({ where: { liftedAt: IsNull() } });
  }
}
