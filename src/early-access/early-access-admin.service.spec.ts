import { NotFoundException } from '@nestjs/common';
import { In, Repository } from 'typeorm';
import * as launchedFeatures from '../launchedFeatures';
import { ModAuditService } from '../moderation/mod-audit.service';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import {
  EARLY_ACCESS_GRANT_COUNTS_SQL,
  EarlyAccessAdminService,
} from './early-access-admin.service';
import { EARLY_ACCESS_ROSTER_LIMIT } from './early-access.constants';
import { FeatureEarlyAccessGrant } from './entities/feature-early-access-grant.entity';

const STAFF_ID = '7c000000-0000-4000-8000-000000000001';
const MEMBER_ID = '7c000000-0000-4000-8000-000000000002';
const OTHER_MEMBER_ID = '7c000000-0000-4000-8000-000000000003';
const GRANTED_AT = new Date('2026-10-20T10:00:00.000Z');

const GRANT_KEYS = ['featureKey', 'grantedAt', 'grantedBy', 'userId'];
const ROSTER_ROW_KEYS = ['grantedAt', 'grantedBy', 'member'];
const ROSTER_MEMBER_KEYS = ['avatarUrl', 'displayName', 'slug', 'userId'];

describe('EarlyAccessAdminService', () => {
  let insertExecute: jest.Mock;
  let manager: { createQueryBuilder: jest.Mock; delete: jest.Mock };
  let grants: {
    find: jest.Mock;
    findOne: jest.Mock;
    findAndCount: jest.Mock;
    manager: { transaction: jest.Mock; query: jest.Mock };
  };
  let users: { exists: jest.Mock };
  let profiles: { find: jest.Mock };
  let modAudit: {
    writeAuditLog: jest.Mock;
    nameForUserId: jest.Mock;
    namesForUserIds: jest.Mock;
    resolveActorName: jest.Mock;
  };
  let service: EarlyAccessAdminService;

  const storedGrant = (
    overrides: Partial<FeatureEarlyAccessGrant> = {},
  ): FeatureEarlyAccessGrant => ({
    id: 'grant-1',
    userId: MEMBER_ID,
    featureKey: 'quizshow',
    grantedById: STAFF_ID,
    createdAt: GRANTED_AT,
    ...overrides,
  });

  beforeEach(() => {
    jest
      .spyOn(launchedFeatures, 'earlyAccessFeatureKeys')
      .mockReturnValue(['quizshow']);
    insertExecute = jest.fn().mockResolvedValue({ raw: [{ id: 'grant-1' }] });
    const insertBuilder = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: insertExecute,
    };
    manager = {
      createQueryBuilder: jest.fn().mockReturnValue(insertBuilder),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    grants = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(storedGrant()),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      manager: {
        transaction: jest.fn((work: (inner: typeof manager) => unknown) =>
          Promise.resolve(work(manager)),
        ),
        query: jest.fn().mockResolvedValue([]),
      },
    };
    users = { exists: jest.fn().mockResolvedValue(true) };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    modAudit = {
      writeAuditLog: jest.fn().mockResolvedValue('audit-1'),
      nameForUserId: jest.fn().mockResolvedValue('Rita Lobo'),
      namesForUserIds: jest
        .fn()
        .mockResolvedValue(new Map([[STAFF_ID, 'Rita Lobo']])),
      resolveActorName: jest.fn(
        (actorId: string | null, actorNames: Map<string, string>) =>
          actorId ? (actorNames.get(actorId) ?? 'Member') : 'Deleted member',
      ),
    };
    service = new EarlyAccessAdminService(
      grants as unknown as Repository<FeatureEarlyAccessGrant>,
      users as unknown as Repository<User>,
      profiles as unknown as Repository<Profile>,
      modAudit as unknown as ModAuditService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('feature keys', () => {
    it('accepts a feature in early access', () => {
      expect(service.assertFeatureInEarlyAccess('quizshow')).toBe('quizshow');
    });

    it.each([
      ['an unknown key', 'not-a-feature'],
      ['a launched key', 'events'],
      ['an unlaunched key without early access', 'cinema'],
    ])('answers 404 for %s', (_label, featureKey) => {
      expect(() => service.assertFeatureInEarlyAccess(featureKey)).toThrow(
        new NotFoundException('Early access feature not found.'),
      );
    });

    it('answers 404 for a flagged key once it launches', () => {
      jest.spyOn(launchedFeatures, 'isInEarlyAccess').mockReturnValue(false);
      expect(() => service.assertFeatureInEarlyAccess('quizshow')).toThrow(
        NotFoundException,
      );
    });

    it('rejects a bad key on grant, revoke and roster before any write', async () => {
      await expect(
        service.grant(STAFF_ID, MEMBER_ID, 'events'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.revoke(STAFF_ID, MEMBER_ID, 'cinema'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.roster('not-a-feature')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(grants.manager.transaction).not.toHaveBeenCalled();
      expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
    });
  });

  it('answers 404 for a missing member on every member route', async () => {
    users.exists.mockResolvedValue(false);
    await expect(service.listForMember(MEMBER_ID)).rejects.toThrow(
      new NotFoundException('Member not found'),
    );
    await expect(
      service.grant(STAFF_ID, MEMBER_ID, 'quizshow'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.revoke(STAFF_ID, MEMBER_ID, 'quizshow'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(grants.manager.transaction).not.toHaveBeenCalled();
  });

  describe('listForMember', () => {
    it('lists every feature in early access in registry order, grant or null', async () => {
      jest
        .spyOn(launchedFeatures, 'earlyAccessFeatureKeys')
        .mockReturnValue(['studio', 'quizshow']);
      grants.find.mockResolvedValue([storedGrant()]);
      const response = await service.listForMember(MEMBER_ID);
      expect(grants.find).toHaveBeenCalledWith({
        where: { userId: MEMBER_ID, featureKey: In(['studio', 'quizshow']) },
      });
      expect(response).toEqual({
        features: [
          { featureKey: 'studio', grant: null },
          {
            featureKey: 'quizshow',
            grant: {
              featureKey: 'quizshow',
              userId: MEMBER_ID,
              grantedAt: GRANTED_AT.toISOString(),
              grantedBy: { id: STAFF_ID, displayName: 'Rita Lobo' },
            },
          },
        ],
      });
      expect(Object.keys(response.features[1]!.grant!).sort()).toEqual(
        GRANT_KEYS,
      );
    });

    it('answers a null granter once that account is erased', async () => {
      grants.find.mockResolvedValue([storedGrant({ grantedById: null })]);
      const response = await service.listForMember(MEMBER_ID);
      expect(response.features[0]!.grant!.grantedBy).toBeNull();
      expect(modAudit.namesForUserIds).toHaveBeenCalledWith([]);
    });
  });

  describe('grant', () => {
    it('grants and audits in one transaction, naming the member and the feature', async () => {
      const response = await service.grant(STAFF_ID, MEMBER_ID, 'quizshow');
      expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
        null,
        STAFF_ID,
        'early_access_granted',
        undefined,
        'quizshow',
        undefined,
        manager,
        MEMBER_ID,
      );
      expect(grants.findOne).toHaveBeenCalledWith({
        where: { userId: MEMBER_ID, featureKey: 'quizshow' },
      });
      expect(response).toEqual({
        featureKey: 'quizshow',
        userId: MEMBER_ID,
        grantedAt: GRANTED_AT.toISOString(),
        grantedBy: { id: STAFF_ID, displayName: 'Rita Lobo' },
      });
      expect(Object.keys(response).sort()).toEqual(GRANT_KEYS);
    });

    it('audits a double grant once', async () => {
      await service.grant(STAFF_ID, MEMBER_ID, 'quizshow');
      insertExecute.mockResolvedValue({ raw: [] });
      const response = await service.grant(STAFF_ID, MEMBER_ID, 'quizshow');
      expect(response.userId).toBe(MEMBER_ID);
      expect(modAudit.writeAuditLog).toHaveBeenCalledTimes(1);
    });
  });

  describe('revoke', () => {
    it('revokes the one feature and audits the removed row', async () => {
      await service.revoke(STAFF_ID, MEMBER_ID, 'quizshow');
      expect(manager.delete).toHaveBeenCalledWith(FeatureEarlyAccessGrant, {
        userId: MEMBER_ID,
        featureKey: 'quizshow',
      });
      expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
        null,
        STAFF_ID,
        'early_access_revoked',
        undefined,
        'quizshow',
        undefined,
        manager,
        MEMBER_ID,
      );
    });

    it('writes no audit when the member held no grant', async () => {
      manager.delete.mockResolvedValue({ affected: 0 });
      await service.revoke(STAFF_ID, MEMBER_ID, 'quizshow');
      expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
    });
  });

  describe('listFeatures', () => {
    it('counts grants in one query and lists features with none', async () => {
      jest
        .spyOn(launchedFeatures, 'earlyAccessFeatureKeys')
        .mockReturnValue(['studio', 'quizshow']);
      grants.manager.query.mockResolvedValue([
        { feature_key: 'quizshow', grant_count: 3 },
      ]);
      expect(await service.listFeatures()).toEqual({
        features: [
          { featureKey: 'studio', grantCount: 0 },
          { featureKey: 'quizshow', grantCount: 3 },
        ],
      });
      expect(grants.manager.query).toHaveBeenCalledTimes(1);
      expect(grants.manager.query).toHaveBeenCalledWith(
        EARLY_ACCESS_GRANT_COUNTS_SQL,
        [['studio', 'quizshow']],
      );
    });

    it('runs no query while no feature is in early access', async () => {
      jest
        .spyOn(launchedFeatures, 'earlyAccessFeatureKeys')
        .mockReturnValue([]);
      expect(await service.listFeatures()).toEqual({ features: [] });
      expect(grants.manager.query).not.toHaveBeenCalled();
    });
  });

  describe('roster', () => {
    it('reads newest first, capped, with the total', async () => {
      grants.findAndCount.mockResolvedValue([[storedGrant()], 250]);
      const response = await service.roster('quizshow');
      expect(grants.findAndCount).toHaveBeenCalledWith({
        where: { featureKey: 'quizshow' },
        order: { createdAt: 'DESC', id: 'DESC' },
        take: EARLY_ACCESS_ROSTER_LIMIT,
      });
      expect(response.featureKey).toBe('quizshow');
      expect(response.total).toBe(250);
      expect(response.limit).toBe(200);
      expect(Object.keys(response).sort()).toEqual([
        'featureKey',
        'items',
        'limit',
        'total',
      ]);
    });

    it('names each member from their profile, gates the photo, and falls back without a profile', async () => {
      grants.findAndCount.mockResolvedValue([
        [
          storedGrant(),
          storedGrant({
            id: 'grant-2',
            userId: OTHER_MEMBER_ID,
            grantedById: null,
          }),
        ],
        2,
      ]);
      profiles.find.mockResolvedValue([
        {
          userId: MEMBER_ID,
          slug: 'sam-reis',
          firstName: 'Sam',
          lastName: 'Reis',
          avatarUrl: 'avatars/sam.webp',
          photoVisible: false,
        },
      ]);
      const response = await service.roster('quizshow');
      expect(profiles.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: In([MEMBER_ID, OTHER_MEMBER_ID]) },
        }),
      );
      expect(modAudit.namesForUserIds).toHaveBeenCalledTimes(1);
      expect(modAudit.namesForUserIds).toHaveBeenCalledWith([STAFF_ID]);
      expect(response.items).toEqual([
        {
          member: {
            userId: MEMBER_ID,
            slug: 'sam-reis',
            displayName: 'Sam Reis',
            avatarUrl: null,
          },
          grantedAt: GRANTED_AT.toISOString(),
          grantedBy: { id: STAFF_ID, displayName: 'Rita Lobo' },
        },
        {
          member: {
            userId: OTHER_MEMBER_ID,
            slug: null,
            displayName: 'Member',
            avatarUrl: null,
          },
          grantedAt: GRANTED_AT.toISOString(),
          grantedBy: null,
        },
      ]);
      for (const rosterRow of response.items) {
        expect(Object.keys(rosterRow).sort()).toEqual(ROSTER_ROW_KEYS);
        expect(Object.keys(rosterRow.member).sort()).toEqual(
          ROSTER_MEMBER_KEYS,
        );
      }
    });

    it('skips the profile read for an empty roster', async () => {
      const response = await service.roster('quizshow');
      expect(profiles.find).not.toHaveBeenCalled();
      expect(response).toEqual({
        featureKey: 'quizshow',
        total: 0,
        limit: EARLY_ACCESS_ROSTER_LIMIT,
        items: [],
      });
    });
  });
});
