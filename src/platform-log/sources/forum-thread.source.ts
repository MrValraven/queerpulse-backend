import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AccessTier,
  Community,
} from '../../communities/entities/community.entity';
import { ForumThread } from '../../forum/entities/forum-thread.entity';
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

interface ForumThreadRow {
  row_id: string;
  occurred_at_exact: string;
  author_id: string;
  title: string;
  thread_slug: string;
}

/**
 * Threads started under the member's own byline that the whole forum can
 * read: the same gate `ForumThreadsService.isThreadForumWide` uses before it
 * emits `FORUM_THREAD_CREATED`. Anonymous, official, held, scheduled, deleted
 * and gated-community threads never appear, except a community thread its own
 * author also cross-posted to the town square, which still shows.
 */
@Injectable()
export class ForumThreadSource implements PlatformLogSource {
  readonly key = 'thread';
  readonly categories: readonly PlatformLogCategory[] = ['members'];
  readonly audience = 'admin' as const;

  constructor(
    @InjectRepository(ForumThread)
    private readonly threads: Repository<ForumThread>,
  ) {}

  async fetch(window: SourceWindow): Promise<PlatformLogRawEntry[]> {
    if (!window.categories.includes('members')) return [];
    const queryBuilder = selectPlatformLogColumns(
      this.threads
        .createQueryBuilder('e')
        .leftJoin(Community, 'c', '"c"."id" = "e"."community_id"'),
      {
        row_id: '"e"."id"',
        occurred_at_exact: exactTimeSql('"e"."created_at"'),
        author_id: '"e"."author_id"',
        title: '"e"."title"',
        thread_slug: '"e"."slug"',
      },
    );
    queryBuilder
      .andWhere('"e"."author_id" IS NOT NULL')
      .andWhere('"e"."is_anonymous" = false')
      .andWhere('"e"."is_official" = false')
      .andWhere('"e"."deleted_at" IS NULL')
      .andWhere(
        `("e"."review_state" IS NULL OR "e"."review_state" = 'approved')`,
      )
      .andWhere('"e"."published_at" <= now()')
      .andWhere(
        '("e"."community_id" IS NULL OR "e"."cross_posted" = true OR ("c"."access_tier" = :publicTier AND "c"."parent_id" IS NULL AND "c"."archived_at" IS NULL))',
        { publicTier: AccessTier.Public },
      );
    if (window.memberId) {
      queryBuilder.andWhere('"e"."author_id" = :memberId', {
        memberId: window.memberId,
      });
    }
    applyPlatformLogWindow(
      queryBuilder,
      this.key,
      { timeSql: '"e"."created_at"', idSql: '"e"."id"' },
      window,
    );
    const rows = await queryBuilder.getRawMany<ForumThreadRow>();
    return rows.map((row) => ({
      sourceKey: this.key,
      rowId: row.row_id,
      occurredAtExact: row.occurred_at_exact,
      category: 'members' as const,
      kind: 'member.thread_started',
      actorUserId: row.author_id,
      actorFallbackName: null,
      actorKind: 'member' as const,
      targetUserId: null,
      targetFallbackName: null,
      subject: { label: row.title, route: `/thread/${row.thread_slug}` },
      params: {},
      note: null,
    }));
  }
}
