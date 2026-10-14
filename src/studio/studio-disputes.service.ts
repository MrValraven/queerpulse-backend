import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { ModAuditService } from '../moderation/mod-audit.service';
import {
  StudioReleaseDispute,
  StudioReleaseDisputeDecision,
  StudioReleaseDisputeStatus,
} from './entities/studio-release-dispute.entity';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioCatalogService } from './studio-catalog.service';
import {
  StudioAdminDispute,
  toStudioAdminDispute,
} from './studio-dispute-response';
import { StudioModerationService } from './studio-moderation.service';
import { StudioOwnershipService } from './studio-ownership.service';
import { StudioReleaseResponse } from './studio-response';
import {
  STUDIO_AUDIT_ACTIONS,
  STUDIO_LIMITS,
  studioError,
} from './studio.constants';
import {
  STUDIO_RELEASE_DISPUTE_DECIDED,
  StudioReleaseDisputeDecidedEvent,
} from './studio.events';

/**
 * Studio open demo pages (section 5.2): an artist disputes a takedown of
 * their own release, and staff uphold it (the release comes back through
 * `StudioModerationService.restoreWithin`, in the same transaction) or
 * reject it, with a reply the owners read on the release page.
 *
 * NO MEMBER ID IS STORED. Filing goes through
 * `StudioOwnershipService.lockReleaseForWrite`, which checks that the
 * caller is the persona's creator or a co-owner and locks the release row;
 * the dispute row records the release and the note only.
 *
 * Every write locks the release row first and the dispute row second, so a
 * filing and a decision on one release run one at a time and never
 * deadlock. Audit rows name no target member and no report, like the
 * restore rows. A reject needs the release still taken down
 * (`studio_release_not_taken_down`); an uphold on a release that is
 * already live records the decision and leaves the release as it is. The
 * decision notice goes out after commit.
 */
@Injectable()
export class StudioDisputesService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(StudioReleaseDispute)
    private readonly disputes: Repository<StudioReleaseDispute>,
    private readonly ownership: StudioOwnershipService,
    private readonly catalog: StudioCatalogService,
    private readonly moderation: StudioModerationService,
    private readonly modAudit: ModAuditService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Files a dispute and answers the owner view of the release. */
  async file(
    userId: string,
    releaseId: string,
    note: string,
  ): Promise<StudioReleaseResponse> {
    await this.dataSource.transaction(async (manager) => {
      const { release } = await this.ownership.lockReleaseForWrite(
        manager,
        userId,
        releaseId,
      );
      if (release.status !== StudioReleaseStatus.TakenDown) {
        throw studioError('studio_release_not_taken_down');
      }
      const earlierDisputes = await manager.find(StudioReleaseDispute, {
        where: { releaseId: release.id },
        select: { id: true, status: true },
      });
      if (
        earlierDisputes.some(
          (dispute) => dispute.status === StudioReleaseDisputeStatus.Open,
        )
      ) {
        throw studioError('studio_dispute_already_open');
      }
      if (earlierDisputes.length >= STUDIO_LIMITS.disputesPerRelease) {
        throw studioError('studio_dispute_limit_reached');
      }
      try {
        await manager.insert(StudioReleaseDispute, {
          releaseId: release.id,
          note,
          status: StudioReleaseDisputeStatus.Open,
        });
      } catch (error) {
        // The release lock makes this unreachable today; the partial unique
        // index stays the last word if a future path files without it.
        if (
          isUniqueViolation(error, 'UQ_studio_release_disputes_open_release')
        ) {
          throw studioError('studio_dispute_already_open');
        }
        throw error;
      }
    });
    return this.catalog.getRelease(userId, releaseId);
  }

  uphold(
    actorId: string,
    disputeId: string,
    reply: string,
  ): Promise<StudioAdminDispute> {
    return this.decide(
      actorId,
      disputeId,
      reply,
      StudioReleaseDisputeStatus.Upheld,
    );
  }

  reject(
    actorId: string,
    disputeId: string,
    reply: string,
  ): Promise<StudioAdminDispute> {
    return this.decide(
      actorId,
      disputeId,
      reply,
      StudioReleaseDisputeStatus.Rejected,
    );
  }

  private async decide(
    actorId: string,
    disputeId: string,
    reply: string,
    decision: StudioReleaseDisputeDecision,
  ): Promise<StudioAdminDispute> {
    const releaseId = await this.dataSource.transaction(async (manager) => {
      const { dispute, release } = await this.lockOpenDispute(
        manager,
        disputeId,
      );
      // A reject keeps the release down, so it needs a release that is down.
      if (
        decision === StudioReleaseDisputeStatus.Rejected &&
        release?.status !== StudioReleaseStatus.TakenDown
      ) {
        throw studioError('studio_release_not_taken_down');
      }
      if (decision === StudioReleaseDisputeStatus.Upheld) {
        // A release someone already restored stays as it is; the dispute
        // is still recorded as upheld.
        await this.moderation.restoreWithin(
          manager,
          actorId,
          dispute.releaseId,
        );
      }
      dispute.status = decision;
      dispute.staffReply = reply;
      dispute.decidedById = actorId;
      dispute.decidedAt = new Date();
      await manager.save(dispute);
      await this.modAudit.writeAuditLog(
        null,
        actorId,
        decision === StudioReleaseDisputeStatus.Upheld
          ? STUDIO_AUDIT_ACTIONS.disputeUpheld
          : STUDIO_AUDIT_ACTIONS.disputeRejected,
        undefined,
        `${dispute.releaseId}: ${reply}`,
        undefined,
        manager,
        null,
      );
      return dispute.releaseId;
    });
    this.eventEmitter.emit(STUDIO_RELEASE_DISPUTE_DECIDED, {
      releaseId,
      disputeId,
      outcome: decision,
    } satisfies StudioReleaseDisputeDecidedEvent);
    return this.staffDispute(disputeId);
  }

  // The release row first, then the dispute row: the order `file` takes.
  // Answers both, the release as it stands under the lock.
  private async lockOpenDispute(
    manager: EntityManager,
    disputeId: string,
  ): Promise<{
    dispute: StudioReleaseDispute;
    release: StudioRelease | null;
  }> {
    const located = await manager.findOne(StudioReleaseDispute, {
      where: { id: disputeId },
      select: { id: true, releaseId: true },
    });
    if (!located) {
      throw new NotFoundException('Dispute not found');
    }
    const release = await manager.findOne(StudioRelease, {
      where: { id: located.releaseId },
      lock: { mode: 'pessimistic_write' },
    });
    const dispute = await manager.findOne(StudioReleaseDispute, {
      where: { id: disputeId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!dispute) {
      throw new NotFoundException('Dispute not found');
    }
    if (dispute.status !== StudioReleaseDisputeStatus.Open) {
      throw studioError('studio_dispute_not_open');
    }
    return { dispute, release };
  }

  private async staffDispute(disputeId: string): Promise<StudioAdminDispute> {
    const dispute = await this.disputes.findOne({ where: { id: disputeId } });
    const releaseSummary = dispute
      ? (await this.catalog.staffSummariesByReleaseId([dispute.releaseId])).get(
          dispute.releaseId,
        )
      : undefined;
    if (!dispute || !releaseSummary) {
      throw new NotFoundException('Dispute not found');
    }
    return toStudioAdminDispute(dispute, releaseSummary);
  }
}
