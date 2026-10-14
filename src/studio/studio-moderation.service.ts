import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager } from 'typeorm';
import { ModAuditService } from '../moderation/mod-audit.service';
import {
  StudioTakedownReportsInput,
  StudioTakedownReportService,
} from '../moderation/studio-takedown-report.service';
import { Report } from '../reports/entities/report.entity';
import {
  StudioReleaseDispute,
  StudioReleaseDisputeStatus,
} from './entities/studio-release-dispute.entity';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioReleaseResponse } from './studio-response';
import { scheduleDateInLisbon } from './studio-schedule-rule';
import { STUDIO_AUDIT_ACTIONS, studioError } from './studio.constants';
import {
  STUDIO_RELEASE_TAKEN_DOWN,
  StudioReleaseTakenDownEvent,
} from './studio.events';

interface TakedownOutcome {
  /** The release id when this call took it down; null when it was down. */
  takenDownReleaseId: string | null;
  /** Every open or escalated report about the release, now resolved. */
  resolvedReports: Report[];
}

/**
 * Studio v1: staff takedown and restore. Both lock the release row, are
 * idempotent, and write their `mod_audit_logs` row in the same transaction.
 * The audit row names no target member: the release belongs to a persona,
 * and the member drawer must never tie a pseudonymous persona to its owner.
 *
 * Restore returns a release to `published` only when it still holds a
 * `published_at`, which means it was live when it was taken down (unpublish
 * clears that column). A draft taken down comes back as a draft, so restore
 * never publishes anything that skipped the publish rule.
 *
 * Studio v3: a takedown clears a scheduled release's publish_at, so it never
 * drops while taken down and restore finds no published_at.
 *
 * Studio open demo pages: every takedown resolves every open or escalated
 * `studio_release` report about the release inside the same transaction
 * (`StudioTakedownReportService`), before the release changes; a takedown
 * started from one report (`reportId`) fails whole when that report does
 * not match, or when it is resolved and the release is still up. A named
 * report an earlier takedown resolved counts as done once the release is
 * down (a repeat submit). A takedown that changed the release emits
 * `STUDIO_RELEASE_TAKEN_DOWN` after commit for the owners' notice, and the
 * reporters get their receipts after commit. `restoreWithin` runs a
 * restore inside a caller's transaction, which the dispute uphold uses.
 * The staff restore route refuses a release with an open dispute
 * (`studio_release_has_open_dispute`), so staff decide that dispute in
 * flag review and the owners hear the outcome.
 */
