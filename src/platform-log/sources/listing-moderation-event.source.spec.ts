import type { Repository } from 'typeorm';
import type { ListingModerationEvent } from '../../listings/entities/listing-moderation-event.entity';
import type { SourceWindow } from '../platform-log.types';
import { ListingModerationEventSource } from './listing-moderation-event.source';

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
  const source = new ListingModerationEventSource(
    repository as unknown as Repository<ListingModerationEvent>,
  );
  return { source, queryBuilder };
}

const BASE = {
  row_id: 'l1',
  occurred_at_exact: '2026-10-05T12:00:00.000001Z',
  actor_id: 'person-1',
  from_status: null,
  to_status: null,
  reason: null,
  listing_name: 'Café Arco-Íris',
  listing_ref: 'cafe-arco-iris',
  actor_role: 'member',
};

describe('ListingModerationEventSource', () => {
  it('excludes member and member-run mixed actions for a moderator', async () => {
    const { source, queryBuilder } = sourceWith();
    await source.fetch(windowWith({ staffRowsOnly: true }));
    expect(conditionsOf(queryBuilder)).toContain(
      '("e"."action" NOT IN (:...listingMemberActions) AND ' +
        '("e"."action" NOT IN (:...listingMixedActions) OR "u"."role" IN (:...listingStaffRoles)))',
    );
  });

  it('classifies owner edits as member rows and staff edits as staff rows', async () => {
    const { source } = sourceWith([
      { ...BASE, row_id: 'a', action: 'owner_edited' },
      { ...BASE, row_id: 'b', action: 'staff_edited', actor_role: 'admin' },
    ]);
    const entries = await source.fetch(windowWith());
    expect(entries.map((entry) => entry.actorKind)).toEqual([
      'member',
      'staff',
    ]);
  });

  it('classifies a mixed action by the actor role', async () => {
    const { source } = sourceWith([
      {
        ...BASE,
        row_id: 'a',
        action: 'co_manager_removed',
        actor_role: 'member',
      },
      {
        ...BASE,
        row_id: 'b',
        action: 'co_manager_removed',
        actor_role: 'moderator',
      },
    ]);
    const entries = await source.fetch(windowWith());
    expect(entries.map((entry) => entry.actorKind)).toEqual([
      'member',
      'staff',
    ]);
  });

  it('links the listing through the admin listings search', async () => {
    const { source } = sourceWith([
      {
        ...BASE,
        action: 'removed',
        actor_role: 'admin',
        reason: 'Closed for good.',
      },
    ]);
    const [entry] = await source.fetch(windowWith());
    expect(entry).toMatchObject({
      sourceKey: 'list',
      kind: 'listing.removed',
      subject: {
        label: 'Café Arco-Íris',
        route: '/admin/listings?q=cafe-arco-iris',
      },
      note: 'Closed for good.',
    });
  });
});
