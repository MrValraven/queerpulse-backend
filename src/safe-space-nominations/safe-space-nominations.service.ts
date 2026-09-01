import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { Listing, SafeSpaceStatus } from '../listings/entities/listing.entity';
import { SafeSpaceVisitsService } from '../safe-space-vouches/safe-space-visits.service';
import { AdminNominationsQuery } from './dto/admin-nominations.query';
import { CreateSafeSpaceNominationDto } from './dto/create-safe-space-nomination.dto';
import {
  AcknowledgeNominationDto,
  AssignNominationDto,
  DecideNominationDto,
  ReopenNominationDto,
} from './dto/review-nomination.dto';
import {
  SAFE_SPACE_NOMINATION_OPEN_STATUSES,
  SafeSpaceNomination,
} from './entities/safe-space-nomination.entity';
import {
  SafeSpaceAuditAction,
  SafeSpaceAuditService,
} from './safe-space-audit.service';
import { SafeSpaceBadgeService } from './safe-space-badge.service';
import {
  SafeSpaceAuditResponse,
  toSafeSpaceAuditResponse,
} from './safe-space-badge-response';
import {
  AdminNominationListingSummary,
  AdminSafeSpaceNominationResponse,
  SafeSpaceNominationResponse,
  toAdminSafeSpaceNominationResponse,
  toSafeSpaceNominationResponse,
} from './safe-space-nomination-response';
import {
  SafeSpaceNotificationAction,
  SafeSpaceNotifierService,
} from './safe-space-notifier.service';
import {
  SAFE_SPACE_ACKNOWLEDGEMENT_HOURS,
  isDueForReReview,
  reReviewDueAt,
  toDateColumnValue,
} from './safe-space-policy';

/** States a nomination may still be acted on from. */
const DECIDABLE_STATUSES = ['acknowledged', 'in_review'] as const;

/**
 * The safe-space nomination review process, end to end.
 *
 * WHAT CHANGED AND WHY. A nomination used to be written `pending` and then sit
 * there: no endpoint could move it, no queue read it, and the published copy
 * promised a six-step process (acknowledged in 48 hours, three independent
 * member visits, a review panel, a badge, an annual re-review, three flags
 * trigger a suspension) that nothing in the codebase could carry out. This
 * service is those steps, in order, each one recording who acted and why.
 *
 * NOTHING IS AUTOMATIC. The visit tally, the 48-hour clock and the flag count
 * are all reported TO a moderator; none of them award, decline or restore
 * anything on their own. A badge that a rule granted would be exactly as
 * unearned as a badge one person typed.
 */
@Injectable()
export class SafeSpaceNominationsService {
  constructor(
    @InjectRepository(SafeSpaceNomination)
    private readonly nominations: Repository<SafeSpaceNomination>,
    @InjectRepository(Listing)
    private readonly listings: Repository<Listing>,
    private readonly visits: SafeSpaceVisitsService,
    private readonly badges: SafeSpaceBadgeService,
    private readonly audits: SafeSpaceAuditService,
    private readonly notifier: SafeSpaceNotifierService,
    private readonly adminQueueNotifications: AdminQueueNotificationsService,
  ) {}

  /** Record a member's nomination. Always lands in the `pending` queue, which
   * is where the 48-hour acknowledgement clock starts. */
  async create(
    nominatorId: string,
    dto: CreateSafeSpaceNominationDto,
  ): Promise<SafeSpaceNominationResponse> {
    const nomination = this.nominations.create({
      nominatorId,
      placeName: dto.placeName.trim(),
      address: dto.address?.trim() || null,
      placeType: dto.placeType?.trim() || null,
      listingRef: dto.listingRef?.trim() || null,
      reason: dto.reason?.trim() || null,
      status: 'pending',
    });
    const saved = await this.nominations.save(nomination);
    // Tell whoever works the safe-space nomination queue that a nomination
    // landed. Awaited, but safe to await: `announce` catches everything
    // internally, so a notification failure can never fail the member's
    // submission.
    await this.adminQueueNotifications.announce(
      AdminQueueKey.SafeSpaceNominations,
      saved.id,
    );
    return toSafeSpaceNominationResponse(saved);
  }

