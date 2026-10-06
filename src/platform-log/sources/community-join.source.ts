import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommunityMember } from '../../communities/entities/community-member.entity';
import {
  AccessTier,
  Community,
} from '../../communities/entities/community.entity';
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

interface CommunityJoinRow {
  row_id: string;
  occurred_at_exact: string;
  user_id: string;
  community_name: string;
  community_slug: string;
}

/**
 * Joins of public, top-level, live communities only. Being IN a private
 * space is exactly the fact a private space exists to keep (the same gate as
 * `ActivityListener`).
 */
@Injectable()
export class CommunityJoinSource implements PlatformLogSource {
  readonly key = 'cjoin';
  readonly categories: readonly PlatformLogCategory[] = ['members'];
  readonly audience = 'admin' as const;

  constructor(
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
  ) {}

  async fetch(window: SourceWindow): Promise<PlatformLogRawEntry[]> {
    if (!window.categories.includes('members')) return [];
    const queryBuilder = selectPlatformLogColumns(
      this.members
        .createQueryBuilder('e')
        .innerJoin(Community, 'c', '"c"."id" = "e"."community_id"'),
      {
        row_id: '"e"."id"',
        occurred_at_exact: exactTimeSql('"e"."joined_at"'),
        user_id: '"e"."user_id"',
        community_name: '"c"."name"',
        community_slug: '"c"."slug"',
      },
    );
    queryBuilder
      .andWhere('"c"."access_tier" = :publicTier', {
        publicTier: AccessTier.Public,
      })
      .andWhere('"c"."parent_id" IS NULL')
      .andWhere('"c"."archived_at" IS NULL');
    if (window.memberId) {
      queryBuilder.andWhere('"e"."user_id" = :memberId', {
        memberId: window.memberId,
      });
    }
    applyPlatformLogWindow(
      queryBuilder,
      this.key,
      { timeSql: '"e"."joined_at"', idSql: '"e"."id"' },
      window,
    );
    const rows = await queryBuilder.getRawMany<CommunityJoinRow>();
    return rows.map((row) => ({
      sourceKey: this.key,
      rowId: row.row_id,
      occurredAtExact: row.occurred_at_exact,
      category: 'members' as const,
      kind: 'member.community_joined',
      actorUserId: row.user_id,
      actorFallbackName: null,
      actorKind: 'member' as const,
      targetUserId: null,
      targetFallbackName: null,
      subject: {
        label: row.community_name,
        route: `/admin/communities/${row.community_slug}/mod`,
      },
      params: {},
      note: null,
    }));
  }
}
