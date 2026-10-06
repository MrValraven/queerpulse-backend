import type { Repository } from 'typeorm';
import type { ModAuditLog } from '../../moderation/entities/mod-audit-log.entity';
import type { SourceWindow } from '../platform-log.types';
import { ModAuditLogSource } from './mod-audit-log.source';

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

const ROW = {
  row_id: 'row-1',
  occurred_at_exact: '2026-10-05T12:00:00.123456Z',
  action: 'ban',
  actor_id: 'staff-1',
  target_user_id: 'member-1',
  target_name: 'Bea Lopes',
  report_id: 'report-1',
  reason_code: 'harassment',
  duration: null,
  note: 'Repeated slurs.',
};

function sourceWith(rows: Record<string, unknown>[] = []) {
  const queryBuilder = queryBuilderStub(rows);
  const repository = { createQueryBuilder: jest.fn(() => queryBuilder) };
  const source = new ModAuditLogSource(
    repository as unknown as Repository<ModAuditLog>,
  );
  return { source, queryBuilder, repository };
}

describe('ModAuditLogSource', () => {
  it('skips the query when neither of its categories is requested', async () => {
    const { source, repository } = sourceWith();
    expect(await source.fetch(windowWith({ categories: ['members'] }))).toEqual(
      [],
    );
    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('keeps only staff actions when only Staff & access is requested', async () => {
    const { source, queryBuilder } = sourceWith();
    await source.fetch(windowWith({ categories: ['staff'] }));
    expect(conditionsOf(queryBuilder)).toContain(
      '"e"."action" IN (:...modStaffActions)',
    );
  });

  it('excludes staff actions when only Moderation is requested', async () => {
    const { source, queryBuilder } = sourceWith();
    await source.fetch(windowWith({ categories: ['moderation'] }));
    expect(conditionsOf(queryBuilder)).toContain(
      '"e"."action" NOT IN (:...modStaffActions)',
    );
  });

  it('filters by member as actor or target', async () => {
    const { source, queryBuilder } = sourceWith();
    await source.fetch(windowWith({ memberId: 'member-1' }));
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      '("e"."actor_id" = :memberId OR "e"."target_user_id" = :memberId)',
      { memberId: 'member-1' },
    );
  });

  it('maps a report action with its snapshot, params and report link', async () => {
    const { source } = sourceWith([ROW]);
    const [entry] = await source.fetch(windowWith());
    expect(entry).toEqual({
      sourceKey: 'mod',
      rowId: 'row-1',
      occurredAtExact: ROW.occurred_at_exact,
      category: 'moderation',
      kind: 'mod.ban',
      actorUserId: 'staff-1',
      actorFallbackName: null,
      actorKind: 'staff',
      targetUserId: 'member-1',
      targetFallbackName: 'Bea Lopes',
      subject: { label: '', route: '/admin/moderation' },
      params: { reasonCode: 'harassment' },
      note: 'Repeated slurs.',
    });
  });

  it('files staff actions under Staff & access and unknown actions under Moderation', async () => {
    const { source } = sourceWith([
      { ...ROW, row_id: 'a', action: 'conversation_context_viewed' },
      { ...ROW, row_id: 'b', action: 'something_new_next_year' },
    ]);
    const entries = await source.fetch(windowWith());
    expect(entries.map((entry) => entry.category)).toEqual([
      'staff',
      'moderation',
    ]);
  });

  it('marks a null-actor ban hold expiry as a system action', async () => {
    const { source } = sourceWith([
      { ...ROW, action: 'ban_hold_expired', actor_id: null },
    ]);
    const [entry] = await source.fetch(windowWith());
    expect(entry?.actorKind).toBe('system');
  });
});
