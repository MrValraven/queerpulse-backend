import type { Repository } from 'typeorm';
import type { Report } from '../../reports/entities/report.entity';
import type { SourceWindow } from '../platform-log.types';
import { ReportFiledSource } from './report-filed.source';

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
  const source = new ReportFiledSource(
    repository as unknown as Repository<Report>,
  );
  return { source, queryBuilder };
}

describe('ReportFiledSource', () => {
  it('never matches an anonymous report by its hidden reporter', async () => {
    const { source, queryBuilder } = sourceWith();
    await source.fetch(windowWith({ memberId: 'member-1' }));
    expect(conditionsOf(queryBuilder)).toContain(
      '("e"."reporter_id" = :memberId AND "e"."anonymous" = false)',
    );
  });

  it('maps an anonymous emergency report to the emergencies tab', async () => {
    const { source } = sourceWith([
      {
        row_id: 'r1',
        occurred_at_exact: '2026-10-05T12:00:00.123000Z',
        reporter_id: null,
        is_anonymous: true,
        severity: 'emergency',
      },
    ]);
    const [entry] = await source.fetch(windowWith());
    expect(entry).toMatchObject({
      kind: 'member.report_filed',
      actorUserId: null,
      actorKind: 'anonymous',
      params: { severity: 'emergency' },
      subject: { label: '', route: '/admin/moderation?tab=emergencies' },
    });
  });

  it('reads a named report with an erased reporter as a member with no id', async () => {
    const { source } = sourceWith([
      {
        row_id: 'r2',
        occurred_at_exact: '2026-10-05T12:00:00.123000Z',
        reporter_id: null,
        is_anonymous: false,
        severity: 'low',
      },
    ]);
    const [entry] = await source.fetch(windowWith());
    expect(entry).toMatchObject({
      actorKind: 'member',
      actorUserId: null,
      subject: { route: '/admin/moderation' },
    });
  });
});
