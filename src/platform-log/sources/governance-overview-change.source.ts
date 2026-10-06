import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GovernanceOverviewChange } from '../../governance/entities/governance-overview-change.entity';
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

interface GovernanceOverviewRow {
  row_id: string;
  occurred_at_exact: string;
  section: string;
  actor_id: string | null;
  note: string | null;
}

/** Edits to the public governance page, one row per section change. */
@Injectable()
export class GovernanceOverviewChangeSource implements PlatformLogSource {
  readonly key = 'gov';
  readonly categories: readonly PlatformLogCategory[] = ['governance'];
  readonly audience = 'staff' as const;

  constructor(
    @InjectRepository(GovernanceOverviewChange)
    private readonly changes: Repository<GovernanceOverviewChange>,
  ) {}

  async fetch(window: SourceWindow): Promise<PlatformLogRawEntry[]> {
    if (!window.categories.includes('governance')) return [];
    const queryBuilder = selectPlatformLogColumns(
      this.changes.createQueryBuilder('e'),
      {
        row_id: '"e"."id"',
        occurred_at_exact: exactTimeSql('"e"."created_at"'),
        section: '"e"."section"',
        actor_id: '"e"."actor_id"',
        note: '"e"."note"',
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
    const rows = await queryBuilder.getRawMany<GovernanceOverviewRow>();
    return rows.map((row) => ({
      sourceKey: this.key,
      rowId: row.row_id,
      occurredAtExact: row.occurred_at_exact,
      category: 'governance' as const,
      kind: 'governance.section_changed',
      actorUserId: row.actor_id,
      actorFallbackName: null,
      actorKind: 'staff' as const,
      targetUserId: null,
      targetFallbackName: null,
      subject: { label: '', route: '/admin/governance' },
      params: compactParams({ section: row.section }),
      note: row.note,
    }));
  }
}
