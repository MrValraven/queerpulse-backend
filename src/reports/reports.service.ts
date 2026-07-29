import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
  ) {}

  async create(
    reporterId: string,
    input: CreateReportInput,
  ): Promise<ReportDTO> {
    // De-duplicate: one open report per (reporter, subject). A member
    // double-submitting — or re-reporting a subject already in the queue — gets
    // the existing report back rather than piling identical rows on the mods'
    // desk. Check-then-act, mirroring `ConnectionsService.request`'s existing-
    // pair guard. (Resolved/escalated reports don't block a fresh filing: a
    // recurrence after a resolution is worth surfacing again.)
    const existing = await this.reports.findOne({
      where: {
        reporterId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        status: ReportStatus.Open,
      },
    });
    if (existing) {
      return toReportDTO(existing);
    }

    const severity = deriveSeverity(input.reasonCode);
    const now = new Date();

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
  }

  // Server-owned reason taxonomy — always `other` plus whatever's relevant
  // to the subject type (see `reason-catalogue.ts`).
  reasonsFor(subjectType: ReportSubjectType): ReasonOption[] {
    return reasonsFor(subjectType);
  }
}
