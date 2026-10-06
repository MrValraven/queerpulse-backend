import type { Repository } from 'typeorm';
import type { Profile } from '../../users/entities/profile.entity';
import type { SourceWindow } from '../platform-log.types';
import { ProfileJoinSource } from './profile-join.source';

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

describe('ProfileJoinSource', () => {
  it('pages by joined_at and user_id and maps the name as fallback', async () => {
    const queryBuilder = queryBuilderStub([
      {
        row_id: 'member-1',
        occurred_at_exact: '2026-10-05T12:00:00.000001Z',
        first_name: 'Marta',
        last_name: 'Quintela',
      },
    ]);
    const repository = { createQueryBuilder: jest.fn(() => queryBuilder) };
    const source = new ProfileJoinSource(
      repository as unknown as Repository<Profile>,
    );
    const [entry] = await source.fetch(windowWith());
    expect(queryBuilder.orderBy).toHaveBeenCalledWith(
      '"e"."joined_at"',
      'DESC',
    );
    expect(entry).toMatchObject({
      sourceKey: 'join',
      kind: 'member.joined',
      actorUserId: 'member-1',
      actorFallbackName: 'Marta Quintela',
      subject: null,
    });
  });
});
