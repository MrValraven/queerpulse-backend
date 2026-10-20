import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  Report,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { formatReportReference } from '../reports/report-reference';
import { StudioTrack } from '../studio/entities/studio-track.entity';
import { STUDIO_AUDIT_ACTIONS } from '../studio/studio.constants';
import { ResolutionNotifiedParty } from './moderation-response';

export interface StudioTakedownReportsInput {
  releaseId: string;
  actorId: string;
  /** The takedown reason, recorded as each report's resolution note. */
  reason: string;
  /** The report the takedown was started from, when there is one. */
  reportId?: string;
  /**
   * True when this takedown moved the release to taken down, so the persona's
   * owners receive the `StudioReleaseTakenDown` notice. Only then does each
   * resolved report list `member` as notified.
   */
  isOwnerNoticeSent: boolean;
}

export type StudioTakedownReportsOutcome =
  | { kind: 'resolved'; reports: Report[] }
  | { kind: 'mismatch' }
  | { kind: 'not_open' };

/** Studio safety and moderation: a staff track action started from one
 *  report. Only that report resolves; other reports on the track may name a
 *  different harm. */
export interface StudioTrackReportInput {
  trackId: string;
  actorId: string;
  reportId: string;
  /** The audit action the track action writes, stored as the report's
   *  `resolutionAction`. */
  action: string;
  /** True when the track's owners receive `studio_track_marked`. */
  isOwnerNoticeSent: boolean;
}

export type StudioTrackReportOutcome =
  | { kind: 'resolved'; report: Report }
  | { kind: 'mismatch' }
  | { kind: 'not_open' };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The reports a release takedown resolves: those about the release and
 *  (Studio safety) those about any of its tracks. Case-blind on the stored
 *  subject id. */
export const STUDIO_RELEASE_REPORTS_PREDICATE = `(("report"."subject_type" = :studioReleaseSubjectType
      AND lower("report"."subject_id") = :studioReportReleaseId)
    OR ("report"."subject_type" = :studioTrackSubjectType
      AND lower("report"."subject_id") IN (
        SELECT "release_track"."id"::text FROM "studio_tracks" "release_track"
         WHERE "release_track"."release_id" = :studioReportReleaseId
      )))`;

/**
 * Studio open demo pages: a Studio takedown resolves every open or
 * escalated report about the release, inside the takedown's own transaction
 * (`StudioModerationService.takedown`). A takedown started from one report
 * (`reportId`) first checks that report: it must be an open or escalated
 * `studio_release` report about this release (or, on a repeat while the
 * release is still taken down, one an earlier takedown of this release
 * resolved), or the whole takedown fails. Studio safety and moderation widens both: the named report may be a `studio_track` report about one of the release's tracks, and every takedown also resolves the actionable reports about the release's tracks.
 *
 * The resolved report carries the fields `ModerationService.actOnReport`
 * writes when `PATCH /mod/reports/:id` resolves a report, and each reporter's
 * receipt is the same `ReportResolved` row with the same payload. Three
 * things differ on purpose. `resolutionAction` reads
 * `studio_release_taken_down`. `resolutionNote` holds the takedown reason.
 * `resolutionNotified` lists `member` only when `isOwnerNoticeSent` is true
 * (the persona's owners received the `StudioReleaseTakenDown` notice), and
 * `reporter` when a reachable reporter other than the acting staff member
 * filed the report. A reporter with several reports gets one receipt while
 * each of their reports lists `reporter`. No report audit row names a target
 * member: the Studio takedown writes its own audit row with no
 * `targetUserId`, so the member drawer never ties a pseudonymous persona to
 * its owner.
 */
@Injectable()
export class StudioTakedownReportService {
  constructor(private readonly notifications: NotificationsService) {}

