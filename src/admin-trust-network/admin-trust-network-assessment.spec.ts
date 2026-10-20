import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Report } from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { UserRole } from '../users/entities/user.entity';
import { Vouch } from '../vouch/entities/vouch.entity';
import {
  assessTrustNetwork,
  AssessmentMemberInput,
  AssessmentVouchInput,
} from './admin-trust-network-assessment';
import {
  AdminTrustNetworkAssessmentService,
  ASSESSMENT_TTL_MS,
} from './admin-trust-network-assessment.service';
import { detectRingSlugs } from './admin-trust-network-ring';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date('2026-10-19T12:00:00.000Z');

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

/** A verified, invited, unreported member who joined at the platform start
 *  used by each test. Override what the test is about. */
function makeMember(
  overrides: Partial<AssessmentMemberInput> & { userId: string },
): AssessmentMemberInput {
  return {
    slug: overrides.userId,
    name: overrides.userId,
    verified: true,
    joinedAt: daysAgo(400),
    role: UserRole.Member,
    isSystem: false,
    isSuspended: false,
    isDeactivated: false,
    invitedByUserId: 'seed',
    openReportCount: 0,
    ...overrides,
  };
}

function vouch(
  voucherId: string,
  voucheeId: string,
  withdrawn = false,
): AssessmentVouchInput {
  return { voucherId, voucheeId, withdrawn };
}

/** The platform's first (verified, invited) member, which fixes
 *  `platformStartedAt` at `ageDays` ago. */
function platformSeed(ageDays: number): AssessmentMemberInput {
  return makeMember({ userId: 'seed', joinedAt: daysAgo(ageDays) });
}

