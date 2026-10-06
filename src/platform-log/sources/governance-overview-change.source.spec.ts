import type { Repository } from 'typeorm';
import type { GovernanceOverviewChange } from '../../governance/entities/governance-overview-change.entity';
import type { SourceWindow } from '../platform-log.types';
import { GovernanceOverviewChangeSource } from './governance-overview-change.source';

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
  const source = new GovernanceOverviewChangeSource(
    repository as unknown as Repository<GovernanceOverviewChange>,
  );
  return { source, queryBuilder, repository };
}

describe('GovernanceOverviewChangeSource', () => {
  it('only answers the governance category', async () => {
    const { source, repository } = sourceWith();
    expect(
      await source.fetch(windowWith({ categories: ['moderation'] })),
    ).toEqual([]);
    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('filters by member as actor', async () => {
    const { source, queryBuilder } = sourceWith();
    await source.fetch(windowWith({ memberId: 'staff-1' }));
    expect(conditionsOf(queryBuilder)).toContain('"e"."actor_id" = :memberId');
  });

  it('maps a section change', async () => {
    const { source } = sourceWith([
      {
        row_id: 'g1',
        occurred_at_exact: '2026-10-05T12:00:00.000001Z',
        section: 'council',
        actor_id: 'staff-1',
        note: 'New members.',
      },
    ]);
    const [entry] = await source.fetch(windowWith());
    expect(entry).toMatchObject({
      sourceKey: 'gov',
      category: 'governance',
      kind: 'governance.section_changed',
      actorUserId: 'staff-1',
      actorKind: 'staff',
      targetUserId: null,
      targetFallbackName: null,
      subject: { label: '', route: '/admin/governance' },
      params: { section: 'council' },
      note: 'New members.',
    });
  });
});
