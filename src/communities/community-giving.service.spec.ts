import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { CommunityGivingService } from './community-giving.service';
import { CommunityGovernanceLogService } from './community-governance-log.service';
import { CommunityMembershipService } from './community-membership.service';
import { UpdateCommunityGivingDto } from './dto/update-community-giving.dto';
import {
  CommunityGivingKind,
  CommunityGivingMethod,
} from './entities/community-giving-method.entity';
import { GovernanceLogAction } from './entities/community-governance-log.entity';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { AccessTier, Community } from './entities/community.entity';

const COMMUNITY_ID = 'community-1';
const SLUG = 'lisbon-queer';
const OWNER_ID = 'owner-1';
const VIEWER_ID = 'viewer-1';

const EARLIER = new Date('2026-10-01T10:00:00.000Z');
const LATER = new Date('2026-10-05T18:30:00.000Z');
const SAVED_AT = new Date('2026-10-19T09:00:00.000Z');

const VALID_LINK = 'https://ko-fi.com/queerpulse';
const VALID_IBAN_CANONICAL = 'PT50000201231234567890154';
const INVALID_IBAN = 'PT50000201231234567890155';

function makeCommunity(overrides: Partial<Community> = {}): Community {
  return {
    id: COMMUNITY_ID,
    slug: SLUG,
    parentId: null,
    archivedAt: null,
    accessTier: AccessTier.Public,
    givingIntro: null,
    ...overrides,
  } as unknown as Community;
}

function makeRow(
  overrides: Partial<CommunityGivingMethod> = {},
): CommunityGivingMethod {
  return {
    id: 'row-1',
    communityId: COMMUNITY_ID,
    kind: CommunityGivingKind.Link,
    label: null,
    value: VALID_LINK,
    note: null,
    position: 0,
    createdAt: EARLIER,
    updatedAt: EARLIER,
    ...overrides,
  };
}

function makeDto(
  overrides: Partial<UpdateCommunityGivingDto> = {},
): UpdateCommunityGivingDto {
  return {
    intro: null,
    methods: [],
    ...overrides,
  };
}