describe('assessTrustNetwork', () => {
  describe('new account window', () => {
    it('is 5 days on a 20-day-old platform', () => {
      const assessment = assessTrustNetwork([platformSeed(20)], [], NOW);
      expect(assessment.newAccountWindowDays).toBe(5);
      expect(assessment.platformStartedAt).toEqual(daysAgo(20));
    });

    it('caps at 30 days on a 400-day-old platform', () => {
      const assessment = assessTrustNetwork([platformSeed(400)], [], NOW);
      expect(assessment.newAccountWindowDays).toBe(30);
    });

    it('never drops below 1 day on a brand new platform', () => {
      const assessment = assessTrustNetwork([platformSeed(0.5)], [], NOW);
      expect(assessment.newAccountWindowDays).toBe(1);
    });

    it('ignores system accounts when finding the platform start', () => {
      const assessment = assessTrustNetwork(
        [
          makeMember({
            userId: 'house',
            isSystem: true,
            joinedAt: daysAgo(900),
          }),
          platformSeed(20),
        ],
        [],
        NOW,
      );
      expect(assessment.platformStartedAt).toEqual(daysAgo(20));
      expect(assessment.byUserId.get('house')?.accountKind).toBe('system');
    });
  });

  describe('account kind and exemptions', () => {
    it('never isolates the owner (admin), even when every voucher is new', () => {
      const members = [
        platformSeed(400),
        makeMember({
          userId: 'owner',
          role: UserRole.Admin,
          invitedByUserId: null,
          verified: false,
        }),
        makeMember({
          userId: 'fresh-a',
          verified: false,
          joinedAt: daysAgo(1),
        }),
        makeMember({
          userId: 'fresh-b',
          verified: false,
          joinedAt: daysAgo(2),
        }),
        makeMember({ userId: 'plain', verified: false }),
      ];
      const assessment = assessTrustNetwork(
        members,
        [
          vouch('fresh-a', 'owner'),
          vouch('fresh-b', 'owner'),
          vouch('fresh-a', 'plain'),
          vouch('fresh-b', 'plain'),
        ],
        NOW,
      );

      const owner = assessment.byUserId.get('owner');
      expect(owner?.accountKind).toBe('staff');
      expect(owner?.isolatedBy).toEqual([]);
      expect(
        assessment.cases.some(
          (trustCase) => trustCase.subjectUserId === 'owner',
        ),
      ).toBe(false);
      // The same vouchers do isolate an ordinary member.
      expect(assessment.byUserId.get('plain')?.isolatedBy).toEqual([
        { userId: 'fresh-a', reason: 'new' },
        { userId: 'fresh-b', reason: 'new' },
      ]);
    });

    it('treats a founder with a null inviter as exempt, as vouchee and as voucher', () => {
      // 20-day platform: the window is 5 days, so a 2-day-old unverified
      // account would be new without the exemption.
      const members = [
        platformSeed(20),
        makeMember({
          userId: 'founder',
          verified: false,
          invitedByUserId: null,
          joinedAt: daysAgo(2),
        }),
        makeMember({ userId: 'fresh', verified: false, joinedAt: daysAgo(1) }),
        makeMember({
          userId: 'vouched-by-founder',
          verified: false,
          joinedAt: daysAgo(10),
        }),
        makeMember({
          userId: 'vouched-by-fresh',
          verified: false,
          joinedAt: daysAgo(10),
        }),
      ];
      const assessment = assessTrustNetwork(
        members,
        [
          vouch('fresh', 'founder'),
          vouch('founder', 'vouched-by-founder'),
          vouch('fresh', 'vouched-by-fresh'),
        ],
        NOW,
      );

      expect(assessment.platformStartedAt).toEqual(daysAgo(20));
      expect(assessment.newAccountWindowDays).toBe(5);
      // Control: the same fresh voucher does make an ordinary member isolated.
      expect(assessment.byUserId.get('vouched-by-fresh')?.isolatedBy).toEqual([
        { userId: 'fresh', reason: 'new' },
      ]);
      expect(assessment.byUserId.get('founder')?.accountKind).toBe('founder');
      expect(assessment.byUserId.get('founder')?.isolatedBy).toEqual([]);
      expect(assessment.byUserId.get('vouched-by-founder')?.isolatedBy).toEqual(
        [],
      );
    });

    it('keeps a null-inviter account that joined after the founding window a member', () => {
      const assessment = assessTrustNetwork(
        [
          platformSeed(400),
          makeMember({
            userId: 'late',
            invitedByUserId: null,
            joinedAt: daysAgo(300),
          }),
        ],
        [],
        NOW,
      );
      expect(assessment.byUserId.get('late')?.accountKind).toBe('member');
    });
  });

  describe('weak vouchers and isolation', () => {
    it('does not count a verified 2-day-old voucher as weak', () => {
      const assessment = assessTrustNetwork(
        [
          platformSeed(400),
          makeMember({ userId: 'verified-fresh', joinedAt: daysAgo(2) }),
          makeMember({ userId: 'vouchee', verified: false }),
        ],
        [vouch('verified-fresh', 'vouchee')],
        NOW,
      );
      expect(assessment.byUserId.get('vouchee')?.isolatedBy).toEqual([]);
      expect(assessment.cases).toEqual([]);
    });

    it('isolates a member whose only voucher is unverified and new', () => {
      const assessment = assessTrustNetwork(
        [
          platformSeed(400),
          makeMember({
            userId: 'unverified-fresh',
            verified: false,
            joinedAt: daysAgo(2),
          }),
          makeMember({ userId: 'vouchee', verified: false }),
        ],
        [vouch('unverified-fresh', 'vouchee')],
        NOW,
      );
      expect(assessment.byUserId.get('vouchee')?.isolatedBy).toEqual([
        { userId: 'unverified-fresh', reason: 'new' },
      ]);
      expect(assessment.cases).toEqual([
        expect.objectContaining({
          id: 'isolated:vouchee',
          kind: 'isolated',
          weakVoucherCount: 1,
          score: 1001,
        }),
      ]);
    });

    it('ignores withdrawn vouches when checking isolation', () => {
      const assessment = assessTrustNetwork(
        [
          platformSeed(400),
          makeMember({ userId: 'strong' }),
          makeMember({ userId: 'weak', verified: false, joinedAt: daysAgo(1) }),
          makeMember({ userId: 'vouchee', verified: false }),
        ],
        [vouch('strong', 'vouchee', true), vouch('weak', 'vouchee')],
        NOW,
      );
      expect(assessment.byUserId.get('vouchee')?.isolatedBy).toHaveLength(1);
      expect(assessment.byUserId.get('vouchee')?.activeInboundCount).toBe(1);
    });
  });

  describe('rings and cases', () => {
    const ringMembers = (): AssessmentMemberInput[] => [
      platformSeed(400),
      makeMember({
        userId: 'ring-c',
        slug: 'cara',
        verified: false,
        joinedAt: new Date(daysAgo(3).getTime() + 0 * HOUR_MS),
      }),
      makeMember({
        userId: 'ring-a',
        slug: 'ana',
        verified: false,
        joinedAt: new Date(daysAgo(3).getTime() + 1 * HOUR_MS),
      }),
      makeMember({
        userId: 'ring-b',
        slug: 'bea',
        verified: false,
        joinedAt: new Date(daysAgo(3).getTime() + 2.5 * HOUR_MS),
      }),
    ];
    const ringVouches = [
      vouch('ring-a', 'ring-b'),
      vouch('ring-b', 'ring-c'),
      vouch('ring-c', 'ring-a'),
    ];

    it('turns a ring of 3 new accounts into one ring case with windowHours', () => {
      const assessment = assessTrustNetwork(ringMembers(), ringVouches, NOW);

      expect(assessment.rings).toHaveLength(1);
      expect(assessment.rings[0]).toEqual(
        expect.objectContaining({
          id: 'ring:ana',
          memberUserIds: ['ring-a', 'ring-b', 'ring-c'],
        }),
      );
      expect(assessment.cases).toEqual([
        {
          id: 'ring:ana',
          kind: 'ring',
          subjectUserId: 'ring-c', // earliest joined, the likely seed
          ringId: 'ring:ana',
          memberCount: 3,
          weakVoucherCount: 0,
          openReportCount: 0,
          windowHours: 3,
          score: 3003,
        },
      ]);
      expect(assessment.byUserId.get('ring-a')?.ringId).toBe('ring:ana');
      expect(assessment.byUserId.get('seed')?.ringId).toBeNull();
      // The ring case explains its members, so none is also listed isolated.
      for (const ringMemberId of ['ring-a', 'ring-b', 'ring-c']) {
        expect(assessment.byUserId.get(ringMemberId)?.isolatedBy).toEqual([]);
      }
    });

    it('does not also list a ring member with 2 reports as a flagged case', () => {
      const members = ringMembers().map((member) =>
        member.userId === 'ring-b' ? { ...member, openReportCount: 2 } : member,
      );
      const assessment = assessTrustNetwork(members, ringVouches, NOW);

      expect(assessment.byUserId.get('ring-b')?.standing).toBe('flagged');
      expect(assessment.cases).toHaveLength(1);
      expect(assessment.cases[0]).toEqual(
        expect.objectContaining({ kind: 'ring', openReportCount: 2 }),
      );
    });

    it('lists outside members vouching for 2+ ring members as shared vouchers', () => {
      const members = [
        ...ringMembers(),
        makeMember({
          userId: 'outsider',
          verified: false,
          joinedAt: daysAgo(1),
        }),
      ];
      const assessment = assessTrustNetwork(
        members,
        [
          ...ringVouches,
          vouch('outsider', 'ring-a'),
          vouch('outsider', 'ring-b'),
        ],
        NOW,
      );
      expect(assessment.rings[0]?.sharedVoucherUserIds).toEqual(['outsider']);
    });

    it('keeps exempt and suspended accounts out of rings', () => {
      const withSuspendedMember = ringMembers().map((member) =>
        member.userId === 'ring-a' ? { ...member, isSuspended: true } : member,
      );
      expect(
        assessTrustNetwork(withSuspendedMember, ringVouches, NOW).rings,
      ).toEqual([]);

      const withStaffMember = ringMembers().map((member) =>
        member.userId === 'ring-a'
          ? { ...member, role: UserRole.Moderator }
          : member,
      );
      const staffAssessment = assessTrustNetwork(
        withStaffMember,
        ringVouches,
        NOW,
      );
      expect(staffAssessment.byUserId.get('ring-a')?.accountKind).toBe('staff');
      expect(staffAssessment.rings).toEqual([]);
    });

    it('treats a deactivated member like a suspended one, keeping them as a voucher', () => {
      const withDeactivatedMember = ringMembers().map((member) =>
        member.userId === 'ring-a'
          ? { ...member, isDeactivated: true }
          : member,
      );
      expect(
        assessTrustNetwork(withDeactivatedMember, ringVouches, NOW).rings,
      ).toEqual([]);

      const assessment = assessTrustNetwork(
        [
          platformSeed(400),
          makeMember({
            userId: 'paused',
            isDeactivated: true,
            openReportCount: 3,
          }),
          makeMember({
            userId: 'paused-fresh',
            isDeactivated: true,
            verified: false,
            joinedAt: daysAgo(1),
          }),
          makeMember({ userId: 'lonely', verified: false }),
        ],
        [vouch('paused-fresh', 'paused'), vouch('paused-fresh', 'lonely')],
        NOW,
      );
      // No flagged case and no isolation for the paused account itself.
      expect(assessment.byUserId.get('paused')?.standing).toBe('flagged');
      expect(assessment.byUserId.get('paused')?.isolatedBy).toEqual([]);
      // Still a voucher: it leaves an ordinary member isolated.
      expect(assessment.cases.map((trustCase) => trustCase.id)).toEqual([
        'isolated:lonely',
      ]);
    });

    it('gives a suspended member no case', () => {
      const assessment = assessTrustNetwork(
        [
          platformSeed(400),
          makeMember({
            userId: 'suspended',
            isSuspended: true,
            openReportCount: 3,
          }),
          makeMember({ userId: 'weak', verified: false, joinedAt: daysAgo(1) }),
        ],
        [vouch('weak', 'suspended')],
        NOW,
      );
      expect(assessment.byUserId.get('suspended')?.standing).toBe('flagged');
      expect(assessment.byUserId.get('suspended')?.isolatedBy).toEqual([]);
      expect(assessment.cases).toEqual([]);
    });

    it('ranks ring, then flagged, then isolated, newer subject first on a tie', () => {
      const assessment = assessTrustNetwork(
        [
          ...ringMembers(),
          makeMember({
            userId: 'flag-old',
            openReportCount: 2,
            joinedAt: daysAgo(200),
          }),
          makeMember({
            userId: 'flag-new',
            openReportCount: 2,
            joinedAt: daysAgo(10),
          }),
          makeMember({ userId: 'weak', verified: false, joinedAt: daysAgo(1) }),
          makeMember({ userId: 'lonely', verified: false }),
        ],
        [...ringVouches, vouch('weak', 'lonely')],
        NOW,
      );
      expect(assessment.cases.map((trustCase) => trustCase.id)).toEqual([
        'ring:ana',
        'flagged:flag-new',
        'flagged:flag-old',
        'isolated:lonely',
      ]);
    });
  });

  describe('track record and counts', () => {
    it('counts a withdrawn vouch in vouchesGiven', () => {
      const assessment = assessTrustNetwork(
        [
          platformSeed(400),
          makeMember({ userId: 'voucher' }),
          makeMember({ userId: 'still-fine' }),
          makeMember({ userId: 'later-suspended', isSuspended: true }),
        ],
        [
          vouch('voucher', 'still-fine'),
          vouch('voucher', 'later-suspended', true),
        ],
        NOW,
      );
      const voucher = assessment.byUserId.get('voucher');
      expect(voucher?.trackRecord).toEqual({
        vouchesGiven: 2,
        laterFlaggedCount: 1,
      });
      expect(voucher?.activeOutboundCount).toBe(1);
    });
  });
});

