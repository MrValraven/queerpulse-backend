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
