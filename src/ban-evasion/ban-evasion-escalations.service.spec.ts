import { ConflictException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Community } from '../communities/entities/community.entity';
import { Profile } from '../users/entities/profile.entity';
import { BanEvasionEscalationsService } from './ban-evasion-escalations.service';
import { BAN_EVASION_ESCALATION_RESOLVED } from './ban-evasion.events';
import { BanEvasionService } from './ban-evasion.service';
import {
  BanEvasionEscalation,
  BanEvasionEscalationStatus,
} from './entities/ban-evasion-escalation.entity';

const COMMUNITY_ID = 'community-1';
const APPLICANT_ID = 'applicant-1';
const MODERATOR_ID = 'moderator-1';
const STAFF_ID = 'staff-1';

function openEscalation(
  overrides: Partial<BanEvasionEscalation> = {},
): BanEvasionEscalation {
  return {
    id: 'escalation-1',
    communityId: COMMUNITY_ID,
    joinRequestId: 'join-request-1',
    subjectUserId: APPLICANT_ID,
    raisedByUserId: MODERATOR_ID,
    note: 'Third account this month',
    status: BanEvasionEscalationStatus.Open,
    resolvedByUserId: null,
    resolvedAt: null,
    resolutionNote: null,
    createdAt: new Date('2026-08-31T10:00:00.000Z'),
    ...overrides,
  };
}

