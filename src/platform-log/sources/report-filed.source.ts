import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Report } from '../../reports/entities/report.entity';
import {
  applyPlatformLogWindow,
  compactParams,
  exactTimeSql,
  selectPlatformLogColumns,
} from '../platform-log-query';
import type {
  PlatformLogCategory,
  PlatformLogRawEntry,
  PlatformLogSource,
  SourceWindow,
} from '../platform-log.types';

interface ReportRow {
  row_id: string;
  occurred_at_exact: string;
  reporter_id: string | null;
  is_anonymous: boolean;
  severity: string;
}

/** Reports filed. An anonymous reporter's id is nulled in SQL and never matched. */
@Injectable()
export class ReportFiledSource implements PlatformLogSource {
  readonly key = 'report';
  readonly categories: readonly PlatformLogCategory[] = ['members'];
  readonly audience = 'admin' as const;

  constructor(
    @InjectRepository(Report) private readonly reports: Repository<Report>,
  ) {}

  async fetch(window: SourceWindow): Promise<PlatformLogRawEntry[]> {
    if (!window.categories.includes('members')) return [];
    const queryBuilder = selectPlatformLogColumns(
      this.reports.createQueryBuilder('e'),
      {
        row_id: '"e"."id"',
        occurred_at_exact: exactTimeSql('"e"."created_at"'),
        reporter_id:
          'CASE WHEN "e"."anonymous" THEN NULL ELSE "e"."reporter_id" END',
        is_anonymous: '"e"."anonymous"',
        severity: '"e"."severity"',
      },
    );
    if (window.memberId) {
      queryBuilder.andWhere(
        '("e"."reporter_id" = :memberId AND "e"."anonymous" = false)',
        { memberId: window.memberId },
      );
    }
    applyPlatformLogWindow(
      queryBuilder,
      this.key,
      { timeSql: '"e"."created_at"', idSql: '"e"."id"' },
      window,
    );
    const rows = await queryBuilder.getRawMany<ReportRow>();
    return rows.map((row) => ({
      sourceKey: this.key,
      rowId: row.row_id,
      occurredAtExact: row.occurred_at_exact,
      category: 'members' as const,
      kind: 'member.report_filed',
      actorUserId: row.is_anonymous ? null : row.reporter_id,
      actorFallbackName: null,
      actorKind: row.is_anonymous
        ? ('anonymous' as const)
        : ('member' as const),
      targetUserId: null,
      targetFallbackName: null,
      subject: {
        label: '',
        route:
          row.severity === 'emergency'
            ? '/admin/moderation?tab=emergencies'
            : '/admin/moderation',
      },
      params: compactParams({ severity: row.severity }),
      note: null,
    }));
  }
}
