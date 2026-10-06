import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoadmapAuditLog } from '../../roadmap/entities/roadmap-audit-log.entity';
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

interface RoadmapAuditRow {
  row_id: string;
  occurred_at_exact: string;
  actor_id: string | null;
  actor_label: string | null;
  action: string;
}

/**
 * Roadmap edits. `action` is human-readable text the roadmap service wrote
 * (e.g. `Created "X"`), passed through verbatim as a param.
 */
@Injectable()
export class RoadmapAuditLogSource implements PlatformLogSource {
  readonly key = 'road';
  readonly categories: readonly PlatformLogCategory[] = ['governance'];
  readonly audience = 'staff' as const;

  constructor(
    @InjectRepository(RoadmapAuditLog)
    private readonly auditLogs: Repository<RoadmapAuditLog>,
  ) {}

  async fetch(window: SourceWindow): Promise<PlatformLogRawEntry[]> {
    if (!window.categories.includes('governance')) return [];
    const queryBuilder = selectPlatformLogColumns(
      this.auditLogs.createQueryBuilder('e'),
      {
        row_id: '"e"."id"',
        occurred_at_exact: exactTimeSql('"e"."created_at"'),
        actor_id: '"e"."actor_id"',
        actor_label: '"e"."actor_label"',
        action: '"e"."action"',
      },
    );
    if (window.memberId) {
      queryBuilder.andWhere('"e"."actor_id" = :memberId', {
        memberId: window.memberId,
      });
    }
    applyPlatformLogWindow(
      queryBuilder,
      this.key,
      { timeSql: '"e"."created_at"', idSql: '"e"."id"' },
      window,
    );
    const rows = await queryBuilder.getRawMany<RoadmapAuditRow>();
    return rows.map((row) => ({
      sourceKey: this.key,
      rowId: row.row_id,
      occurredAtExact: row.occurred_at_exact,
      category: 'governance' as const,
      kind: 'roadmap.changed',
      actorUserId: row.actor_id,
      actorFallbackName: row.actor_label || null,
      actorKind: row.actor_id ? ('staff' as const) : ('system' as const),
      targetUserId: null,
      targetFallbackName: null,
      subject: { label: '', route: '/admin/roadmap' },
      params: compactParams({ action: row.action }),
      note: null,
    }));
  }
}