@Injectable()
export class StudioModerationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly catalog: StudioCatalogService,
    private readonly modAudit: ModAuditService,
    private readonly takedownReports: StudioTakedownReportService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async takedown(
    actorId: string,
    releaseId: string,
    reason: string,
    reportId?: string,
  ): Promise<StudioReleaseResponse> {
    const { takenDownReleaseId, resolvedReports } =
      await this.dataSource.transaction<TakedownOutcome>(async (manager) => {
        const release = await this.lockRelease(manager, releaseId);
        const isAlreadyTakenDown =
          release.status === StudioReleaseStatus.TakenDown;
        // Reports first, so a mismatched named report refuses the whole
        // takedown before the release changes. A release that is already
        // down still has its open and escalated reports resolved, and its
        // owners get no second notice.
        const reports = await this.resolveReports(manager, {
          releaseId: release.id,
          actorId,
          reason,
          reportId,
          isOwnerNoticeSent: !isAlreadyTakenDown,
        });
        if (isAlreadyTakenDown) {
          return { takenDownReleaseId: null, resolvedReports: reports };
        }
        release.status = StudioReleaseStatus.TakenDown;
        release.takenDownAt = new Date();
        release.takenDownById = actorId;
        release.takedownReason = reason;
        // Studio v3: a scheduled release loses its time; the artist
        // reschedules after a restore, which brings it back as a draft.
        if (
          release.publishAt &&
          release.releasedOn === scheduleDateInLisbon(release.publishAt)
        ) {
          release.releasedOn = null;
        }
        release.publishAt = null;
        // A preview link dies with the takedown, so restore brings back no
        // link; the owner mints a fresh one when needed.
        release.previewToken = null;
        release.previewLinkCreatedAt = null;
        await manager.save(release);
        // One audit row per takedown, linked to the report it was started
        // from, so that report's history shows it.
        await this.modAudit.writeAuditLog(
          reportId ?? null,
          actorId,
          STUDIO_AUDIT_ACTIONS.releaseTakenDown,
          undefined,
          `${release.id}: ${reason}`,
          undefined,
          manager,
          null,
        );
        return { takenDownReleaseId: release.id, resolvedReports: reports };
      });
    if (takenDownReleaseId) {
      this.eventEmitter.emit(STUDIO_RELEASE_TAKEN_DOWN, {
        releaseId: takenDownReleaseId,
      } satisfies StudioReleaseTakenDownEvent);
    }
    if (resolvedReports.length) {
      await this.takedownReports.notifyReportersBestEffort(
        resolvedReports,
        actorId,
      );
    }
    return this.catalog.getReleaseForStaff(releaseId);
  }

  async restore(
    actorId: string,
    releaseId: string,
  ): Promise<StudioReleaseResponse> {
    await this.dataSource.transaction(async (manager) => {
      const release = await this.lockRelease(manager, releaseId);
      // An open dispute is decided through the uphold, which restores the
      // release and records the decision in one transaction. The release
      // lock keeps a filing from landing between this check and the save.
      const openDispute = await manager.findOne(StudioReleaseDispute, {
        where: {
          releaseId: release.id,
          status: StudioReleaseDisputeStatus.Open,
        },
        select: { id: true },
      });
      if (openDispute) {
        throw studioError('studio_release_has_open_dispute');
      }
      await this.restoreLocked(manager, actorId, release);
    });
    return this.catalog.getReleaseForStaff(releaseId);
  }

  /**
   * The restore, inside the caller's transaction. Resolves true when the
   * release changed and false when it was not taken down. Throws 404 for a
   * release that is gone.
   */
  async restoreWithin(
    manager: EntityManager,
    actorId: string,
    releaseId: string,
  ): Promise<boolean> {
    const release = await this.lockRelease(manager, releaseId);
    return this.restoreLocked(manager, actorId, release);
  }

  // Restores a release the caller already holds locked.
  private async restoreLocked(
    manager: EntityManager,
    actorId: string,
    release: StudioRelease,
  ): Promise<boolean> {
    if (release.status !== StudioReleaseStatus.TakenDown) {
      return false;
    }
    release.status = release.publishedAt
      ? StudioReleaseStatus.Published
      : StudioReleaseStatus.Draft;
    release.takenDownAt = null;
    release.takenDownById = null;
    release.takedownReason = null;
    await manager.save(release);
    await this.modAudit.writeAuditLog(
      null,
      actorId,
      STUDIO_AUDIT_ACTIONS.releaseRestored,
      undefined,
      release.id,
      undefined,
      manager,
      null,
    );
    return true;
  }

  // Resolves every open or escalated report about the release; an escalated
  // named report is resolved like an open one. A named report about
  // something else throws `mismatch`. A resolved named report counts as
  // done when an earlier `studio_release_taken_down` resolved it and the
  // release is already taken down (a repeat submit); any other resolved
  // named report throws `not_open`. Either throw rolls the whole takedown
  // back.
  private async resolveReports(
    manager: EntityManager,
    input: StudioTakedownReportsInput,
  ): Promise<Report[]> {
    const outcome = await this.takedownReports.resolveWithin(manager, input);
    if (outcome.kind === 'mismatch') {
      throw studioError('studio_takedown_report_mismatch');
    }
    if (outcome.kind === 'not_open') {
      throw studioError('studio_takedown_report_not_open');
    }
    return outcome.reports;
  }

  private async lockRelease(
    manager: EntityManager,
    releaseId: string,
  ): Promise<StudioRelease> {
    const release = await manager.findOne(StudioRelease, {
      where: { id: releaseId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!release) {
      throw new NotFoundException('Release not found');
    }
    return release;
  }
}