  /** A member's own nominations, so "we'll review it" is followable. */
  async listMine(
    nominatorId: string,
  ): Promise<{ items: SafeSpaceNominationResponse[] }> {
    const rows = await this.nominations.find({
      where: { nominatorId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
    return { items: rows.map(toSafeSpaceNominationResponse) };
  }

  // --- The operator's queue ------------------------------------------------

  /**
   * The admin review queue. Defaults to the OPEN nominations, oldest first,
   * because the queue exists to keep a 48-hour promise and oldest-first is that
   * promise sorted.
   *
   * Every row carries its age, whether it has breached the window, and (once
   * assigned) the independent visit tally, so a moderator can work the queue
   * without opening a row to find out whether it needs them.
   */
  async listForAdmin(
    query: AdminNominationsQuery,
    now: Date = new Date(),
  ): Promise<{ items: AdminSafeSpaceNominationResponse[]; total: number }> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const builder = this.nominations
      .createQueryBuilder('nomination')
      .orderBy('nomination.createdAt', query.sort === 'newest' ? 'DESC' : 'ASC')
      .offset(offset)
      .limit(limit);

    if (query.status) {
      builder.andWhere('nomination.status = :status', {
        status: query.status,
      });
    } else if ((query.scope ?? 'open') === 'open') {
      builder.andWhere('nomination.status IN (:...open)', {
        open: SAFE_SPACE_NOMINATION_OPEN_STATUSES,
      });
    } else if (query.scope === 'decided') {
      builder.andWhere('nomination.status IN (:...decided)', {
        decided: ['approved', 'rejected'],
      });
    }
    if (query.breachedOnly) {
      builder
        .andWhere('nomination.acknowledgedAt IS NULL')
        .andWhere(`nomination.createdAt < :breachCutoff`, {
          breachCutoff: this.acknowledgementCutoff(now),
        });
    }
    if (query.assignedOnly) {
      builder.andWhere('nomination.listingId IS NOT NULL');
    }
    if (query.search) {
      builder.andWhere('nomination.placeName ILIKE :search', {
        search: `%${query.search.trim()}%`,
      });
    }

    const [rows, total] = await builder.getManyAndCount();
    const items = await this.decorateForAdmin(rows, now);
    return { items, total };
  }

  /** One nomination, with everything the decision needs on it. */
  async getForAdmin(
    id: string,
    now: Date = new Date(),
  ): Promise<AdminSafeSpaceNominationResponse> {
    const nomination = await this.mustFind(id);
    const [decorated] = await this.decorateForAdmin([nomination], now);
    if (!decorated) throw new NotFoundException('Nomination not found');
    return decorated;
  }

  /** The moderator-only audit trail for one nomination. */
  async auditForAdmin(id: string): Promise<SafeSpaceAuditResponse[]> {
    await this.mustFind(id);
    const rows = await this.audits.listForSubject('nomination', id);
    return rows.map(toSafeSpaceAuditResponse);
  }

  // --- The decision path ---------------------------------------------------

  /**
   * Step one of the published six: "we acknowledge your nomination within 48
   * hours". Stamping this is what stops the clock, and the nominator is told,
   * because an acknowledgement nobody receives is not one.
   */
  async acknowledge(
    id: string,
    actorId: string,
    dto: AcknowledgeNominationDto,
  ): Promise<AdminSafeSpaceNominationResponse> {
    const nomination = await this.mustFind(id);
    if (nomination.acknowledgedAt) {
      throw new BadRequestException('This nomination is already acknowledged');
    }
    const note = dto.note?.trim() || null;
    await this.nominations.update(
      { id: nomination.id },
      {
        status: 'acknowledged',
        acknowledgedAt: new Date(),
        acknowledgedBy: actorId,
      },
    );
    await this.audits.record({
      subjectType: 'nomination',
      subjectId: nomination.id,
      listingId: nomination.listingId,
      action: SafeSpaceAuditAction.NominationAcknowledged,
      actorId,
      reason: note,
    });
    await this.notifier.tell(
      [nomination.nominatorId],
      SafeSpaceNotificationAction.NominationAcknowledged,
      `We have your nomination of ${nomination.placeName} and a reviewer is on it.`,
    );
    return this.getForAdmin(id);
  }

  /**
   * Step two: tie the nomination to the business under review and open it for
   * the three independent member visits.
   *
   * Assigning also acknowledges a nomination that had not been acknowledged
   * yet. Somebody who has picked the listing has plainly received it, and
   * leaving the clock running on a nomination already in review would report a
   * breach that is not one.
   */
  async assign(
    id: string,
    actorId: string,
    dto: AssignNominationDto,
  ): Promise<AdminSafeSpaceNominationResponse> {
    const nomination = await this.mustFind(id);
    if (nomination.decidedAt) {
      throw new BadRequestException(
        'This nomination is already decided. Re-open it first.',
      );
    }
    const listing = await this.badges.resolveByRef(dto.listingRef);
    const now = new Date();
    await this.nominations.update(
      { id: nomination.id },
      {
        listingId: listing.id,
        status: 'in_review',
        assignedAt: now,
        assignedBy: actorId,
        assignmentNote: dto.note?.trim() || null,
        ...(nomination.acknowledgedAt
          ? {}
          : { acknowledgedAt: now, acknowledgedBy: actorId }),
      },
    );
    await this.audits.record({
      subjectType: 'nomination',
      subjectId: nomination.id,
      listingId: listing.id,
      action: SafeSpaceAuditAction.NominationAssigned,
      actorId,
      reason: dto.note?.trim() || null,
      metadata: { listingRef: listing.ref, listingSlug: listing.slug },
    });
    return this.getForAdmin(id);
  }

  /**
   * Step three and four: the review panel decides, and a badge is granted or
   * the nomination is declined.
   *
   * A HUMAN DECIDES. The three-visit bar is reported on the response and
   * recorded in the audit row, and it does not block the award: a reviewer may
   * have grounds the count cannot see, and the record then says plainly that
   * they awarded with fewer. What is enforced is that a reason is written, that
   * an award names a real listing, and that the grant is dated so the annual
   * re-review has something to count from.
   */
  async decide(
    id: string,
    actorId: string,
    dto: DecideNominationDto,
  ): Promise<AdminSafeSpaceNominationResponse> {
    const nomination = await this.mustFind(id);
    if (
      !DECIDABLE_STATUSES.includes(
        nomination.status as (typeof DECIDABLE_STATUSES)[number],
      )
    ) {
      throw new BadRequestException(
        'Only an acknowledged or in-review nomination can be decided',
      );
    }
    const reason = dto.reason.trim();
    const now = new Date();

    if (dto.outcome === 'decline') {
      await this.nominations.update(
        { id: nomination.id },
        {
          status: 'rejected',
          decidedAt: now,
          decidedBy: actorId,
          decisionReason: reason,
          awardedTier: null,
        },
      );
      await this.audits.record({
        subjectType: 'nomination',
        subjectId: nomination.id,
        listingId: nomination.listingId,
        action: SafeSpaceAuditAction.NominationDeclined,
        actorId,
        reason,
      });
      await this.notifier.tell(
        [nomination.nominatorId],
        SafeSpaceNotificationAction.NominationDeclined,
        `We reviewed ${nomination.placeName} and are not badging it for now. ${reason}`,
      );
      return this.getForAdmin(id);
    }

    if (!nomination.listingId) {
      throw new BadRequestException(
        'Assign the nomination to a listing before awarding a badge',
      );
    }
    if (!dto.tier) {
      throw new BadRequestException('A tier is required to award a badge');
    }
    const listing = await this.listings.findOne({
      where: { id: nomination.listingId },
    });
    if (!listing) {
      throw new NotFoundException('The assigned listing no longer exists');
    }
    const tally = await this.visits.tallyForListing(
      listing.id,
      nomination.nominatorId,
    );
    const verifier =
      dto.verifierLabel?.trim() ||
      `Review team, ${tally.independentVisitCount} independent member ${
        tally.independentVisitCount === 1 ? 'visit' : 'visits'
      }`;

    await this.listings.update(
      { id: listing.id },
      {
        safeSpaceStatus: SafeSpaceStatus.Verified,
        safeSpaceTier: dto.tier,
        safeSpaceVerifier: verifier,
        safeSpaceReVerifiedAt: toDateColumnValue(now),
      },
    );
    await this.nominations.update(
      { id: nomination.id },
      {
        status: 'approved',
        decidedAt: now,
        decidedBy: actorId,
        decisionReason: reason,
        awardedTier: dto.tier,
      },
    );
    await this.audits.record({
      subjectType: 'nomination',
      subjectId: nomination.id,
      listingId: listing.id,
      action: SafeSpaceAuditAction.NominationAwarded,
      actorId,
      reason,
      metadata: {
        tier: dto.tier,
        verifier,
        independentVisitCount: tally.independentVisitCount,
        requiredVisitCount: tally.requiredVisitCount,
        hasMetVisitBar: tally.hasMetVisitBar,
        awardedOn: toDateColumnValue(now),
      },
    });
    await this.notifier.tell(
      [nomination.nominatorId],
      SafeSpaceNotificationAction.NominationAwarded,
      `${listing.name} is now a verified safe space. Thank you for nominating it.`,
      listing.slug,
    );
    await this.notifier.tell(
      [listing.ownerId],
      SafeSpaceNotificationAction.NominationAwarded,
      'Your listing now carries the QueerPulse safe-space badge.',
      listing.slug,
    );
    return this.getForAdmin(id);
  }

  /**
   * Re-open a decided nomination so it can move again. The decision itself is
   * never deleted: the audit trail keeps it, and this stamps the re-opening
   * with its own reason.
   *
   * Re-opening deliberately does NOT touch a badge that was already granted.
   * Taking a live badge away is a separate act with its own consequences for
   * the venue, and it belongs to `POST /admin/safe-spaces/:ref/badge/suspend`
   * and the existing moderator safe-space toggle, where it is visible as what
   * it is.
   */
  async reopen(
    id: string,
    actorId: string,
    dto: ReopenNominationDto,
  ): Promise<AdminSafeSpaceNominationResponse> {
    const nomination = await this.mustFind(id);
    if (!nomination.decidedAt) {
      throw new BadRequestException('This nomination has not been decided');
    }
    const reason = dto.reason.trim();
    await this.nominations.update(
      { id: nomination.id },
      {
        status: nomination.listingId ? 'in_review' : 'acknowledged',
        decidedAt: null,
        decidedBy: null,
        decisionReason: null,
        awardedTier: null,
        reopenedAt: new Date(),
      },
    );
    await this.audits.record({
      subjectType: 'nomination',
      subjectId: nomination.id,
      listingId: nomination.listingId,
      action: SafeSpaceAuditAction.NominationReopened,
      actorId,
      reason,
      metadata: {
        previousStatus: nomination.status,
        previousTier: nomination.awardedTier,
      },
    });
    return this.getForAdmin(id);
  }

  // --- Internals -----------------------------------------------------------

  /** Nominations still unacknowledged past the 48-hour promise, oldest first.
   * Used by the queue filter and by the scheduled sweep. */
  async findBreaching(
    now: Date = new Date(),
    limit = 100,
  ): Promise<SafeSpaceNomination[]> {
    return this.nominations
      .createQueryBuilder('nomination')
      .where('nomination.acknowledgedAt IS NULL')
      .andWhere('nomination.status = :pending', { pending: 'pending' })
      .andWhere('nomination.createdAt < :cutoff', {
        cutoff: this.acknowledgementCutoff(now),
      })
      .orderBy('nomination.createdAt', 'ASC')
      .limit(limit)
      .getMany();
  }

  private acknowledgementCutoff(now: Date): Date {
    // Received before this instant and still unacknowledged means the 48-hour
    // window has closed.
    return new Date(
      now.getTime() - SAFE_SPACE_ACKNOWLEDGEMENT_HOURS * 60 * 60 * 1000,
    );
  }

  private async mustFind(id: string): Promise<SafeSpaceNomination> {
    const nomination = await this.nominations.findOne({ where: { id } });
    if (!nomination) throw new NotFoundException('Nomination not found');
    return nomination;
  }

  /**
   * Attach the visit tally and the listing summary to a page of rows in a
   * bounded number of queries, so a 50-row queue never fans out per row.
   */
  private async decorateForAdmin(
    rows: SafeSpaceNomination[],
    now: Date,
  ): Promise<AdminSafeSpaceNominationResponse[]> {
    if (!rows.length) return [];
    const nominatorByListingId = new Map<string, string | null>();
    for (const nomination of rows) {
      if (nomination.listingId) {
        nominatorByListingId.set(nomination.listingId, nomination.nominatorId);
      }
    }
    const listingIds = [...nominatorByListingId.keys()];
    const [tallies, listings, suspensions, flagCounts] = await Promise.all([
      this.visits.tallyForListings(nominatorByListingId),
      listingIds.length
        ? this.listings.find({ where: { id: In(listingIds) } })
        : Promise.resolve([] as Listing[]),
      this.badges.openSuspensionsByListing(listingIds),
      this.badges.openFlagCounts(listingIds),
    ]);

    const summaries = new Map<string, AdminNominationListingSummary>();
    for (const listing of listings) {
      const due = reReviewDueAt(listing.safeSpaceReVerifiedAt);
      summaries.set(listing.id, {
        id: listing.id,
        ref: listing.ref,
        slug: listing.slug,
        name: listing.name,
        safeSpaceStatus: listing.safeSpaceStatus,
        isBadgeSuspended: suspensions.has(listing.id),
        badgeAwardedAt: listing.safeSpaceReVerifiedAt,
        reReviewDueAt: due?.toISOString() ?? null,
        isDueForReReview:
          listing.safeSpaceStatus === SafeSpaceStatus.Verified &&
          isDueForReReview(listing.safeSpaceReVerifiedAt, now),
        openFlagCount: flagCounts.get(listing.id) ?? 0,
      });
    }

    return rows.map((nomination) =>
      toAdminSafeSpaceNominationResponse(nomination, {
        visits: nomination.listingId
          ? (tallies.get(nomination.listingId) ?? null)
          : null,
        listing: nomination.listingId
          ? (summaries.get(nomination.listingId) ?? null)
          : null,
        now,
      }),
    );
  }
}
