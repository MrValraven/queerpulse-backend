import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator, SelectQueryBuilder } from 'typeorm';
import { IdentityBlock } from '../identities/entities/identity-block.entity';
import { BlockFilterService } from './block-filter.service';
import { Block } from './entities/block.entity';
import { Mute } from './entities/mute.entity';

describe('BlockFilterService', () => {
  let service: BlockFilterService;
  let blocks: { exist: jest.Mock; find: jest.Mock };
  let mutes: { exist: jest.Mock };
  // Task 14: `identity_blocks` rows, read by a stand-in that evaluates the
  // `where` it is given, `In(...)` included, over this list.
  let identityBlockRows: Array<{ blockerUserId: string; identityId: string }>;
  let identityBlocks: { exist: jest.Mock; find: jest.Mock };

  beforeEach(async () => {
    blocks = {
      exist: jest.fn().mockResolvedValue(false),
      find: jest.fn().mockResolvedValue([]),
    };
    mutes = { exist: jest.fn().mockResolvedValue(false) };
    identityBlockRows = [];
    const matchesValue = (expected: unknown, actual: string) =>
      expected instanceof FindOperator
        ? (expected.value as string[]).includes(actual)
        : expected === actual;
    const matchingRows = (where: Record<string, unknown>) =>
      identityBlockRows.filter((row) =>
        Object.entries(where).every(([column, expected]) =>
          matchesValue(expected, row[column as keyof typeof row]),
        ),
      );
    identityBlocks = {
      exist: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(matchingRows(where).length > 0),
      ),
      find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(matchingRows(where)),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BlockFilterService,
        { provide: getRepositoryToken(Block), useValue: blocks },
        { provide: getRepositoryToken(Mute), useValue: mutes },
        {
          provide: getRepositoryToken(IdentityBlock),
          useValue: identityBlocks,
        },
      ],
    }).compile();
    service = module.get(BlockFilterService);
  });

  describe('isBlockedEitherWay', () => {
    it('is false for the same user (never blocks yourself)', async () => {
      await expect(service.isBlockedEitherWay('a', 'a')).resolves.toBe(false);
      expect(blocks.exist).not.toHaveBeenCalled();
    });

    it('queries both directions of the pair', async () => {
      await service.isBlockedEitherWay('a', 'b');
      expect(blocks.exist).toHaveBeenCalledWith({
        where: [
          { blockerId: 'a', blockedId: 'b' },
          { blockerId: 'b', blockedId: 'a' },
        ],
      });
    });

    it('is true when either direction has a row', async () => {
      blocks.exist.mockResolvedValue(true);
      await expect(service.isBlockedEitherWay('a', 'b')).resolves.toBe(true);
    });

    it('is false when neither direction has a row', async () => {
      blocks.exist.mockResolvedValue(false);
      await expect(service.isBlockedEitherWay('a', 'b')).resolves.toBe(false);
    });
  });

  describe('isMutedBy', () => {
    it('is false for the same user', async () => {
      await expect(service.isMutedBy('a', 'a')).resolves.toBe(false);
      expect(mutes.exist).not.toHaveBeenCalled();
    });

    it('is directional: checks only actor-muted-target, not the reverse', async () => {
      await service.isMutedBy('actor', 'target');
      expect(mutes.exist).toHaveBeenCalledWith({
        where: { muterId: 'actor', mutedId: 'target' },
      });
    });

    it('is true when actor has muted target', async () => {
      mutes.exist.mockResolvedValue(true);
      await expect(service.isMutedBy('actor', 'target')).resolves.toBe(true);
    });

    it('does not imply the reverse mute', async () => {
      // actor muted target (true), but target muting actor is a distinct row
      // this service was not asked about here.
      mutes.exist.mockResolvedValue(true);
      await service.isMutedBy('actor', 'target');
      expect(mutes.exist).toHaveBeenCalledWith({
        where: { muterId: 'actor', mutedId: 'target' },
      });
      expect(mutes.exist).not.toHaveBeenCalledWith({
        where: { muterId: 'target', mutedId: 'actor' },
      });
    });
  });

  describe('excludeBlocked', () => {
    function qbStub(): Record<string, jest.Mock> {
      const qb: Record<string, jest.Mock> = {};
      qb.andWhere = jest.fn().mockReturnValue(qb);
      return qb;
    }

    it('appends a NOT EXISTS predicate scoped to the actor and given column', () => {
      const qb = qbStub();
      const result = service.excludeBlocked(
        qb as unknown as SelectQueryBuilder<Record<string, unknown>>,
        'me',
        '"cp"."author_id"',
      );
      expect(qb.andWhere).toHaveBeenCalledTimes(1);
      const [sql, params] = qb.andWhere!.mock.calls[0] as [string, unknown];
      expect(sql).toContain('NOT EXISTS');
      expect(sql).toContain('"cp"."author_id"');
      expect(sql).toContain(':blockFilterActorId');
      expect(params).toEqual({ blockFilterActorId: 'me' });
      expect(result).toBe(qb);
    });
  });

  // Messaging scan section 8 (Groups) fix: PRD-354 must also refuse two
  // CANDIDATES in the same batch who blocked each other, not only a
  // candidate blocked with a guardian.
  describe('blockedAgainstAnyOf', () => {
    it('flags a candidate blocked either way with a guardian', async () => {
      blocks.find.mockResolvedValue([
        { blockerId: 'guardian', blockedId: 'candidate-a' },
      ]);
      const result = await service.blockedAgainstAnyOf(
        ['candidate-a', 'candidate-b'],
        ['guardian'],
      );
      expect(result).toEqual(new Set(['candidate-a']));
    });

    it('flags BOTH sides of a block between two candidates in the same batch, with no guardians involved', async () => {
      blocks.find.mockResolvedValue([
        { blockerId: 'candidate-a', blockedId: 'candidate-b' },
      ]);
      const result = await service.blockedAgainstAnyOf(
        ['candidate-a', 'candidate-b'],
        [],
      );
      expect(result).toEqual(new Set(['candidate-a', 'candidate-b']));
      // One batched round trip: the candidate set is folded into the
      // guarded set so a single query catches both shapes.
      expect(blocks.find).toHaveBeenCalledTimes(1);
      const [{ where }] = blocks.find.mock.calls[0] as [{ where: unknown[] }];
      expect(where).toHaveLength(2);
    });

    it('short-circuits with no query when candidates is empty', async () => {
      await expect(
        service.blockedAgainstAnyOf([], ['guardian']),
      ).resolves.toEqual(new Set());
      expect(blocks.find).not.toHaveBeenCalled();
    });

    it('still queries a single candidate with no guardians (its own batch is the guard set)', async () => {
      // No other candidate and no guardian to pair against, so no block row
      // could ever match, but the candidate set alone is enough to avoid
      // the old all-guardians-empty short-circuit that this fix removed.
      await expect(
        service.blockedAgainstAnyOf(['candidate-a'], []),
      ).resolves.toEqual(new Set());
      expect(blocks.find).toHaveBeenCalledTimes(1);
    });
  });

  describe('Task 14: identity blocks', () => {
    const OWNER = 'owner-user';
    const CUSTOMER = 'customer-user';
    const BUSINESS_IDENTITY = 'business-identity';
    const OWNER_PROFILE_IDENTITY = 'owner-profile-identity';

    it('is true for a business the member blocked', async () => {
      identityBlockRows = [
        { blockerUserId: CUSTOMER, identityId: BUSINESS_IDENTITY },
      ];

      await expect(
        service.isIdentityBlocked(CUSTOMER, BUSINESS_IDENTITY),
      ).resolves.toBe(true);
    });

    it("is false for the business owner's own profile identity, which a block of the business leaves alone", async () => {
      identityBlockRows = [
        { blockerUserId: CUSTOMER, identityId: BUSINESS_IDENTITY },
      ];

      await expect(
        service.isIdentityBlocked(CUSTOMER, OWNER_PROFILE_IDENTITY),
      ).resolves.toBe(false);
    });

    it('is false for the business when the member blocked only its owner as a person', async () => {
      blocks.exist.mockResolvedValue(true);

      await expect(service.isBlockedEitherWay(CUSTOMER, OWNER)).resolves.toBe(
        true,
      );
      await expect(
        service.isIdentityBlocked(CUSTOMER, BUSINESS_IDENTITY),
      ).resolves.toBe(false);
    });

    it("is directional: the business's block list never answers for its customers", async () => {
      identityBlockRows = [
        { blockerUserId: CUSTOMER, identityId: BUSINESS_IDENTITY },
      ];

      await expect(
        service.isIdentityBlocked(OWNER, BUSINESS_IDENTITY),
      ).resolves.toBe(false);
    });

    it("lists every identity the member blocked, and no one else's", async () => {
      identityBlockRows = [
        { blockerUserId: CUSTOMER, identityId: BUSINESS_IDENTITY },
        { blockerUserId: CUSTOMER, identityId: 'persona-identity' },
        { blockerUserId: OWNER, identityId: 'company-identity' },
      ];

      await expect(service.blockedIdentityIds(CUSTOMER)).resolves.toEqual([
        BUSINESS_IDENTITY,
        'persona-identity',
      ]);
    });

    it('reads many blockers and identities in one query, and none for an empty side', async () => {
      identityBlockRows = [
        { blockerUserId: CUSTOMER, identityId: BUSINESS_IDENTITY },
        { blockerUserId: OWNER, identityId: 'company-identity' },
      ];

      await expect(
        service.identityBlocksAmong(
          [CUSTOMER, CUSTOMER, OWNER],
          [BUSINESS_IDENTITY],
        ),
      ).resolves.toEqual([
        { blockerUserId: CUSTOMER, identityId: BUSINESS_IDENTITY },
      ]);
      expect(identityBlocks.find).toHaveBeenCalledTimes(1);
      await expect(
        service.identityBlocksAmong([], [BUSINESS_IDENTITY]),
      ).resolves.toEqual([]);
      expect(identityBlocks.find).toHaveBeenCalledTimes(1);
    });
  });
});
