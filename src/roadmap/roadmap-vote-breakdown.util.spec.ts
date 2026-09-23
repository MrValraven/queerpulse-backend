import { RoadmapVoteTarget } from './entities/roadmap-vote.entity';
import { computeVoteBreakdown } from './roadmap-vote-breakdown.util';

// Named properties, so a chained call like
// `voteQueryBuilder.getRawMany.mockResolvedValue(...)` types as a plain
// `jest.Mock` under `noUncheckedIndexedAccess`.
interface QueryBuilderStub {
  select: jest.Mock;
  addSelect: jest.Mock;
  innerJoin: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  getRawMany: jest.Mock;
}

const CHAINED_BUILDER_METHODS = [
  'select',
  'addSelect',
  'innerJoin',
  'where',
  'andWhere',
  'orderBy',
  'addOrderBy',
] as const;

// A chainable query-builder stub, mirrors `landing.service.spec.ts`'s
// `qbStub`, extended with `innerJoin`/`addOrderBy` for this module's queries.
function qbStub(): QueryBuilderStub {
  const queryBuilder = {} as QueryBuilderStub;
  for (const chainedMethod of CHAINED_BUILDER_METHODS) {
    queryBuilder[chainedMethod] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getRawMany = jest.fn().mockResolvedValue([]);
  return queryBuilder;
}

describe('computeVoteBreakdown', () => {
  it('never attributes a vote to a space: only top-level community memberships are queried', async () => {
    const voteQueryBuilder = qbStub();
    voteQueryBuilder.getRawMany.mockResolvedValue([
      { targetId: 'target-1', memberId: 'member-1' },
    ]);
    const votes = { createQueryBuilder: jest.fn(() => voteQueryBuilder) };

    const membershipQueryBuilder = qbStub();
    const communityMembers = {
      createQueryBuilder: jest.fn(() => membershipQueryBuilder),
    };

    await computeVoteBreakdown(
      // Only `createQueryBuilder` is ever called on either repository here.
      votes as never,
      communityMembers as never,
      RoadmapVoteTarget.Item,
      ['target-1'],
    );

    expect(membershipQueryBuilder.andWhere).toHaveBeenCalledWith(
      'community.parent_id IS NULL',
    );
  });
});
