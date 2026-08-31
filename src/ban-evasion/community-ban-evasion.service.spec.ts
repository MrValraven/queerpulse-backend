import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { POSTGRES_UNIQUE_VIOLATION } from '../common/db-errors';
import { CommunityJoinRequest } from '../communities/entities/community-join-request.entity';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { BAN_EVASION_ESCALATION_RAISED } from './ban-evasion.events';
import { BanEvasionService } from './ban-evasion.service';
import { CommunityBanEvasionService } from './community-ban-evasion.service';
import {
  BanEvasionEscalation,
  BanEvasionEscalationStatus,
} from './entities/ban-evasion-escalation.entity';
import {
  RemovalKind,
  RemovedAccountSignal,
} from './entities/removed-account-signal.entity';

const COMMUNITY_ID = 'community-1';
const OTHER_COMMUNITY_ID = 'community-2';
const APPLICANT_ID = 'applicant-1';
const JOIN_REQUEST_ID = 'join-request-1';
const MODERATOR_ID = 'moderator-1';

/** The peppered digest of the applicant's sign-in address. */
const APPLICANT_EMAIL_HASH = 'applicant-email-hash';

function signalRow(
  overrides: Partial<RemovedAccountSignal>,
): RemovedAccountSignal {
  return {
    id: `signal-${Math.random()}`,
    removedUserId: 'banned-account-1',
    removalKind: RemovalKind.CommunityBan,
    communityId: COMMUNITY_ID,
    removedAt: new Date('2026-06-01T00:00:00.000Z'),
    signInEmailHash: null,
    oauthSubjectHash: null,
    intakeEmailHash: null,
    statedNameHash: null,
    inviterUserId: null,
    referenceUserId: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('CommunityBanEvasionService', () => {
  let service: CommunityBanEvasionService;
  let communities: { findOne: jest.Mock };
  let members: { findOne: jest.Mock };
  let joinRequests: { find: jest.Mock; findOne: jest.Mock };
  let signals: { find: jest.Mock };
  let escalations: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let banEvasion: { correlationMaterialForUsers: jest.Mock };
  let eventEmitter: { emit: jest.Mock };

  /**
   * Every signal row in the store, across communities and both removal kinds.
   * `signals.find` filters these by the `where` clause it is actually given, so
   * a test that expects `false` for another community's ban is proving that the
   * narrowing happens in the QUERY rather than in a mapper afterwards.
   */
  let signalStore: RemovedAccountSignal[];

  beforeEach(async () => {
    signalStore = [];

    communities = {
      findOne: jest.fn().mockResolvedValue({
        id: COMMUNITY_ID,
        slug: 'lisbon-choir',
        name: 'Lisbon Choir',
        archivedAt: null,
      }),
    };
    members = {
      findOne: jest.fn().mockResolvedValue({
        communityId: COMMUNITY_ID,
        userId: MODERATOR_ID,
        role: RosterRole.Mod,
      }),
    };
    joinRequests = {
      find: jest
        .fn()
        .mockResolvedValue([{ id: JOIN_REQUEST_ID, userId: APPLICANT_ID }]),
      findOne: jest.fn().mockResolvedValue({
        id: JOIN_REQUEST_ID,
        communityId: COMMUNITY_ID,
        userId: APPLICANT_ID,
      }),
    };
    signals = {
      find: jest
        .fn()
        .mockImplementation(
          (options: {
            where: { communityId: string; removalKind: RemovalKind };
          }) =>
            Promise.resolve(
              signalStore.filter(
                (row) =>
                  row.communityId === options.where.communityId &&
                  row.removalKind === options.where.removalKind,
              ),
            ),
        ),
    };
    escalations = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((draft: Partial<BanEvasionEscalation>) => draft),
      save: jest
        .fn()
        .mockImplementation((draft: Partial<BanEvasionEscalation>) =>
          Promise.resolve({
            id: 'escalation-1',
            createdAt: new Date('2026-08-31T10:00:00.000Z'),
            ...draft,
          }),
        ),
    };
    banEvasion = {
      correlationMaterialForUsers: jest.fn().mockResolvedValue([
        {
          subjectId: APPLICANT_ID,
          ownRemovedUserId: APPLICANT_ID,
          emailHash: APPLICANT_EMAIL_HASH,
          oauthSubjectHash: null,
          statedNameHash: 'applicant-name-hash',
          inviterUserId: null,
          referenceUserId: null,
        },
      ]),
    };

    eventEmitter = { emit: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityBanEvasionService,
        {
          provide: getRepositoryToken(RemovedAccountSignal),
          useValue: signals,
        },
        {
          provide: getRepositoryToken(BanEvasionEscalation),
          useValue: escalations,
        },
        {
          provide: getRepositoryToken(CommunityJoinRequest),
          useValue: joinRequests,
        },
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(CommunityMember), useValue: members },
        { provide: BanEvasionService, useValue: banEvasion },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = moduleRef.get(CommunityBanEvasionService);
  });

  describe('flagJoinRequests', () => {
    it('refuses a plain roster member', async () => {
      members.findOne.mockResolvedValue({
        communityId: COMMUNITY_ID,
        userId: 'member-1',
        role: RosterRole.Member,
      });

      await expect(
        service.flagJoinRequests('lisbon-choir', 'member-1', [JOIN_REQUEST_ID]),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(signals.find).not.toHaveBeenCalled();
    });

    it('refuses somebody who is not on the roster at all', async () => {
      members.findOne.mockResolvedValue(null);

      await expect(
        service.flagJoinRequests('lisbon-choir', 'stranger-1', [
          JOIN_REQUEST_ID,
        ]),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('flags an applicant who matches somebody THIS community banned', async () => {
      signalStore = [
        signalRow({
          communityId: COMMUNITY_ID,
          removalKind: RemovalKind.CommunityBan,
          signInEmailHash: APPLICANT_EMAIL_HASH,
        }),
      ];

      const flags = await service.flagJoinRequests(
        'lisbon-choir',
        MODERATOR_ID,
        [JOIN_REQUEST_ID],
      );

      expect(flags).toEqual([
        { joinRequestId: JOIN_REQUEST_ID, isMatchingBannedMember: true },
      ]);
    });

    it('stays quiet when the only match is a ban from another community', async () => {
      signalStore = [
        signalRow({
          communityId: OTHER_COMMUNITY_ID,
          removalKind: RemovalKind.CommunityBan,
          signInEmailHash: APPLICANT_EMAIL_HASH,
        }),
      ];

      const flags = await service.flagJoinRequests(
        'lisbon-choir',
        MODERATOR_ID,
        [JOIN_REQUEST_ID],
      );

      expect(flags).toEqual([
        { joinRequestId: JOIN_REQUEST_ID, isMatchingBannedMember: false },
      ]);
      // The narrowing is in the WHERE clause, so the other community's row was
      // never loaded in the first place.
      expect(signals.find).toHaveBeenCalledWith({
        where: {
          communityId: COMMUNITY_ID,
          removalKind: RemovalKind.CommunityBan,
        },
      });
    });

    it('stays quiet when the only match is a platform-level ban', async () => {
      signalStore = [
        signalRow({
          communityId: null,
          removalKind: RemovalKind.PlatformBan,
          signInEmailHash: APPLICANT_EMAIL_HASH,
        }),
      ];

      const flags = await service.flagJoinRequests(
        'lisbon-choir',
        MODERATOR_ID,
        [JOIN_REQUEST_ID],
      );

      expect(flags).toEqual([
        { joinRequestId: JOIN_REQUEST_ID, isMatchingBannedMember: false },
      ]);
    });

    it('stays quiet on a shared name alone, which never reaches a review-worthy tier', async () => {
      signalStore = [
        signalRow({
          communityId: COMMUNITY_ID,
          removalKind: RemovalKind.CommunityBan,
          statedNameHash: 'applicant-name-hash',
        }),
      ];

      const flags = await service.flagJoinRequests(
        'lisbon-choir',
        MODERATOR_ID,
        [JOIN_REQUEST_ID],
      );

      expect(flags[0]?.isMatchingBannedMember).toBe(false);
    });

    it('does not treat a ban row about the applicant themselves as evidence', async () => {
      signalStore = [
        signalRow({
          removedUserId: APPLICANT_ID,
          communityId: COMMUNITY_ID,
          removalKind: RemovalKind.CommunityBan,
          signInEmailHash: APPLICANT_EMAIL_HASH,
        }),
      ];

      const flags = await service.flagJoinRequests(
        'lisbon-choir',
        MODERATOR_ID,
        [JOIN_REQUEST_ID],
      );

      expect(flags[0]?.isMatchingBannedMember).toBe(false);
    });

    it('returns the join-request id and the bit, and nothing else at all', async () => {
      signalStore = [
        signalRow({
          communityId: COMMUNITY_ID,
          removalKind: RemovalKind.CommunityBan,
          signInEmailHash: APPLICANT_EMAIL_HASH,
        }),
      ];

      const [flag] = await service.flagJoinRequests(
        'lisbon-choir',
        MODERATOR_ID,
        [JOIN_REQUEST_ID],
      );

      // No hash, no score, no tier, no signal kind, no removed account, no
      // date. Widening this is a product decision to re-take, so the assertion
      // is on the WHOLE key set rather than on a few absent fields.
      expect(Object.keys(flag ?? {}).sort()).toEqual([
        'isMatchingBannedMember',
        'joinRequestId',
      ]);
      const serialized = JSON.stringify(flag);
      for (const forbidden of [
        APPLICANT_EMAIL_HASH,
        'banned-account-1',
        'tier',
        'score',
        'signal',
        '2026-06-01',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it('asks only about join requests belonging to this community', async () => {
      await service.flagJoinRequests('lisbon-choir', MODERATOR_ID, [
        JOIN_REQUEST_ID,
      ]);

      const findCalls = joinRequests.find.mock.calls as {
        where: { communityId: string };
      }[][];
      expect(findCalls[0]?.[0]?.where.communityId).toBe(COMMUNITY_ID);
    });
  });

  describe('escalate', () => {
    it('refuses a plain roster member', async () => {
      members.findOne.mockResolvedValue({
        communityId: COMMUNITY_ID,
        userId: 'member-1',
        role: RosterRole.Member,
      });

      await expect(
        service.escalate(
          'lisbon-choir',
          'member-1',
          JOIN_REQUEST_ID,
          'please look',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s for a join request belonging to another community', async () => {
      joinRequests.findOne.mockResolvedValue(null);

      await expect(
        service.escalate(
          'lisbon-choir',
          MODERATOR_ID,
          JOIN_REQUEST_ID,
          undefined,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('opens an escalation carrying no part of the assessment', async () => {
      const escalation = await service.escalate(
        'lisbon-choir',
        MODERATOR_ID,
        JOIN_REQUEST_ID,
        '  <b>Third account this month</b>  ',
      );

      expect(escalation).toEqual({
        id: 'escalation-1',
        joinRequestId: JOIN_REQUEST_ID,
        status: BanEvasionEscalationStatus.Open,
        createdAt: '2026-08-31T10:00:00.000Z',
        note: 'Third account this month',
      });
      // The applicant is denormalized onto the row for the staff console.
      expect(escalations.save).toHaveBeenCalledWith(
        expect.objectContaining({
          communityId: COMMUNITY_ID,
          joinRequestId: JOIN_REQUEST_ID,
          subjectUserId: APPLICANT_ID,
          raisedByUserId: MODERATOR_ID,
        }),
      );
    });

    it('returns the open escalation again instead of opening a second one', async () => {
      escalations.findOne.mockResolvedValue({
        id: 'escalation-1',
        joinRequestId: JOIN_REQUEST_ID,
        status: BanEvasionEscalationStatus.Open,
        createdAt: new Date('2026-08-31T10:00:00.000Z'),
        note: 'please look',
      });

      const escalation = await service.escalate(
        'lisbon-choir',
        'moderator-2',
        JOIN_REQUEST_ID,
        'a different note',
      );

      expect(escalation.id).toBe('escalation-1');
      expect(escalation.note).toBe('please look');
      expect(escalations.save).not.toHaveBeenCalled();
    });

    it('converges on the winner when it loses the insert race', async () => {
      const winner = {
        id: 'escalation-winner',
        joinRequestId: JOIN_REQUEST_ID,
        status: BanEvasionEscalationStatus.Open,
        createdAt: new Date('2026-08-31T10:00:00.000Z'),
        note: null,
      };
      // The `findOne` fast-path misses, then the partial unique index rejects
      // the duplicate, then the re-read finds the row that won.
      escalations.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winner);
      escalations.save.mockRejectedValueOnce({
        code: POSTGRES_UNIQUE_VIOLATION,
        constraint: 'UQ_ban_evasion_escalations_open',
      });

      const escalation = await service.escalate(
        'lisbon-choir',
        MODERATOR_ID,
        JOIN_REQUEST_ID,
        undefined,
      );

      expect(escalation.id).toBe('escalation-winner');
    });

    it('rethrows a unique violation on any other index', async () => {
      escalations.save.mockRejectedValueOnce({
        code: POSTGRES_UNIQUE_VIOLATION,
        constraint: 'UQ_something_else',
      });

      await expect(
        service.escalate(
          'lisbon-choir',
          MODERATOR_ID,
          JOIN_REQUEST_ID,
          undefined,
        ),
      ).rejects.toMatchObject({ constraint: 'UQ_something_else' });
    });

    it('tells staff exactly once, on the insert', async () => {
      await service.escalate(
        'lisbon-choir',
        MODERATOR_ID,
        JOIN_REQUEST_ID,
        'Third account this month',
      );

      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        BAN_EVASION_ESCALATION_RAISED,
        {
          escalationId: 'escalation-1',
          communityId: COMMUNITY_ID,
          joinRequestId: JOIN_REQUEST_ID,
          raisedByUserId: MODERATOR_ID,
        },
      );
    });

    it('does not ping staff a second time for an idempotent repeat', async () => {
      escalations.findOne.mockResolvedValue({
        id: 'escalation-1',
        joinRequestId: JOIN_REQUEST_ID,
        status: BanEvasionEscalationStatus.Open,
        createdAt: new Date('2026-08-31T10:00:00.000Z'),
        note: 'please look',
      });

      const escalation = await service.escalate(
        'lisbon-choir',
        'moderator-2',
        JOIN_REQUEST_ID,
        'a different note',
      );

      // The existing row comes back, so the case is already in front of staff.
      // A second bell would say a second question had been asked.
      expect(escalation.id).toBe('escalation-1');
      expect(escalations.save).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('does not ping staff when it loses the insert race', async () => {
      const winner = {
        id: 'escalation-winner',
        joinRequestId: JOIN_REQUEST_ID,
        status: BanEvasionEscalationStatus.Open,
        createdAt: new Date('2026-08-31T10:00:00.000Z'),
        note: null,
      };
      escalations.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winner);
      escalations.save.mockRejectedValueOnce({
        code: POSTGRES_UNIQUE_VIOLATION,
        constraint: 'UQ_ban_evasion_escalations_open',
      });

      await service.escalate(
        'lisbon-choir',
        MODERATOR_ID,
        JOIN_REQUEST_ID,
        undefined,
      );

      // The winner's own insert already emitted. Two moderators pressing at
      // once put one case in front of staff and ping them once.
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('carries no part of the assessment to staff, and never the applicant', async () => {
      await service.escalate(
        'lisbon-choir',
        MODERATOR_ID,
        JOIN_REQUEST_ID,
        'Third account this month',
      );

      const [, payload] = eventEmitter.emit.mock.calls[0] as [string, unknown];
      const serialized = JSON.stringify(payload);
      for (const forbidden of [
        APPLICANT_ID,
        'Third account this month',
        'assessment',
        'tier',
        'score',
        'signals',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it('still returns the escalation when a listener throws', async () => {
      eventEmitter.emit.mockImplementation(() => {
        throw new Error('the bell is on fire');
      });

      const escalation = await service.escalate(
        'lisbon-choir',
        MODERATOR_ID,
        JOIN_REQUEST_ID,
        undefined,
      );

      // The escalation committed before the emit. A notification failure may
      // never cost a moderator the only route they have to ask.
      expect(escalation.id).toBe('escalation-1');
      expect(escalations.save).toHaveBeenCalledTimes(1);
    });
  });
  describe('listEscalations', () => {
    /**
     * Every escalation row in the store, across communities. `escalations.find`
     * filters these by the `where` clause it is actually given, so a test that
     * expects another community's rows to be absent is proving the scoping
     * happens in the QUERY.
     */
    const escalationStore = [
      {
        id: 'escalation-ours-open',
        communityId: COMMUNITY_ID,
        joinRequestId: JOIN_REQUEST_ID,
        subjectUserId: APPLICANT_ID,
        raisedByUserId: MODERATOR_ID,
        note: 'Third account this month',
        status: BanEvasionEscalationStatus.Open,
        resolvedByUserId: null,
        resolvedAt: null,
        resolutionNote: null,
        createdAt: new Date('2026-08-31T10:00:00.000Z'),
      },
      {
        id: 'escalation-ours-resolved',
        communityId: COMMUNITY_ID,
        joinRequestId: 'join-request-2',
        subjectUserId: 'applicant-2',
        raisedByUserId: MODERATOR_ID,
        note: null,
        status: BanEvasionEscalationStatus.Resolved,
        resolvedByUserId: 'staff-1',
        resolvedAt: new Date('2026-08-31T12:00:00.000Z'),
        resolutionNote: 'Same person, declined',
        createdAt: new Date('2026-08-30T10:00:00.000Z'),
      },
      {
        id: 'escalation-theirs',
        communityId: OTHER_COMMUNITY_ID,
        joinRequestId: 'join-request-3',
        subjectUserId: 'applicant-3',
        raisedByUserId: 'moderator-elsewhere',
        note: 'not ours to read',
        status: BanEvasionEscalationStatus.Open,
        resolvedByUserId: null,
        resolvedAt: null,
        resolutionNote: null,
        createdAt: new Date('2026-08-29T10:00:00.000Z'),
      },
    ];

    beforeEach(() => {
      escalations.find.mockImplementation(
        (options: {
          where: { communityId: string; status?: BanEvasionEscalationStatus };
        }) =>
          Promise.resolve(
            escalationStore.filter(
              (row) =>
                row.communityId === options.where.communityId &&
                (options.where.status === undefined ||
                  row.status === options.where.status),
            ),
          ),
      );
    });

    it('refuses a plain roster member', async () => {
      members.findOne.mockResolvedValue({
        communityId: COMMUNITY_ID,
        userId: 'member-1',
        role: RosterRole.Member,
      });

      await expect(
        service.listEscalations('lisbon-choir', 'member-1', undefined),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(escalations.find).not.toHaveBeenCalled();
    });

    it('refuses somebody who is not on the roster at all', async () => {
      members.findOne.mockResolvedValue(null);

      await expect(
        service.listEscalations('lisbon-choir', 'stranger-1', undefined),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns both open and resolved when no status is given', async () => {
      const rows = await service.listEscalations(
        'lisbon-choir',
        MODERATOR_ID,
        undefined,
      );

      expect(rows.map((row) => row.id)).toEqual([
        'escalation-ours-open',
        'escalation-ours-resolved',
      ]);
      expect(escalations.find).toHaveBeenCalledWith({
        where: { communityId: COMMUNITY_ID },
        order: { createdAt: 'DESC' },
      });
    });

    it('narrows to one lane when a status is given', async () => {
      const rows = await service.listEscalations(
        'lisbon-choir',
        MODERATOR_ID,
        BanEvasionEscalationStatus.Open,
      );

      expect(rows.map((row) => row.id)).toEqual(['escalation-ours-open']);
      expect(escalations.find).toHaveBeenCalledWith({
        where: {
          communityId: COMMUNITY_ID,
          status: BanEvasionEscalationStatus.Open,
        },
        order: { createdAt: 'DESC' },
      });
    });

    it('never returns another community escalation', async () => {
      const rows = await service.listEscalations(
        'lisbon-choir',
        MODERATOR_ID,
        undefined,
      );

      expect(rows.map((row) => row.id)).not.toContain('escalation-theirs');
      expect(JSON.stringify(rows)).not.toContain('not ours to read');
    });

    it('carries nothing staff added to the case', async () => {
      const rows = await service.listEscalations(
        'lisbon-choir',
        MODERATOR_ID,
        undefined,
      );

      // A resolved row is the one that would leak, so it is the one asserted
      // on: the moderator sees that the question was closed and nothing about
      // what staff found.
      const resolved = rows.find(
        (row) => row.id === 'escalation-ours-resolved',
      );
      expect(Object.keys(resolved ?? {}).sort()).toEqual([
        'createdAt',
        'id',
        'joinRequestId',
        'note',
        'status',
      ]);
      expect(resolved?.status).toBe(BanEvasionEscalationStatus.Resolved);

      const serialized = JSON.stringify(rows);
      for (const forbidden of [
        'assessment',
        'resolutionNote',
        'resolvedBy',
        'resolvedAt',
        'Same person, declined',
        'staff-1',
        'tier',
        'score',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });
  });
});
