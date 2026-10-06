import type { Repository } from 'typeorm';
import type { SafeSpaceDecisionAudit } from '../../safe-space-nominations/entities/safe-space-decision-audit.entity';
import type { SourceWindow } from '../platform-log.types';
import { SafeSpaceDecisionAuditSource } from './safe-space-decision-audit.source';

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
  const source = new SafeSpaceDecisionAuditSource(
    repository as unknown as Repository<SafeSpaceDecisionAudit>,
  );
  return { source, queryBuilder };
}

const BASE = {
  row_id: 's1',
  occurred_at_exact: '2026-10-05T12:00:00.000001Z',
  actor_id: 'staff-1',
  reason: 'Three visits, all positive.',
  listing_name: 'Livraria Lilás',
};

describe('SafeSpaceDecisionAuditSource', () => {
  it('never selects the metadata column', async () => {
    const { source, queryBuilder } = sourceWith();
    await source.fetch(windowWith());
    const selected = [
      ...queryBuilder.select.mock.calls,
      ...queryBuilder.addSelect.mock.calls,
    ]
      .map(([sql]) => String(sql))
      .join(' ');
    expect(selected).not.toContain('metadata');
  });

  it('excludes member flags for a moderator', async () => {
    const { source, queryBuilder } = sourceWith();
    await source.fetch(windowWith({ staffRowsOnly: true }));
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      '"e"."action" NOT IN (:...safeSpaceMemberActions)',
      { safeSpaceMemberActions: ['flag_raised', 'flag_withdrawn'] },
    );
  });

  it('maps an award with the listing as subject', async () => {
    const { source } = sourceWith([{ ...BASE, action: 'nomination_awarded' }]);
    const [entry] = await source.fetch(windowWith());
    expect(entry).toMatchObject({
      sourceKey: 'safe',
      category: 'reviews',
      kind: 'safe_space.nomination_awarded',
      actorKind: 'staff',
      subject: { label: 'Livraria Lilás', route: '/admin/safe-spaces' },
      note: 'Three visits, all positive.',
    });
  });

  it('marks a member flag and a threshold suspension correctly', async () => {
    const { source } = sourceWith([
      { ...BASE, row_id: 'a', action: 'flag_raised', actor_id: 'member-1' },
      { ...BASE, row_id: 'b', action: 'badge_suspended', actor_id: null },
    ]);
    const entries = await source.fetch(windowWith());
    expect(entries.map((entry) => entry.actorKind)).toEqual([
      'member',
      'system',
    ]);
  });

  it('joins the listing for its name', async () => {
    const { source, queryBuilder } = sourceWith();
    await source.fetch(windowWith());
    expect(queryBuilder.leftJoin.mock.calls[0]?.[2]).toBe(
      '"l"."id" = "e"."listing_id"',
    );
  });
});
