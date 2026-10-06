import type { Repository } from 'typeorm';
import type { GovernanceFinanceChange } from '../../governance/entities/governance-finance-change.entity';
import type { SourceWindow } from '../platform-log.types';
import { GovernanceFinanceChangeSource } from './governance-finance-change.source';

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
  const source = new GovernanceFinanceChangeSource(
    repository as unknown as Repository<GovernanceFinanceChange>,
  );
  return { source, queryBuilder, repository };
}

describe('GovernanceFinanceChangeSource', () => {
  it('only answers the governance category', async () => {
    const { source, repository } = sourceWith();
    expect(await source.fetch(windowWith({ categories: ['staff'] }))).toEqual(
      [],
    );
    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('maps a finance field change with old and new values', async () => {
    const { source } = sourceWith([
      {
        row_id: 'f1',
        occurred_at_exact: '2026-10-05T12:00:00.000001Z',
        field: 'mrr',
        old_value: '900',
        new_value: '1200',
        actor_id: 'staff-1',
        note: null,
      },
    ]);
    const [entry] = await source.fetch(windowWith());
    expect(entry).toMatchObject({
      sourceKey: 'fin',
      kind: 'governance.finance_changed',
      params: { field: 'mrr', oldValue: '900', newValue: '1200' },
      subject: { label: '', route: '/admin/governance' },
      note: null,
    });
  });

  it('filters by member as actor', async () => {
    const { source, queryBuilder } = sourceWith();
    await source.fetch(windowWith({ memberId: 'staff-1' }));
    expect(conditionsOf(queryBuilder)).toContain('"e"."actor_id" = :memberId');
  });
});
