import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { Message } from '../messaging/entities/message.entity';
import {
  Report,
  ReportStatus,
  ReportSubjectType,
} from './entities/report.entity';
import { reasonsFor, ReasonCode, ReasonOption } from './reason-catalogue';
import { deriveSeverity, slaDueAtFor } from './report-severity';
import { ReportDTO, toReportDTO } from './report-response';

export interface ReportEvidenceInput {
  type: 'url' | 'screenshot';
  value?: string;
  uploadId?: string;
}

export interface CreateReportInput {
  subjectType: ReportSubjectType;
  subjectId: string;
  reasonCode: ReasonCode;
  detail?: string;
  anonymous?: boolean;
  contactEmail?: string;
  evidence?: ReportEvidenceInput[];
}

@Injectable()
export class ReportsService {
  constructor(
    @InjectRepository(Report) private readonly reports: Repository<Report>,
    // Read-only lookup for the message self-report guard below. Registered
    // directly in `ReportsModule` (not via `MessagingModule`, which would
    // create a cycle through `SocialModule` -> `ReportsModule`) — TypeORM
    // permits the same entity's repository being registered in more than one
    // module (see `AccountModule`'s identical cross-module `Message` reuse).
    @InjectRepository(Message) private readonly messages: Repository<Message>,
  ) {}

  async create(
    reporterId: string,
    input: CreateReportInput,
  ): Promise<ReportDTO> {
    // A member can't report their own message — mirrors the DTO's `canReport`
    // flag (`!isDeleted && !isAuthor` in `MessagingCoreService.toMessageResponses`),
    // which is only a UI convenience unless the server enforces the same rule.
    // Scoped to the `message` subject type only: other subject types (member,
    // post, reply, …) have no equivalent server-computed "is this mine" flag
    // today, so there's no matching gap to close for them here.
    if (input.subjectType === ReportSubjectType.Message) {
      const message = await this.messages.findOne({
        where: { id: input.subjectId },
        // A soft-deleted message still has a real author; withDeleted so a
        // deleted-but-still-yours message can't be self-reported either.
        withDeleted: true,
      });
      if (message && message.senderId === reporterId) {
        throw new ForbiddenException('You cannot report your own message');
      }
    }

    // De-duplicate: one open report per (reporter, subject). A member
    // double-submitting — or re-reporting a subject already in the queue — gets
    // the existing report back rather than piling identical rows on the mods'
    // desk. The `findOne` fast-paths the common case; the partial unique index
    // `UQ_reports_open_reporter_subject` (WHERE status = 'open') is what
    // actually closes the check-then-insert race — two concurrent identical
    // filings can both miss the `findOne`, and the loser of the insert race
    // then re-reads and returns the winner's row (below). (Resolved/escalated
    // reports don't block a fresh filing: a recurrence after a resolution is
    // worth surfacing again, hence the partial `WHERE status = 'open'`.)
    const existing = await this.findOpenReport(reporterId, input);
    if (existing) {
      return toReportDTO(existing);
    }

    const severity = deriveSeverity(input.reasonCode);
    const now = new Date();

    try {
      const saved = await this.reports.save(
        this.reports.create({
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          reasonCode: input.reasonCode,
          detail: input.detail ?? null,
          anonymous: input.anonymous ?? false,
          contactEmail: input.contactEmail ?? null,
          evidence: input.evidence ?? null,
          severity,
          slaDueAt: slaDueAtFor(severity, now),
          status: ReportStatus.Open,
          reporterId,
        }),
      );
      return toReportDTO(saved);
    } catch (error) {
      // Lost the insert race against a concurrent identical filing — the
      // partial unique index rejected the duplicate open report. Converge on
      // the same idempotent outcome as the `findOne` fast-path: return the
      // report that won.
      if (isUniqueViolation(error, 'UQ_reports_open_reporter_subject')) {
        const winner = await this.findOpenReport(reporterId, input);
        if (winner) {
          return toReportDTO(winner);
        }
      }
      throw error;
    }
  }

  private findOpenReport(
    reporterId: string,
    input: CreateReportInput,
  ): Promise<Report | null> {
    return this.reports.findOne({
      where: {
        reporterId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        // Dedupe collapses only SAME-reason open reports by the same reporter
        // on the same subject. Two DISTINCT reasonCodes on one subject (e.g. a
        // `listing_dispute` then a high-severity abuse report on the same
        // listing) are genuinely different reports and must both reach the
        // queue — keyed here (and in the partial unique index) on reasonCode so
        // a distinct/higher-severity filing isn't silently dropped.
        reasonCode: input.reasonCode,
        status: ReportStatus.Open,
      },
    });
  }

  // Server-owned reason taxonomy — always `other` plus whatever's relevant
  // to the subject type (see `reason-catalogue.ts`).
  reasonsFor(subjectType: ReportSubjectType): ReasonOption[] {
    return reasonsFor(subjectType);
  }
}