describe('detectRingSlugs', () => {
  const ringEdges = [
    { from: 'a', to: 'b', withdrawn: false },
    { from: 'b', to: 'c', withdrawn: false },
    { from: 'c', to: 'a', withdrawn: false },
  ];
  const unverifiedNode = (id: string) => ({
    id,
    verified: false,
    standing: 'new' as const,
  });

  it('marks every member of a closed unverified loop of 3', () => {
    const ringSlugs = detectRingSlugs(
      ['a', 'b', 'c'].map(unverifiedNode),
      ringEdges,
    );
    expect([...ringSlugs].sort()).toEqual(['a', 'b', 'c']);
  });

  it('drops the whole loop when a verified outsider vouches for one member', () => {
    const ringSlugs = detectRingSlugs(
      [
        ...['a', 'b', 'c'].map(unverifiedNode),
        { id: 'outsider', verified: true, standing: 'trusted' as const },
      ],
      [...ringEdges, { from: 'outsider', to: 'b', withdrawn: false }],
    );
    expect(ringSlugs.size).toBe(0);
  });
});

/** Stubs a fluent query builder chain whose `getRawMany` resolves `rawRows`. */
function makeQueryBuilderStub(
  rawRows: unknown[] = [],
): Record<string, jest.Mock> {
  const queryBuilder: Record<string, jest.Mock> = {};
  for (const chainedMethod of [
    'select',
    'addSelect',
    'innerJoin',
    'where',
    'andWhere',
    'groupBy',
  ]) {
    queryBuilder[chainedMethod] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getRawMany = jest.fn().mockResolvedValue(rawRows);
  return queryBuilder;
}

describe('AdminTrustNetworkAssessmentService', () => {
  let service: AdminTrustNetworkAssessmentService;
  let profiles: { createQueryBuilder: jest.Mock };
  let vouches: { find: jest.Mock };
  let reports: { createQueryBuilder: jest.Mock };

  beforeEach(async () => {
    profiles = {
      createQueryBuilder: jest.fn(() =>
        makeQueryBuilderStub([
          {
            userId: 'user-a',
            slug: 'a-member',
            firstName: 'Ana',
            lastName: 'Lima',
            verified: true,
            joinedAt: new Date('2026-01-01T00:00:00.000Z'),
            role: UserRole.Member,
            isSystem: false,
            status: 'active',
            invitedByUserId: null,
          },
        ]),
      ),
    };
    vouches = { find: jest.fn().mockResolvedValue([]) };
    reports = { createQueryBuilder: jest.fn(() => makeQueryBuilderStub()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminTrustNetworkAssessmentService,
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(Vouch), useValue: vouches },
        { provide: getRepositoryToken(Report), useValue: reports },
      ],
    }).compile();

    service = module.get(AdminTrustNetworkAssessmentService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shares one load between two concurrent callers', async () => {
    const [first, second] = await Promise.all([
      service.getAssessment(),
      service.getAssessment(),
    ]);
    expect(profiles.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(vouches.find).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first.members.get('user-a')?.name).toBe('Ana Lima');
  });

  it('serves the cache inside the TTL and reloads after it', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await service.getAssessment();
    await service.getAssessment();
    expect(profiles.createQueryBuilder).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(1_000_000 + ASSESSMENT_TTL_MS + 1);
    await service.getAssessment();
    expect(profiles.createQueryBuilder).toHaveBeenCalledTimes(2);
  });

  it('retries after a failed load', async () => {
    vouches.find.mockRejectedValueOnce(new Error('database down'));
    await expect(service.getAssessment()).rejects.toThrow('database down');
    await expect(service.getAssessment()).resolves.toBeDefined();
    expect(vouches.find).toHaveBeenCalledTimes(2);
  });
});
