import type { Repository } from 'typeorm';
import type { VerificationEvent } from '../../verification/entities/verification-event.entity';
import type { SourceWindow } from '../platform-log.types';
import { VerificationEventSource } from './verification-event.source';

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
  const source = new VerificationEventSource(
    repository as unknown as Repository<VerificationEvent>,
  );
  return { source, queryBuilder };
}

const BASE = {
  row_id: 'v1',
  occurred_at_exact: '2026-10-05T12:00:00.000001Z',
  user_id: 'member-1',
  from_level: 'basic',
  to_level: 'verified',
  reason: 'References check out.',
};

describe('VerificationEventSource', () => {
  it('excludes member-initiated actions for a moderator', async () => {
    const { source, queryBuilder } = sourceWith();
    await source.fetch(windowWith({ staffRowsOnly: true }));
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      '"e"."action" NOT IN (:...verificationMemberActions)',
      { verificationMemberActions: ['submitted', 'appealed', 'withdrawn'] },
    );
  });

  it('keeps member actions for an admin', async () => {
    const { source, queryBuilder } = sourceWith();
    await source.fetch(windowWith());
    expect(conditionsOf(queryBuilder).join(' ')).not.toContain(
      'verificationMemberActions',
    );
  });

  it('maps a staff decision with the member as target', async () => {
    const { source } = sourceWith([
      { ...BASE, action: 'approved', actor_user_id: 'staff-1' },
    ]);
    const [entry] = await source.fetch(windowWith());
    expect(entry).toMatchObject({
      sourceKey: 'ver',
      category: 'reviews',
      kind: 'verification.approved',
      actorUserId: 'staff-1',
      actorKind: 'staff',
      targetUserId: 'member-1',
      params: { fromLevel: 'basic', toLevel: 'verified' },
      subject: { label: '', route: '/admin/verifications' },
      note: 'References check out.',
    });
  });

  it('labels a staff decision with an erased reviewer as staff', async () => {
    const { source } = sourceWith([
      { ...BASE, action: 'approved', actor_user_id: null },
    ]);
    const [entry] = await source.fetch(windowWith());
    expect(entry).toMatchObject({
      actorKind: 'staff',
      actorUserId: null,
    });
  });

  it('maps a submission with the member as actor and no target', async () => {
    const { source } = sourceWith([
      { ...BASE, action: 'submitted', actor_user_id: null },
    ]);
    const [entry] = await source.fetch(windowWith());
    expect(entry).toMatchObject({
      actorUserId: 'member-1',
      actorKind: 'member',
      targetUserId: null,
    });
  });

  it('filters by member as actor or subject member', async () => {
    const { source, queryBuilder } = sourceWith();
    await source.fetch(windowWith({ memberId: 'member-1' }));
    expect(conditionsOf(queryBuilder)).toContain(
      '("e"."actor_user_id" = :memberId OR "e"."user_id" = :memberId)',
    );
  });

  it('skips the query outside the reviews category', async () => {
    const { source, queryBuilder } = sourceWith();
    expect(
      await source.fetch(windowWith({ categories: ['moderation'] })),
    ).toEqual([]);
    expect(queryBuilder.getRawMany).not.toHaveBeenCalled();
  });
});
