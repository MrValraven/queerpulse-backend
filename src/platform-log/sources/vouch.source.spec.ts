import type { Repository } from 'typeorm';
import type { Vouch } from '../../vouch/entities/vouch.entity';
import type { SourceWindow } from '../platform-log.types';
import { VouchSource } from './vouch.source';

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
  const source = new VouchSource(repository as unknown as Repository<Vouch>);
  return { source, queryBuilder };
}

describe('VouchSource', () => {
  it('is admin-only and skips withdrawn vouches', async () => {
    const { source, queryBuilder } = sourceWith();
    expect(source.audience).toBe('admin');
    await source.fetch(windowWith());
    expect(conditionsOf(queryBuilder)).toContain('"e"."withdrawn_at" IS NULL');
  });

  it('nulls the voucher of an anonymous vouch in SQL', async () => {
    const { source, queryBuilder } = sourceWith();
    await source.fetch(windowWith());
    expect(queryBuilder.addSelect).toHaveBeenCalledWith(
      'CASE WHEN "e"."anonymous" THEN NULL ELSE "e"."voucher_id" END',
      'voucher_id',
    );
  });

  it('never matches an anonymous vouch by its hidden voucher', async () => {
    const { source, queryBuilder } = sourceWith();
    await source.fetch(windowWith({ memberId: 'member-1' }));
    expect(conditionsOf(queryBuilder)).toContain(
      '(("e"."voucher_id" = :memberId AND "e"."anonymous" = false) OR "e"."vouchee_id" = :memberId)',
    );
  });

  it('maps an anonymous vouch with an anonymous actor', async () => {
    const { source } = sourceWith([
      {
        row_id: 'v1',
        occurred_at_exact: '2026-10-05T12:00:00.000001Z',
        voucher_id: null,
        is_anonymous: true,
        vouchee_id: 'member-2',
      },
    ]);
    const [entry] = await source.fetch(windowWith());
    expect(entry).toMatchObject({
      sourceKey: 'vouch',
      category: 'members',
      kind: 'member.vouch_given',
      actorUserId: null,
      actorKind: 'anonymous',
      targetUserId: 'member-2',
    });
  });
});
