import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ModAuditService } from '../moderation/mod-audit.service';
import {
  StudioTakedownReportService,
  StudioTrackReportInput,
} from '../moderation/studio-takedown-report.service';
import { Report } from '../reports/entities/report.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioAdminTrack, toStudioAdminTrack } from './studio-claim-response';
import {
  STUDIO_SAFETY_AUDIT_ACTIONS,
  StudioSafetyAuditAction,
  normalizeContentWarnings,
  studioSafetyError,
} from './studio-safety.constants';
import {
  StudioSafetyNoticesService,
  StudioTrackMarkChange,
} from './studio-safety-notices.service';

/** What one staff track action would do to a locked track. `apply` runs
 *  only when `isChanged`. */
interface TrackActionPlan {
  isChanged: boolean;
  action: StudioSafetyAuditAction;
  auditNote: string;
  apply: () => void;
}

interface TrackActionOutcome {
  isChanged: boolean;
  resolvedReport: Report | null;
}

/**
 * Studio safety and moderation (spec 4.3): the reports tab's two track
 * actions and the track card read. Staff only (`AdminStudioTracksController`),
 * no Studio grant needed.
 *
 * Each action locks the track row, resolves the named report when there is
 * one (only that report: others on the track may name a different harm),
 * and, only when the track changes, saves it and writes one audit row with
 * no target member. The owners' `studio_track_marked` notice and the
 * reporter's receipt go out after commit. Mark explicit keeps the first
 * lock stamp; staff warnings only grow, in theme order.
 */
@Injectable()
export class StudioAdminTracksService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(StudioTrack)
    private readonly tracks: Repository<StudioTrack>,
    private readonly catalog: StudioCatalogService,
    private readonly modAudit: ModAuditService,
    private readonly takedownReports: StudioTakedownReportService,
    private readonly notices: StudioSafetyNoticesService,
  ) {}

  /** Any track, any status, with its release's staff card. */
  async getTrack(trackId: string): Promise<StudioAdminTrack> {
    const track = await this.tracks.findOne({ where: { id: trackId } });
    const releaseSummary = track
      ? (await this.catalog.staffSummariesByReleaseId([track.releaseId])).get(
          track.releaseId,
        )
      : undefined;
    if (!track || !releaseSummary) {
      throw new NotFoundException('Track not found');
    }
    return toStudioAdminTrack(track, releaseSummary);
  }

  markExplicit(
    actorId: string,
    trackId: string,
    reportId?: string,
  ): Promise<StudioAdminTrack> {
    return this.applyTrackAction(
      actorId,
      trackId,
      reportId,
      'explicit',
      (track) => ({
        isChanged: !track.isExplicit || !track.explicitLockedAt,
        action: STUDIO_SAFETY_AUDIT_ACTIONS.trackMarkedExplicit,
        auditNote: `track ${track.id}`,
        apply: () => {
          track.isExplicit = true;
          track.explicitLockedAt = track.explicitLockedAt ?? new Date();
        },
      }),
    );
  }

  addContentWarnings(
    actorId: string,
    trackId: string,
    warnings: readonly string[],
    reportId?: string,
  ): Promise<StudioAdminTrack> {
    return this.applyTrackAction(
      actorId,
      trackId,
      reportId,
      'content_warning',
      (track) => {
        const currentWarnings = normalizeContentWarnings(
          track.staffContentWarnings,
        );
        const mergedWarnings = normalizeContentWarnings([
          ...currentWarnings,
          ...warnings,
        ]);
        const addedWarnings = mergedWarnings.filter(
          (warningId) => !currentWarnings.includes(warningId),
        );
        return {
          isChanged: addedWarnings.length > 0,
          action: STUDIO_SAFETY_AUDIT_ACTIONS.trackWarningAdded,
          auditNote: `track ${track.id}: ${addedWarnings.join(', ')}`,
          apply: () => {
            track.staffContentWarnings = mergedWarnings;
          },
        };
      },
    );
  }

  private async applyTrackAction(
    actorId: string,
    trackId: string,
    reportId: string | undefined,
    change: StudioTrackMarkChange,
    planFor: (track: StudioTrack) => TrackActionPlan,
  ): Promise<StudioAdminTrack> {
    const outcome = await this.dataSource.transaction<TrackActionOutcome>(
      async (manager) => {
        const track = await manager.findOne(StudioTrack, {
          where: { id: trackId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!track) {
          throw new NotFoundException('Track not found');
        }
        const plan = planFor(track);
        // A named report resolves even when the track already carries the
        // change. No audit row is written then: nothing on the track
        // changed, and the report row itself records the decision
        // (`resolution_actor_id`, `resolution_action`, `resolved_at`).
        const resolvedReport = reportId
          ? await this.resolveNamedReport(manager, {
              trackId: track.id,
              actorId,
              reportId,
              action: plan.action,
              isOwnerNoticeSent: plan.isChanged,
            })
          : null;
        if (plan.isChanged) {
          plan.apply();
          await manager.save(track);
          await this.modAudit.writeAuditLog(
            reportId ?? null,
            actorId,
            plan.action,
            undefined,
            plan.auditNote,
            undefined,
            manager,
            null,
          );
        }
        return { isChanged: plan.isChanged, resolvedReport };
      },
    );
    if (outcome.isChanged) {
      await this.notices.trackMarked(trackId, change);
    }
    if (outcome.resolvedReport) {
      await this.takedownReports.notifyReportersBestEffort(
        [outcome.resolvedReport],
        actorId,
      );
    }
    return this.getTrack(trackId);
  }

  private async resolveNamedReport(
    manager: EntityManager,
    input: StudioTrackReportInput,
  ): Promise<Report> {
    const outcome = await this.takedownReports.resolveNamedTrackReportWithin(
      manager,
      input,
    );
    if (outcome.kind === 'mismatch') {
      throw studioSafetyError('studio_track_report_mismatch');
    }
    if (outcome.kind === 'not_open') {
      throw studioSafetyError('studio_track_report_not_open');
    }
    return outcome.report;
  }
}
