import type { Repository } from 'typeorm';
import type { ForumThread } from '../../forum/entities/forum-thread.entity';
import type { SourceWindow } from '../platform-log.types';
import { ForumThreadSource } from './forum-thread.source';

type QueryBuilderMethod =
  | 'select'
  | 'addSelect'
  | 'where'
  | 'andWhere'
  | 'orderBy'
  | 'addOrderBy'
  | 'limit'
  | 'leftJoin'
  | 'innerJoin';
type QueryBuilderStub = Record<QueryBuilderMethod, jest.Mock> & {
  getRawMany: jest.Mock;
};

function queryBuilderStub(
  rows: Record<string, unknown>[] = [],
): QueryBuilderStub {
  const methods: QueryBuilderMethod[] = [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'limit',
    'leftJoin',
    'innerJoin',
  ];
  const queryBuilder = {} as QueryBuilderStub;
  for (const method of methods) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getRawMany = jest.fn().mockResolvedValue(rows);
  return queryBuilder;
}

function windowWith(overrides: Partial<SourceWindow> = {}): SourceWindow {
  return {
    cursor: null,
    since: null,
    limit: 30,
    memberId: null,
    staffRowsOnly: false,
    categories: ['moderation', 'staff', 'governance', 'reviews', 'members'],
    ...overrides,
  };
}

function conditionsOf(queryBuilder: QueryBuilderStub): string[] {
  return queryBuilder.andWhere.mock.calls.map(([sql]) => String(sql));
}

describe('ForumThreadSource', () => {
  it('applies the public-visibility gate and maps the thread as subject', async () => {
    const queryBuilder = queryBuilderStub([
      {
        row_id: 't1',
        occurred_at_exact: '2026-10-05T12:00:00.123000Z',
        author_id: 'member-1',
        title: 'Quiet coffee in Porto?',
        thread_slug: 'quiet-coffee-in-porto',
      },
    ]);
    const repository = { createQueryBuilder: jest.fn(() => queryBuilder) };
    const source = new ForumThreadSource(
      repository as unknown as Repository<ForumThread>,
    );
    const [entry] = await source.fetch(windowWith());
    expect(conditionsOf(queryBuilder)).toEqual(
      expect.arrayContaining([
        '"e"."author_id" IS NOT NULL',
        '"e"."is_anonymous" = false',
        '"e"."is_official" = false',
        '"e"."deleted_at" IS NULL',
        `("e"."review_state" IS NULL OR "e"."review_state" = 'approved')`,
        '"e"."published_at" <= now()',
        '("e"."community_id" IS NULL OR "e"."cross_posted" = true OR ("c"."access_tier" = :publicTier AND "c"."parent_id" IS NULL AND "c"."archived_at" IS NULL))',
      ]),
    );
    expect(entry).toMatchObject({
      sourceKey: 'thread',
      kind: 'member.thread_started',
      actorUserId: 'member-1',
      subject: {
        label: 'Quiet coffee in Porto?',
        route: '/thread/quiet-coffee-in-porto',
      },
    });
  });
});