  /**
   * Checks the named report (when there is one), then locks and resolves
   * every actionable `studio_release` report about the release and `studio_track` report about its tracks. Actionable
   * means open or escalated, the same set the moderation console still acts
   * on (`ModerationService.assertActionableStatus` refuses resolved only).
   * A named report that is missing, about another subject or about another
   * release is a `mismatch`; one already resolved is `not_open`; either
   * writes nothing. A repeated submit counts as done: when the release is
   * already taken down (`isOwnerNoticeSent` is false) and a takedown of this
   * release already resolved the named report, that report is left as it is,
   * gets no second receipt, and every other actionable report is still
   * resolved. While the release is live (restored or upheld since that
   * takedown), the same named report is `not_open`, so a stale tab cannot
   * take a restored release down again from an old report. The release id
   * compares case-blind, since a report can hold the uuid in any letter case.
   */
  async resolveWithin(
    manager: EntityManager,
    input: StudioTakedownReportsInput,
  ): Promise<StudioTakedownReportsOutcome> {
    const releaseId = input.releaseId.toLowerCase();
    if (input.reportId) {
      const namedReport = await manager.findOne(Report, {
        where: { id: input.reportId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !namedReport ||
        !(await this.isReportAboutRelease(manager, namedReport, releaseId))
      ) {
        return { kind: 'mismatch' };
      }
      // `isOwnerNoticeSent` is false exactly when the release was already
      // taken down, so only then is this a true repeat of that takedown.
      const isRepeatOfCurrentTakedown =
        !input.isOwnerNoticeSent &&
        namedReport.status === ReportStatus.Resolved &&
        namedReport.resolutionAction === STUDIO_AUDIT_ACTIONS.releaseTakenDown;
      if (
        namedReport.status === ReportStatus.Resolved &&
        !isRepeatOfCurrentTakedown
      ) {
        return { kind: 'not_open' };
      }
    }
    const openReports = await manager
      .createQueryBuilder(Report, 'report')
      .setLock('pessimistic_write')
      .where(STUDIO_RELEASE_REPORTS_PREDICATE, {
        studioReleaseSubjectType: ReportSubjectType.StudioRelease,
        studioTrackSubjectType: ReportSubjectType.StudioTrack,
        studioReportReleaseId: releaseId,
      })
      .andWhere('"report"."status" IN (:...studioReportActionableStatuses)', {
        studioReportActionableStatuses: [
          ReportStatus.Open,
          ReportStatus.Escalated,
        ],
      })
      .orderBy('report.createdAt', 'ASC')
      .addOrderBy('report.id', 'ASC')
      .getMany();
    if (!openReports.length) {
      return { kind: 'resolved', reports: [] };
    }
    const resolvedAt = new Date();
    for (const report of openReports) {
      const notified: ResolutionNotifiedParty[] = input.isOwnerNoticeSent
        ? ['member']
        : [];
      if (report.reporterId && report.reporterId !== input.actorId) {
        notified.push('reporter');
      }
      report.status = ReportStatus.Resolved;
      report.resolvedAt = resolvedAt;
      report.resolutionActorId = input.actorId;
      report.resolutionAction = STUDIO_AUDIT_ACTIONS.releaseTakenDown;
      report.resolutionDuration = null;
      report.resolutionNote = input.reason;
      report.resolutionNotified = notified;
    }
    return { kind: 'resolved', reports: await manager.save(openReports) };
  }

  /**
   * Studio safety and moderation: a staff track action (`mark-explicit`,
   * `content-warnings`) started from one report. The report must be an open
   * or escalated `studio_track` report about this track (`mismatch`
   * otherwise, `not_open` once handled); it is locked and resolved like a
   * takedown resolves its reports, with the action as `resolutionAction`
   * and no note. `member` is listed as notified only when the owners got
   * `studio_track_marked`; `reporter` when a reachable reporter other than
   * the actor filed it. The caller sends the receipt after commit
   * (`notifyReportersBestEffort`).
   */
  async resolveNamedTrackReportWithin(
    manager: EntityManager,
    input: StudioTrackReportInput,
  ): Promise<StudioTrackReportOutcome> {
    const report = await manager.findOne(Report, {
      where: { id: input.reportId },
      lock: { mode: 'pessimistic_write' },
    });
    if (
      !report ||
      report.subjectType !== ReportSubjectType.StudioTrack ||
      report.subjectId.toLowerCase() !== input.trackId.toLowerCase()
    ) {
      return { kind: 'mismatch' };
    }
    if (
      report.status !== ReportStatus.Open &&
      report.status !== ReportStatus.Escalated
    ) {
      return { kind: 'not_open' };
    }
    const notified: ResolutionNotifiedParty[] = input.isOwnerNoticeSent
      ? ['member']
      : [];
    if (report.reporterId && report.reporterId !== input.actorId) {
      notified.push('reporter');
    }
    report.status = ReportStatus.Resolved;
    report.resolvedAt = new Date();
    report.resolutionActorId = input.actorId;
    report.resolutionAction = input.action;
    report.resolutionDuration = null;
    report.resolutionNote = null;
    report.resolutionNotified = notified;
    return { kind: 'resolved', report: await manager.save(report) };
  }

  // A named takedown report: a release report about this release, or (Studio
  // safety) a track report about one of its tracks. A track id that is no
  // uuid never reaches the uuid column.
  private async isReportAboutRelease(
    manager: EntityManager,
    report: Report,
    releaseId: string,
  ): Promise<boolean> {
    if (report.subjectType === ReportSubjectType.StudioRelease) {
      return report.subjectId.toLowerCase() === releaseId;
    }
    if (
      report.subjectType === ReportSubjectType.StudioTrack &&
      UUID_PATTERN.test(report.subjectId)
    ) {
      return manager.exists(StudioTrack, {
        where: { id: report.subjectId.toLowerCase(), releaseId },
      });
    }
    return false;
  }

  /**
   * One receipt per reachable reporter, exactly as `ModerationService` sends
   * it: which of their reports reached an outcome (their first report in
   * `reports` when they filed several), and nothing about the release or
   * its owners. Anonymous reports and the acting staff member get none.
   * Post-commit and best effort: one failed receipt never stops the others.
   */
  async notifyReportersBestEffort(
    reports: readonly Report[],
    actorId: string,
  ): Promise<void> {
    const firstReportByReporter = new Map<string, Report>();
    for (const report of reports) {
      if (
        report.reporterId &&
        report.reporterId !== actorId &&
        !firstReportByReporter.has(report.reporterId)
      ) {
        firstReportByReporter.set(report.reporterId, report);
      }
    }
    for (const [reporterId, report] of firstReportByReporter) {
      try {
        await this.notifications.create(
          reporterId,
          NotificationType.ReportResolved,
          {
            source: 'report',
            reportId: report.id,
            reference: formatReportReference(report),
            subjectType: report.subjectType,
            outcome: report.status,
          },
        );
      } catch {
        // Intentionally ignored: the takedown and the resolutions committed.
      }
    }
  }
}
