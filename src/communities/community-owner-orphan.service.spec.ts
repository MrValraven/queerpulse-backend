import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CommunityGovernanceLogService } from './community-governance-log.service';
import { CommunityOwnerOrphanService } from './community-owner-orphan.service';
import { SubcommunityCascadeService } from './subcommunity-cascade.service';
import { GovernanceLogAction } from './entities/community-governance-log.entity';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { Community } from './entities/community.entity';

const ERASED_OWNER_ID = 'erased-owner';
const PARENT_OWNER_ID = 'parent-owner';

const SPACE = {
  id: 'space-1',
  ownerId: ERASED_OWNER_ID,
  parentId: 'parent-1',
  rules: [],
  rulesVersion: 1,
} as unknown as Community;

// The ordered "longest-tenured co-owner, else mod" candidate query.
// `getOne` answers null: the space has nobody to promote from its own roster.
const candidateQueryStub = (candidate: CommunityMember | null = null) => {
  const queryBuilder: Record<string, jest.Mock> = {};
  for (const method of [
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'setParameter',
    'limit',
  ]) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getOne = jest.fn().mockResolvedValue(candidate);
  return queryBuilder;
};

describe('CommunityOwnerOrphanService', () => {
  let service: CommunityOwnerOrphanService;
  let communities: { find: jest.Mock };
  let governanceLog: { log: jest.Mock };
  let memberRepository: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
  };
  let manager: {
    findOne: jest.Mock;
    delete: jest.Mock;
    update: jest.Mock;
    getRepository: jest.Mock;
  };

  const givenParentOwner = (parentOwnerId: string | null) => {
    manager.findOne.mockImplementation(
      (_entity: unknown, options: { where: { id: string } }) =>
        Promise.resolve(
          options.where.id === SPACE.id
            ? SPACE
            : { id: 'parent-1', ownerId: parentOwnerId },
        ),
    );
  };

  beforeEach(async () => {
    communities = { find: jest.fn().mockResolvedValue([SPACE]) };
    governanceLog = { log: jest.fn().mockResolvedValue(undefined) };
    memberRepository = {
      createQueryBuilder: jest.fn(() => candidateQueryStub()),
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(undefined),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
      create: jest.fn((row: unknown) => row),
    };
    manager = {
      findOne: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn(() => memberRepository),
    };
    givenParentOwner(PARENT_OWNER_ID);
    const dataSource = {
      transaction: jest.fn(
        (callback: (transactionManager: unknown) => Promise<unknown>) =>
          callback(manager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityOwnerOrphanService,
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: DataSource, useValue: dataSource },
        { provide: CommunityGovernanceLogService, useValue: governanceLog },
        // The real owner upsert: it only drives the transaction manager.
        SubcommunityCascadeService,
      ],
    }).compile();
    service = module.get(CommunityOwnerOrphanService);
  });

  describe('a space with no co-owner or mod left', () => {
    it("falls back to the parent's owner", async () => {
      await service.handleOwnerErasure(ERASED_OWNER_ID);

      expect(memberRepository.save).toHaveBeenCalledWith({
        communityId: SPACE.id,
        userId: PARENT_OWNER_ID,
        role: RosterRole.Owner,
      });
      expect(manager.update).toHaveBeenCalledWith(
        Community,
        { id: SPACE.id },
        { ownerId: PARENT_OWNER_ID, needsOwnerReviewAt: null },
      );
      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          communityId: SPACE.id,
          action: GovernanceLogAction.OwnerAutoPromoted,
          targetUserId: PARENT_OWNER_ID,
          metadata: expect.objectContaining({
            reason: 'parent_owner_fallback',
          }) as unknown,
        }),
      );
    });

    it("raises the parent owner's existing space row to owner", async () => {
      memberRepository.findOne.mockResolvedValue({
        id: 'row-1',
        role: RosterRole.Member,
      });

      await service.handleOwnerErasure(ERASED_OWNER_ID);

      expect(memberRepository.update).toHaveBeenCalledWith('row-1', {
        role: RosterRole.Owner,
      });
      expect(memberRepository.save).not.toHaveBeenCalled();
    });

    it('stamps the rules acceptance on a new owner row when the space has rules', async () => {
      manager.findOne.mockImplementation(
        (_entity: unknown, options: { where: { id: string } }) =>
          Promise.resolve(
            options.where.id === SPACE.id
              ? { ...SPACE, rules: ['Be kind'], rulesVersion: 3 }
              : { id: 'parent-1', ownerId: PARENT_OWNER_ID },
          ),
      );

      await service.handleOwnerErasure(ERASED_OWNER_ID);

      expect(memberRepository.save).toHaveBeenCalledWith({
        communityId: SPACE.id,
        userId: PARENT_OWNER_ID,
        role: RosterRole.Owner,
        rulesAcceptedAt: expect.any(Date) as unknown,
        rulesVersionAccepted: 3,
      });
    });

    it('keeps the NULL owner and review stamp when the parent has no owner', async () => {
      givenParentOwner(null);

      await service.handleOwnerErasure(ERASED_OWNER_ID);

      expect(manager.update).toHaveBeenCalledWith(Community, SPACE.id, {
        ownerId: null,
        needsOwnerReviewAt: expect.any(Date) as unknown,
      });
      expect(governanceLog.log).not.toHaveBeenCalled();
    });

    it('never hands the space back to the erased account when it owned the parent too', async () => {
      givenParentOwner(ERASED_OWNER_ID);

      await service.handleOwnerErasure(ERASED_OWNER_ID);

      expect(memberRepository.save).not.toHaveBeenCalled();
      expect(manager.update).toHaveBeenCalledWith(Community, SPACE.id, {
        ownerId: null,
        needsOwnerReviewAt: expect.any(Date) as unknown,
      });
    });
  });
});
