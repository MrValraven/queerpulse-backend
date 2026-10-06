import type { Repository } from 'typeorm';
import type { PlatformJoinRequest } from '../../membership/entities/join-request.entity';
import type { SourceWindow } from '../platform-log.types';
import { JoinRequestSource } from './join-request.source';

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

function sourceWith(rows: Record<string, unknown>[] = []) {
  const queryBuilder = queryBuilderStub(rows);
  const repository = { createQueryBuilder: jest.fn(() => queryBuilder) };
  const source = new JoinRequestSource(
    repository as unknown as Repository<PlatformJoinRequest>,
  );
  return { source, repository };
}

describe('JoinRequestSource', () => {
  it('returns nothing under a member filter, since applicants have no account', async () => {
    const { source, repository } = sourceWith();
    expect(await source.fetch(windowWith({ memberId: 'member-1' }))).toEqual(
      [],
    );
    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('uses the name on the request as the actor', async () => {
    const { source } = sourceWith([
      {
        row_id: 'j1',
        occurred_at_exact: '2026-10-05T12:00:00.000001Z',
        applicant_name: 'Alex Pereira',
      },
    ]);
    const [entry] = await source.fetch(windowWith());
    expect(entry).toMatchObject({
      kind: 'member.join_requested',
      actorUserId: null,
      actorFallbackName: 'Alex Pereira',
      actorKind: 'member',
      subject: { label: '', route: '/admin/members?tab=verification' },
    });
  });
});