describe('BanEvasionEscalationsService', () => {
  let service: BanEvasionEscalationsService;
  let escalations: { find: jest.Mock; findOne: jest.Mock; save: jest.Mock };
  let communities: { find: jest.Mock };
  let profiles: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let banEvasion: { assessUsers: jest.Mock };
  let eventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    escalations = {
      find: jest.fn().mockResolvedValue([openEscalation()]),
      findOne: jest.fn().mockResolvedValue(openEscalation()),
      save: jest.fn().mockImplementation((row) => Promise.resolve(row)),
    };
    communities = {
      find: jest
        .fn()
        .mockResolvedValue([
          { id: COMMUNITY_ID, slug: 'lisbon-choir', name: 'Lisbon Choir' },
        ]),
    };
    profiles = {
      find: jest.fn().mockResolvedValue([
        {
          userId: APPLICANT_ID,
          slug: 'ana-silva',
          firstName: 'Ana',
          lastName: 'Silva',
          pronouns: 'she/her',
          avatarUrl: null,
          photoVisible: true,
        },
        {
          userId: MODERATOR_ID,
          slug: 'joana-reis',
          firstName: 'Joana',
          lastName: 'Reis',
          pronouns: null,
          avatarUrl: null,
          photoVisible: true,
        },
      ]),
      createQueryBuilder: jest.fn(),
    };
    banEvasion = {
      assessUsers: jest.fn().mockResolvedValue([
        {
          subjectId: APPLICANT_ID,
          tier: 'high',
          score: 70,
          signals: [
            {
              kind: 'sign_in_identifier_match',
              removalKind: 'community_ban',
              removedAt: '2026-06-01T00:00:00.000Z',
              removedAccountName: 'Removed Account',
              removedAccountSlug: 'removed-account',
              communityName: 'Porto Book Club',
            },
          ],
        },
      ]),
    };

    eventEmitter = { emit: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        BanEvasionEscalationsService,
        {
          provide: getRepositoryToken(BanEvasionEscalation),
          useValue: escalations,
        },
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: BanEvasionService, useValue: banEvasion },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = moduleRef.get(BanEvasionEscalationsService);
  });

  describe('list', () => {
    it('defaults to the open queue, newest first', async () => {
      await service.list();

      expect(escalations.find).toHaveBeenCalledWith({
        where: { status: BanEvasionEscalationStatus.Open },
        order: { createdAt: 'DESC' },
      });
    });

    it('reads the history when asked for resolved ones', async () => {
      await service.list(BanEvasionEscalationStatus.Resolved);

      expect(escalations.find).toHaveBeenCalledWith({
        where: { status: BanEvasionEscalationStatus.Resolved },
        order: { createdAt: 'DESC' },
      });
    });

    it('attaches the full cross-community assessment inline', async () => {
      const [escalation] = await service.list();

      expect(escalation?.communitySlug).toBe('lisbon-choir');
      expect(escalation?.subject?.slug).toBe('ana-silva');
      expect(escalation?.raisedBy?.slug).toBe('joana-reis');
      // The width IS the point of escalating: the moderator saw one bit, staff
      // see the tier, the score and every matched signal, including the ones
      // from a community they have nothing to do with.
      expect(escalation?.assessment?.tier).toBe('high');
      expect(escalation?.assessment?.score).toBe(70);
      expect(escalation?.assessment?.signals[0]?.communityName).toBe(
        'Porto Book Club',
      );
    });

    it('assesses every applicant on the page in one batched call', async () => {
      escalations.find.mockResolvedValue([
        openEscalation({ id: 'escalation-1', subjectUserId: APPLICANT_ID }),
        openEscalation({ id: 'escalation-2', subjectUserId: 'applicant-2' }),
        openEscalation({ id: 'escalation-3', subjectUserId: APPLICANT_ID }),
      ]);

      await service.list();

      expect(banEvasion.assessUsers).toHaveBeenCalledTimes(1);
      expect(banEvasion.assessUsers).toHaveBeenCalledWith([
        APPLICANT_ID,
        'applicant-2',
      ]);
    });

    it('carries a null assessment once the applicant account is erased', async () => {
      escalations.find.mockResolvedValue([
        openEscalation({ subjectUserId: null }),
      ]);
      banEvasion.assessUsers.mockResolvedValue([]);

      const [escalation] = await service.list();

      expect(escalation?.subject).toBeNull();
      expect(escalation?.assessment).toBeNull();
    });
  });

  describe('resolve', () => {
    it('404s for an escalation that does not exist', async () => {
      escalations.findOne.mockResolvedValue(null);

      await expect(
        service.resolve('missing', STAFF_ID, undefined),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('stamps who closed it, when, and what they found', async () => {
      const resolved = await service.resolve(
        'escalation-1',
        STAFF_ID,
        '  <b>Same person, declined</b>  ',
      );

      expect(escalations.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: BanEvasionEscalationStatus.Resolved,
          resolvedByUserId: STAFF_ID,
          resolutionNote: 'Same person, declined',
        }),
      );
      expect(resolved.status).toBe(BanEvasionEscalationStatus.Resolved);
      expect(resolved.resolvedAt).not.toBeNull();
      expect(resolved.resolutionNote).toBe('Same person, declined');
    });

    it('refuses to resolve one that is already resolved', async () => {
      escalations.findOne.mockResolvedValue(
        openEscalation({
          status: BanEvasionEscalationStatus.Resolved,
          resolvedAt: new Date('2026-08-31T12:00:00.000Z'),
          resolvedByUserId: 'staff-2',
          resolutionNote: 'Looked, cleared',
        }),
      );

      await expect(
        service.resolve('escalation-1', STAFF_ID, 'a second opinion'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(escalations.save).not.toHaveBeenCalled();
      // Nothing transitioned, so there is nothing to tell anybody about.
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('tells the moderator who raised it, and nobody else', async () => {
      await service.resolve('escalation-1', STAFF_ID, 'Same person, declined');

      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        BAN_EVASION_ESCALATION_RESOLVED,
        {
          escalationId: 'escalation-1',
          communityId: COMMUNITY_ID,
          joinRequestId: 'join-request-1',
          raisedByUserId: MODERATOR_ID,
        },
      );
    });

    /**
     * The one test this whole file exists for. The recipient is the community
     * moderator who raised the case, and that moderator is exactly the person
     * the one-bit design of `CommunityBanEvasionFlagDTO` withholds a
     * cross-community judgement from. They learn that somebody looked and the
     * case is closed.
     */
    it('carries nothing about what staff found', async () => {
      await service.resolve('escalation-1', STAFF_ID, 'Same person, declined');

      const [, payload] = eventEmitter.emit.mock.calls[0] as [string, unknown];
      const serialized = JSON.stringify(payload);
      for (const forbidden of [
        'Same person, declined',
        'resolutionNote',
        'resolvedBy',
        'resolvedAt',
        STAFF_ID,
        APPLICANT_ID,
        'assessment',
        'tier',
        'score',
        'signals',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it('carries a null raiser once that account has been erased', async () => {
      escalations.findOne.mockResolvedValue(
        openEscalation({ raisedByUserId: null }),
      );

      await service.resolve('escalation-1', STAFF_ID, undefined);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        BAN_EVASION_ESCALATION_RESOLVED,
        expect.objectContaining({ raisedByUserId: null }),
      );
    });

    it('still resolves when a listener throws', async () => {
      eventEmitter.emit.mockImplementation(() => {
        throw new Error('the bell is on fire');
      });

      const resolved = await service.resolve(
        'escalation-1',
        STAFF_ID,
        'Same person, declined',
      );

      // The resolution committed before the emit. A notification failure may
      // never take a staff decision down with it.
      expect(resolved.status).toBe(BanEvasionEscalationStatus.Resolved);
      expect(escalations.save).toHaveBeenCalledTimes(1);
    });
  });
});