describe('CommunityGivingService', () => {
  let service: CommunityGivingService;
  let communities: { findOne: jest.Mock };
  let members: { findOne: jest.Mock; find: jest.Mock };
  let givingMethods: { find: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let manager: { getRepository: jest.Mock; query: jest.Mock };
  let communityRepository: { findOne: jest.Mock; update: jest.Mock };
  let methodRepository: {
    find: jest.Mock;
    delete: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
  };
  let membership: { effectiveRole: jest.Mock };
  let contentModeration: { stateFor: jest.Mock };
  let governanceLog: { log: jest.Mock };

  /** The caller's own roster row, as `resolveOwnerLevelCommunity` reads it. */
  function callerHoldsRole(role: RosterRole): void {
    members.findOne.mockResolvedValue({
      communityId: COMMUNITY_ID,
      userId: OWNER_ID,
      role,
    });
  }

  beforeEach(() => {
    communities = { findOne: jest.fn().mockResolvedValue(makeCommunity()) };
    members = { findOne: jest.fn().mockResolvedValue(null), find: jest.fn() };
    givingMethods = { find: jest.fn().mockResolvedValue([]) };
    communityRepository = {
      findOne: jest.fn().mockResolvedValue(makeCommunity()),
      update: jest.fn().mockResolvedValue(undefined),
    };
    methodRepository = {
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue(undefined),
      create: jest.fn(
        (row: Partial<CommunityGivingMethod>): Partial<CommunityGivingMethod> =>
          row,
      ),
      save: jest.fn((rows: Partial<CommunityGivingMethod>[]) =>
        Promise.resolve(
          rows.map((row, index) => ({
            ...row,
            id: `saved-${index}`,
            createdAt: SAVED_AT,
            updatedAt: SAVED_AT,
          })),
        ),
      ),
    };
    manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === Community) return communityRepository;
        if (entity === CommunityGivingMethod) return methodRepository;
        throw new Error('Unexpected repository in the giving transaction');
      }),
      query: jest.fn().mockResolvedValue([[], 1]),
    };
    dataSource = {
      transaction: jest.fn(
        (callback: (transactionManager: EntityManager) => Promise<unknown>) =>
          callback(manager as unknown as EntityManager),
      ),
    };
    membership = { effectiveRole: jest.fn().mockResolvedValue(null) };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };
    governanceLog = { log: jest.fn().mockResolvedValue(undefined) };

    service = new CommunityGivingService(
      communities as unknown as Repository<Community>,
      members as unknown as Repository<CommunityMember>,
      givingMethods as unknown as Repository<CommunityGivingMethod>,
      dataSource as unknown as DataSource,
      membership as unknown as CommunityMembershipService,
      contentModeration as unknown as ContentModerationService,
      governanceLog as unknown as CommunityGovernanceLogService,
    );
  });

  describe('getBySlug', () => {
    it('getBySlug returns intro and methods in position order', async () => {
      communities.findOne.mockResolvedValue(
        makeCommunity({ givingIntro: 'Rent for the space and snacks' }),
      );
      membership.effectiveRole.mockResolvedValue(RosterRole.Member);
      givingMethods.find.mockResolvedValue([
        makeRow({ id: 'row-a', position: 0, updatedAt: EARLIER }),
        makeRow({
          id: 'row-b',
          kind: CommunityGivingKind.Mbway,
          label: 'Treasurer',
          value: '912345678',
          position: 1,
          updatedAt: LATER,
        }),
      ]);

      const dto = await service.getBySlug(SLUG, VIEWER_ID);

      expect(givingMethods.find).toHaveBeenCalledWith({
        where: { communityId: COMMUNITY_ID },
        order: { position: 'ASC', createdAt: 'ASC' },
      });
      expect(dto).toEqual({
        intro: 'Rent for the space and snacks',
        methods: [
          {
            id: 'row-a',
            kind: 'link',
            label: null,
            value: VALID_LINK,
            note: null,
            position: 0,
          },
          {
            id: 'row-b',
            kind: 'mbway',
            label: 'Treasurer',
            value: '912345678',
            note: null,
            position: 1,
          },
        ],
        updatedAt: LATER.toISOString(),
      });
    });

    it('getBySlug returns updatedAt null with no methods', async () => {
      const dto = await service.getBySlug(SLUG, VIEWER_ID);

      expect(dto).toEqual({ intro: null, methods: [], updatedAt: null });
    });

    it('getBySlug refuses a request-tier non-member with COMMUNITY_MEMBERS_ONLY', async () => {
      communities.findOne.mockResolvedValue(
        makeCommunity({ accessTier: AccessTier.Request }),
      );
      membership.effectiveRole.mockResolvedValue(null);

      const failure: unknown = await service
        .getBySlug(SLUG, VIEWER_ID)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ForbiddenException);
      expect((failure as ForbiddenException).getResponse()).toMatchObject({
        code: 'COMMUNITY_MEMBERS_ONLY',
      });
      expect(givingMethods.find).not.toHaveBeenCalled();
    });
  });

  describe('replaceBySlug', () => {
    it('replaceBySlug refuses a moderator before opening a transaction', async () => {
      callerHoldsRole(RosterRole.Mod);

      await expect(
        service.replaceBySlug(
          SLUG,
          OWNER_ID,
          makeDto({
            methods: [{ kind: CommunityGivingKind.Link, value: VALID_LINK }],
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('replaceBySlug refuses 9 methods with GIVING_TOO_MANY_METHODS', async () => {
      callerHoldsRole(RosterRole.Owner);
      const nineMethods = Array.from({ length: 9 }, () => ({
        kind: CommunityGivingKind.Link,
        value: VALID_LINK,
      }));

      const failure: unknown = await service
        .replaceBySlug(SLUG, OWNER_ID, makeDto({ methods: nineMethods }))
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(BadRequestException);
      const response = (failure as BadRequestException).getResponse();
      expect(response).toMatchObject({ code: 'GIVING_TOO_MANY_METHODS' });
      expect(response).not.toHaveProperty('index');
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('replaceBySlug refuses an invalid IBAN at index 1', async () => {
      callerHoldsRole(RosterRole.CoOwner);

      const failure: unknown = await service
        .replaceBySlug(
          SLUG,
          OWNER_ID,
          makeDto({
            methods: [
              { kind: CommunityGivingKind.Link, value: VALID_LINK },
              { kind: CommunityGivingKind.Iban, value: INVALID_IBAN },
            ],
          }),
        )
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(BadRequestException);
      const response = (failure as BadRequestException).getResponse();
      expect(response).toMatchObject({
        code: 'GIVING_IBAN_INVALID',
        index: 1,
      });
      expect(JSON.stringify(response)).not.toContain('PT5000020123');
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('replaceBySlug locks the community row', async () => {
      callerHoldsRole(RosterRole.Owner);

      await service.replaceBySlug(
        SLUG,
        OWNER_ID,
        makeDto({
          methods: [{ kind: CommunityGivingKind.Link, value: VALID_LINK }],
        }),
      );

      expect(communityRepository.findOne).toHaveBeenCalledWith({
        where: { id: COMMUNITY_ID },
        lock: { mode: 'for_no_key_update' },
      });
    });

    it('replaceBySlug 404s when the community was archived before the lock', async () => {
      callerHoldsRole(RosterRole.Owner);
      communityRepository.findOne.mockResolvedValue(
        makeCommunity({ archivedAt: LATER }),
      );

      await expect(
        service.replaceBySlug(
          SLUG,
          OWNER_ID,
          makeDto({
            methods: [{ kind: CommunityGivingKind.Link, value: VALID_LINK }],
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(methodRepository.find).not.toHaveBeenCalled();
      expect(methodRepository.delete).not.toHaveBeenCalled();
      expect(manager.query).not.toHaveBeenCalled();
      expect(governanceLog.log).not.toHaveBeenCalled();
    });

    it('replaceBySlug rewrites the set with positions 0..n-1 and canonical values', async () => {
      callerHoldsRole(RosterRole.Owner);

      const dto = await service.replaceBySlug(
        SLUG,
        OWNER_ID,
        makeDto({
          methods: [
            { kind: CommunityGivingKind.Link, value: `  ${VALID_LINK} ` },
            {
              kind: CommunityGivingKind.Mbway,
              value: '+351 912 345 678',
              label: 'Treasurer',
            },
            {
              kind: CommunityGivingKind.Iban,
              value: 'IBAN: pt50 0002 0123 1234 5678 9015 4',
              label: 'Main account',
              note: 'Associação Exemplo',
            },
          ],
        }),
      );

      expect(methodRepository.delete).toHaveBeenCalledWith({
        communityId: COMMUNITY_ID,
      });
      expect(methodRepository.save).toHaveBeenCalledWith([
        {
          communityId: COMMUNITY_ID,
          kind: CommunityGivingKind.Link,
          value: VALID_LINK,
          label: null,
          note: null,
          position: 0,
        },
        {
          communityId: COMMUNITY_ID,
          kind: CommunityGivingKind.Mbway,
          value: '912345678',
          label: 'Treasurer',
          note: null,
          position: 1,
        },
        {
          communityId: COMMUNITY_ID,
          kind: CommunityGivingKind.Iban,
          value: VALID_IBAN_CANONICAL,
          label: 'Main account',
          note: 'Associação Exemplo',
          position: 2,
        },
      ]);
      const deleteOrder = methodRepository.delete.mock.invocationCallOrder[0];
      const saveOrder = methodRepository.save.mock.invocationCallOrder[0];
      expect(deleteOrder).toBeLessThan(saveOrder ?? 0);
      expect(dto.methods.map((method) => method.position)).toEqual([0, 1, 2]);
      expect(dto.updatedAt).toBe(SAVED_AT.toISOString());
    });

    it('replaceBySlug writes one governance entry through the transaction manager', async () => {
      callerHoldsRole(RosterRole.Owner);

      await service.replaceBySlug(
        SLUG,
        OWNER_ID,
        makeDto({
          methods: [
            { kind: CommunityGivingKind.Link, value: VALID_LINK },
            {
              kind: CommunityGivingKind.Mbway,
              value: '912 345 678',
              label: 'Treasurer',
            },
          ],
        }),
      );

      expect(governanceLog.log).toHaveBeenCalledTimes(1);
      expect(governanceLog.log).toHaveBeenCalledWith(
        {
          communityId: COMMUNITY_ID,
          actorUserId: OWNER_ID,
          action: GovernanceLogAction.SettingsChanged,
          metadata: {
            changes: {
              givingMethods: {
                from: [],
                to: [`Link: ${VALID_LINK}`, 'MB WAY "Treasurer": 912345678'],
              },
            },
          },
        },
        manager,
      );
    });

    it('replaceBySlug writes nothing for an unchanged set', async () => {
      callerHoldsRole(RosterRole.Owner);
      communityRepository.findOne.mockResolvedValue(
        makeCommunity({ givingIntro: 'Rent and snacks' }),
      );
      methodRepository.find.mockResolvedValue([
        makeRow({ id: 'row-a', position: 0, updatedAt: EARLIER }),
      ]);

      const dto = await service.replaceBySlug(
        SLUG,
        OWNER_ID,
        makeDto({
          intro: 'Rent and snacks',
          methods: [{ kind: CommunityGivingKind.Link, value: VALID_LINK }],
        }),
      );

      expect(communityRepository.update).not.toHaveBeenCalled();
      expect(manager.query).not.toHaveBeenCalled();
      expect(methodRepository.delete).not.toHaveBeenCalled();
      expect(methodRepository.save).not.toHaveBeenCalled();
      expect(governanceLog.log).not.toHaveBeenCalled();
      expect(dto).toEqual({
        intro: 'Rent and snacks',
        methods: [
          {
            id: 'row-a',
            kind: 'link',
            label: null,
            value: VALID_LINK,
            note: null,
            position: 0,
          },
        ],
        updatedAt: EARLIER.toISOString(),
      });
    });

    it('replaceBySlug rewrites rows when only the intro changed', async () => {
      callerHoldsRole(RosterRole.Owner);
      communityRepository.findOne.mockResolvedValue(
        makeCommunity({ givingIntro: 'Old intro' }),
      );
      methodRepository.find.mockResolvedValue([
        makeRow({ id: 'row-a', position: 0, updatedAt: EARLIER }),
      ]);

      const dto = await service.replaceBySlug(
        SLUG,
        OWNER_ID,
        makeDto({
          intro: 'New intro',
          methods: [{ kind: CommunityGivingKind.Link, value: VALID_LINK }],
        }),
      );

      // `givingIntro` is `update: false`, so the write is a raw UPDATE.
      expect(communityRepository.update).not.toHaveBeenCalled();
      expect(manager.query).toHaveBeenCalledTimes(1);
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining('SET "giving_intro" = $1'),
        ['New intro', COMMUNITY_ID],
      );
      expect(methodRepository.delete).toHaveBeenCalledTimes(1);
      expect(methodRepository.save).toHaveBeenCalledTimes(1);
      expect(dto.updatedAt).toBe(SAVED_AT.toISOString());
      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: {
            changes: { givingIntro: { from: 'Old intro', to: 'New intro' } },
          },
        }),
        manager,
      );
    });
  });
});
