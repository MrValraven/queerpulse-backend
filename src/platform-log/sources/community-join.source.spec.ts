import type { Repository } from 'typeorm';
import type { CommunityMember } from '../../communities/entities/community-member.entity';
import type { SourceWindow } from '../platform-log.types';
import { CommunityJoinSource } from './community-join.source';

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

function sourceWith(rows: Record<string, unknown>[] = []) {
  const queryBuilder = queryBuilderStub(rows);
  const repository = { createQueryBuilder: jest.fn(() => queryBuilder) };
  const source = new CommunityJoinSource(
    repository as unknown as Repository<CommunityMember>,
  );
  return { source, queryBuilder };
}

describe('CommunityJoinSource', () => {
  it('only lists joins of public, top-level, live communities', async () => {
    const { source, queryBuilder } = sourceWith();
    await source.fetch(windowWith());
    expect(queryBuilder.innerJoin.mock.calls[0]?.[2]).toBe(
      '"c"."id" = "e"."community_id"',
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      '"c"."access_tier" = :publicTier',
      {
        publicTier: 'public',
      },
    );
    expect(conditionsOf(queryBuilder)).toEqual(
      expect.arrayContaining([
        '"c"."parent_id" IS NULL',
        '"c"."archived_at" IS NULL',
      ]),
    );
  });

  it('maps a join with the community as subject', async () => {
    const { source } = sourceWith([
      {
        row_id: 'm1',
        occurred_at_exact: '2026-10-05T12:00:00.000001Z',
        user_id: 'member-1',
        community_name: 'Porto Book Club',
        community_slug: 'porto-book-club',
      },
    ]);
    const [entry] = await source.fetch(windowWith());
    expect(entry).toMatchObject({
      sourceKey: 'cjoin',
      kind: 'member.community_joined',
      actorUserId: 'member-1',
      actorKind: 'member',
      subject: {
        label: 'Porto Book Club',
        route: '/admin/communities/porto-book-club/mod',
      },
    });
  });
});
