import type { Repository } from 'typeorm';
import type { RoadmapAuditLog } from '../../roadmap/entities/roadmap-audit-log.entity';
import type { SourceWindow } from '../platform-log.types';
import { RoadmapAuditLogSource } from './roadmap-audit-log.source';

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
  const source = new RoadmapAuditLogSource(
    repository as unknown as Repository<RoadmapAuditLog>,
  );
  return { source, queryBuilder, repository };
}

const ROW = {
  row_id: 'r1',
  occurred_at_exact: '2026-10-05T12:00:00.000001Z',
  actor_id: 'staff-1',
  actor_label: 'Júlia Saraiva',
  action: 'Moved "Group calls" to Next',
};

describe('RoadmapAuditLogSource', () => {
  it('passes the stored action text through as a param', async () => {
    const { source } = sourceWith([ROW]);
    const [entry] = await source.fetch(windowWith());
    expect(entry).toMatchObject({
      sourceKey: 'road',
      kind: 'roadmap.changed',
      actorKind: 'staff',
      actorFallbackName: 'Júlia Saraiva',
      params: { action: 'Moved "Group calls" to Next' },
      subject: { label: '', route: '/admin/roadmap' },
      note: null,
    });
  });

  it('treats a null actor as the system, keeping its label', async () => {
    const { source } = sourceWith([
      { ...ROW, actor_id: null, actor_label: 'Seed import' },
    ]);
    const [entry] = await source.fetch(windowWith());
    expect(entry).toMatchObject({
      actorKind: 'system',
      actorFallbackName: 'Seed import',
    });
  });

  it('filters by member as actor', async () => {
    const { source, queryBuilder } = sourceWith();
    await source.fetch(windowWith({ memberId: 'staff-1' }));
    expect(conditionsOf(queryBuilder)).toContain('"e"."actor_id" = :memberId');
  });
});
