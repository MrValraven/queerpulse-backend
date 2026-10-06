import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlatformJoinRequest } from '../../membership/entities/join-request.entity';
import {
  applyPlatformLogWindow,
  exactTimeSql,
  selectPlatformLogColumns,
} from '../platform-log-query';
import type {
  PlatformLogCategory,
  PlatformLogRawEntry,
  PlatformLogSource,
  SourceWindow,
} from '../platform-log.types';

interface JoinRequestRow {
  row_id: string;
  occurred_at_exact: string;
  applicant_name: string;
}

/** Requests to join the platform. Applicants have no account yet. */
@Injectable()
export class JoinRequestSource implements PlatformLogSource {
  readonly key = 'jreq';
  readonly categories: readonly PlatformLogCategory[] = ['members'];
  readonly audience = 'admin' as const;

  constructor(
    @InjectRepository(PlatformJoinRequest)
    private readonly joinRequests: Repository<PlatformJoinRequest>,
  ) {}

  async fetch(window: SourceWindow): Promise<PlatformLogRawEntry[]> {
    if (!window.categories.includes('members') || window.memberId) return [];
    const queryBuilder = selectPlatformLogColumns(
      this.joinRequests.createQueryBuilder('e'),
      {
        row_id: '"e"."id"',
        occurred_at_exact: exactTimeSql('"e"."created_at"'),
        applicant_name: '"e"."name"',
      },
    );
    applyPlatformLogWindow(
      queryBuilder,
      this.key,
      { timeSql: '"e"."created_at"', idSql: '"e"."id"' },
      window,
    );
    const rows = await queryBuilder.getRawMany<JoinRequestRow>();
    return rows.map((row) => ({
      sourceKey: this.key,
      rowId: row.row_id,
      occurredAtExact: row.occurred_at_exact,
      category: 'members' as const,
      kind: 'member.join_requested',
      actorUserId: null,
      actorFallbackName: row.applicant_name,
      actorKind: 'member' as const,
      targetUserId: null,
      targetFallbackName: null,
      subject: { label: '', route: '/admin/members?tab=verification' },
      params: {},
      note: null,
    }));
  }
}
