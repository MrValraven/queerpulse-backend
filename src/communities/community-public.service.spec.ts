import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IsNull } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { Event } from '../events/entities/event.entity';
import { CommunityPublicService } from './community-public.service';
import { hasLivePendingInvite } from './community-invite-liveness';
import { CommunityInvite } from './entities/community-invite.entity';
import {
  CommunityJoinRequest,
  JoinRequestStatus,
} from './entities/community-join-request.entity';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { AccessTier, Community } from './entities/community.entity';

// Whether an invitation is still spendable (pending, unexpired, from somebody
// still on staff, no block between the two people) is the shared liveness
// helper's call. This file only checks that the private-tier gate asks it.
jest.mock('./community-invite-liveness', () => ({
  hasLivePendingInvite: jest.fn(),
}));
const hasLivePendingInviteMock = hasLivePendingInvite as jest.MockedFunction<
  typeof hasLivePendingInvite
>;

interface RecordedWhereCall {
  clause: string;
  parameters: Record<string, unknown>;
}

// A chainable stub for `listUpcomingGatherings`'s query builder. It records
// every `where` / `andWhere` call it is handed, so a test can read back the
// exact schedule predicate the service asked Postgres for and the values it
// bound. `getMany` resolves empty, which short-circuits `goingCountsFor`
// before it reaches `events.manager`.
const recordingGatheringsQueryBuilder = () => {
  const recordedWhereCalls: RecordedWhereCall[] = [];
  const queryBuilder: Record<string, jest.Mock> = {};
  for (const method of ['where', 'andWhere']) {
    queryBuilder[method] = jest.fn((clause: unknown, parameters: unknown) => {
      if (typeof clause === 'string') {
        recordedWhereCalls.push({
          clause,
          parameters:
            parameters && typeof parameters === 'object'
              ? (parameters as Record<string, unknown>)
              : {},
        });
      }
      return queryBuilder;
    });
  }
  for (const method of ['orderBy', 'addOrderBy', 'offset', 'limit']) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getMany = jest.fn().mockResolvedValue([]);
  return { queryBuilder, recordedWhereCalls };
};

const COMMUNITY = {
  id: 'community-1',
  slug: 'queer-devs',
  accessTier: AccessTier.Public,
  archivedAt: null,
};

describe('CommunityPublicService', () => {
  let service: CommunityPublicService;
  let communities: { findOne: jest.Mock };
  let members: { findOne: jest.Mock; count: jest.Mock };
  let events: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let contentModeration: { stateFor: jest.Mock };
  let invites: Record<string, never>;
  let joinRequests: { findOne: jest.Mock };

  beforeEach(async () => {
    communities = { findOne: jest.fn().mockResolvedValue(COMMUNITY) };
    members = {
      // A PROSPECTIVE member: visible community, no roster row. That is the
      // caller this endpoint exists for.
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    };
    events = {
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(
        () => recordingGatheringsQueryBuilder().queryBuilder,
      ),
    };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };
    // No live invitation is the default caller here, same as `members`
    // defaulting to no roster row: a prospective member off the street. The
    // repository itself is only handed through to the mocked liveness helper.
    invites = {};
    hasLivePendingInviteMock.mockReset();
    hasLivePendingInviteMock.mockResolvedValue(false);
    // No join request on file is the default: somebody who never applied.
    joinRequests = { findOne: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityPublicService,
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(CommunityMember), useValue: members },
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: ContentModerationService, useValue: contentModeration },
        { provide: getRepositoryToken(CommunityInvite), useValue: invites },
        {
          provide: getRepositoryToken(CommunityJoinRequest),
          useValue: joinRequests,
        },
      ],
    }).compile();
    service = module.get(CommunityPublicService);
  });

  // Multi-day and overnight gatherings on the tab a PROSPECTIVE member reads.
  // A gathering that is UNDERWAY is upcoming, and this lane has to agree with
  // the member lane (`EventsService.listUpcomingByCommunity`) or the same
  // community shows two different calendars either side of the join button.
  //
  // There is no database here, so the tests work in two steps. The recording
  // query builder reads back the exact SQL string the service handed TypeORM,
  // and `matchesScheduleClause` pins what that string MEANS by stating the
  // same logic in JavaScript. A predicate the service changes without changing
  // the constant fails the first test; a predicate whose meaning drifts fails
  // the ones after it.
  describe('listUpcomingGatherings schedule predicate', () => {
    const UPCOMING_SCHEDULE_CLAUSE =
      '(gathering.start_at >= :now OR (gathering.end_at IS NOT NULL AND gathering.end_at >= :now))';

    const matchesScheduleClause = (
      clause: string,
      gathering: { startAt: Date; endAt: Date | null },
      now: Date,
    ): boolean => {
      if (clause !== UPCOMING_SCHEDULE_CLAUSE) {
        throw new Error(`No JavaScript reading for the clause: ${clause}`);
      }
      const startsAt = gathering.startAt.getTime();
      const endsAt = gathering.endAt ? gathering.endAt.getTime() : null;
      const nowInMilliseconds = now.getTime();
      return (
        startsAt >= nowInMilliseconds ||
        (endsAt !== null && endsAt >= nowInMilliseconds)
      );
    };

    // Runs the endpoint and returns the one call it built around `:now`,
    // having first checked that the `now` it bound is a real Date.
    const scheduleCall = async (): Promise<RecordedWhereCall> => {
      const { queryBuilder, recordedWhereCalls } =
        recordingGatheringsQueryBuilder();
      events.createQueryBuilder.mockReturnValue(queryBuilder);
      await service.listUpcomingGatherings('queer-devs', 'viewer-1', 1);
      const scheduleCalls = recordedWhereCalls.filter((call) =>
        call.clause.includes(':now'),
      );
      expect(scheduleCalls).toHaveLength(1);
      expect(scheduleCalls[0]!.parameters.now).toBeInstanceOf(Date);
      return scheduleCalls[0]!;
    };

    const scheduleClause = async (): Promise<string> =>
      (await scheduleCall()).clause;

    const now = new Date('2026-10-17T23:30:00.000Z');
    const HOUR_IN_MILLISECONDS = 3_600_000;
    const overnightPartyUnderway = {
      startAt: new Date(now.getTime() - HOUR_IN_MILLISECONDS),
      endAt: new Date(now.getTime() + 4 * HOUR_IN_MILLISECONDS),
    };
    const festivalOnItsSecondDay = {
      startAt: new Date(now.getTime() - 24 * HOUR_IN_MILLISECONDS),
      endAt: new Date(now.getTime() + 48 * HOUR_IN_MILLISECONDS),
    };
    const finished = {
      startAt: new Date(now.getTime() - 4 * HOUR_IN_MILLISECONDS),
      endAt: new Date(now.getTime() - HOUR_IN_MILLISECONDS),
    };
    const startedWithNoStatedEnd = {
      startAt: new Date(now.getTime() - HOUR_IN_MILLISECONDS),
      endAt: null,
    };

    it('builds the underway-aware predicate as one parenthesised conjunct', async () => {
      await expect(scheduleClause()).resolves.toBe(UPCOMING_SCHEDULE_CLAUSE);
    });

    it('keeps an overnight party that started at 23:00 on the tab', async () => {
      const clause = await scheduleClause();
      expect(matchesScheduleClause(clause, overnightPartyUnderway, now)).toBe(
        true,
      );
    });

    it('keeps a three-day festival on the tab on its second day', async () => {
      const clause = await scheduleClause();
      expect(matchesScheduleClause(clause, festivalOnItsSecondDay, now)).toBe(
        true,
      );
    });

    it('drops a gathering that ended an hour ago', async () => {
      const clause = await scheduleClause();
      expect(matchesScheduleClause(clause, finished, now)).toBe(false);
    });

    // A gathering that states no end is over once it has started, which is
    // what browse's `past` branch and `hasEnded` both say. The `IS NOT NULL`
    // arm is what holds that line here.
    it('drops a started gathering with no stated end', async () => {
      const clause = await scheduleClause();
      expect(matchesScheduleClause(clause, startedWithNoStatedEnd, now)).toBe(
        false,
      );
    });

    // The visibility allow-list and the takedown check sit beside the schedule
    // disjunct as their own conjuncts. The schedule's `OR` has to stay inside
    // its own parentheses, because unparenthesised it would bind loosely
    // enough to widen them and a members-only or hidden gathering would ride
    // in on a start date alone. Each clause reaching the builder as a separate
    // `andWhere` is the other half of that guarantee.
    it('keeps the schedule disjunct sealed beside the visibility and takedown filters', async () => {
      const { queryBuilder, recordedWhereCalls } =
        recordingGatheringsQueryBuilder();
      events.createQueryBuilder.mockReturnValue(queryBuilder);
      await service.listUpcomingGatherings('queer-devs', 'viewer-1', 1);
      const clauses = recordedWhereCalls.map((call) => call.clause);
      expect(
        clauses.some((clause) =>
          clause.includes('gathering.visibility IN (:...visibleTiers)'),
        ),
      ).toBe(true);
      expect(clauses.some((clause) => clause.includes('NOT EXISTS'))).toBe(
        true,
      );
      const scheduleClauseText = clauses.find((clause) =>
        clause.includes(':now'),
      )!;
      // The whole disjunct is one balanced group: the opening bracket closes
      // only at the very end, so every `OR` inside it stays inside it.
      let depth = 0;
      let closesEarly = false;
      for (let index = 0; index < scheduleClauseText.length; index += 1) {
        const character = scheduleClauseText[index];
        if (character === '(') depth += 1;
        if (character === ')') depth -= 1;
        if (depth === 0 && index < scheduleClauseText.length - 1) {
          closesEarly = true;
        }
      }
      expect(closesEarly).toBe(false);
      expect(depth).toBe(0);
    });
  });

  describe('listUpcomingGatherings gated-tier non-member', () => {
    // The Events tab this endpoint backs only exists for a `public` community
    // now: a non-member of any other tier gets the gate card, whose
    // `nextGathering` is public-visibility only. So this endpoint has no
    // legitimate gated-tier non-member left, and serving one its
    // members-visibility calendar was a leak.
    it('404s a request-tier community for a non-member', async () => {
      communities.findOne.mockResolvedValue({
        id: 'community-1',
        slug: 'queer-devs',
        accessTier: AccessTier.Request,
        archivedAt: null,
      });
      members.findOne.mockResolvedValue(null);

      await expect(
        service.listUpcomingGatherings('queer-devs', 'stranger', 1),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('still serves a public-tier community to a non-member', async () => {
      communities.findOne.mockResolvedValue({
        id: 'community-1',
        slug: 'queer-devs',
        accessTier: AccessTier.Public,
        archivedAt: null,
      });
      members.findOne.mockResolvedValue(null);

      const page = await service.listUpcomingGatherings(
        'queer-devs',
        'stranger',
        1,
      );

      expect(page.items).toEqual([]);
      expect(page.page).toBe(1);
    });
  });

  describe('getGateCard', () => {
    // The card an outsider sees instead of the hub. Its field list is closed
    // and it is the SAME closed list the anonymous teaser serves, which is why
    // one type serves both doors.
    const GATED_COMMUNITY = {
      id: 'community-1',
      slug: 'queer-devs',
      name: 'Queer Devs',
      tagline: 'Code and company',
      purpose: 'Monthly pairing nights',
      type: 'professional',
      tags: ['tech'],
      city: 'Lisbon',
      area: 'Arroios',
      isOnline: false,
      languages: ['pt', 'en'],
      avatarImageUrl: null,
      coverImageUrl: null,
      archivedAt: null,
    };

    it('serves the card to a non-member of a request-tier community, without an is-publicly-listed opt-in', async () => {
      communities.findOne.mockResolvedValue({
        ...GATED_COMMUNITY,
        accessTier: AccessTier.Request,
        isPubliclyListed: false,
      });
      members.findOne.mockResolvedValue(null);
      members.count.mockResolvedValue(34);

      const card = await service.getGateCard('queer-devs', 'stranger');

      expect(card.name).toBe('Queer Devs');
      expect(card.accessTier).toBe(AccessTier.Request);
      expect(card.memberCount).toBe(34);
    });

    it('serves the card to a non-member of an invite-tier community', async () => {
      communities.findOne.mockResolvedValue({
        ...GATED_COMMUNITY,
        accessTier: AccessTier.Invite,
      });
      members.findOne.mockResolvedValue(null);

      const card = await service.getGateCard('queer-devs', 'stranger');

      expect(card.accessTier).toBe(AccessTier.Invite);
    });

    // The one door into a private community for somebody off its roster, and
    // it opens onto the card rather than onto the community.
    it('serves the card to a private-tier non-member holding a pending invitation', async () => {
      communities.findOne.mockResolvedValue({
        ...GATED_COMMUNITY,
        accessTier: AccessTier.Private,
      });
      members.findOne.mockResolvedValue(null);
      hasLivePendingInviteMock.mockResolvedValue(true);

      const card = await service.getGateCard('queer-devs', 'invitee');

      expect(card.accessTier).toBe(AccessTier.Private);
    });

    it('404s a private-tier community for a non-member with no invitation', async () => {
      communities.findOne.mockResolvedValue({
        ...GATED_COMMUNITY,
        accessTier: AccessTier.Private,
      });
      members.findOne.mockResolvedValue(null);
      hasLivePendingInviteMock.mockResolvedValue(false);

      await expect(
        service.getGateCard('queer-devs', 'stranger'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s an unknown slug', async () => {
      communities.findOne.mockResolvedValue(null);

      await expect(
        service.getGateCard('nope', 'stranger'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s an archived community for a non-member', async () => {
      communities.findOne.mockResolvedValue({
        ...GATED_COMMUNITY,
        accessTier: AccessTier.Request,
        archivedAt: new Date('2026-03-01T00:00:00.000Z'),
      });
      members.findOne.mockResolvedValue(null);

      await expect(
        service.getGateCard('queer-devs', 'stranger'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s a community under a moderator takedown for a non-member', async () => {
      communities.findOne.mockResolvedValue({
        ...GATED_COMMUNITY,
        accessTier: AccessTier.Request,
      });
      members.findOne.mockResolvedValue(null);
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });

      await expect(
        service.getGateCard('queer-devs', 'stranger'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    // The guard that matters most. A field added to the card is a field served
    // to somebody the community did not let in, so the shape is asserted whole
    // rather than field by field.
    it('carries exactly the closed field list and nothing else', async () => {
      communities.findOne.mockResolvedValue({
        ...GATED_COMMUNITY,
        accessTier: AccessTier.Request,
        // Fields an outsider must never receive, present on the entity and
        // expected to be dropped by the mapper.
        rules: ['no bigotry'],
        ownerId: 'owner-1',
        whoFor: 'devs',
        features: ['discussion'],
        rosterVisible: true,
        welcomeMessage: 'hello',
        frozenAt: new Date('2026-04-01T00:00:00.000Z'),
        frozenReason: 'reports',
        ref: 'QP-C-0004',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        // A reading group's current book stays inside the club.
        nowReading: 'Some book',
      });
      members.findOne.mockResolvedValue(null);

      const card = await service.getGateCard('queer-devs', 'stranger');

      expect(card).not.toHaveProperty('nowReading');

      expect(Object.keys(card).sort()).toEqual(
        [
          'accessTier',
          'area',
          'avatarImageUrl',
          'city',
          'coverImageUrl',
          'isOnline',
          'languages',
          'memberCount',
          // The one addition over the teaser: the CALLER'S own applicant
          // state, a fact about them alone.
          'myJoinRequestStatus',
          'name',
          'nextGathering',
          'purpose',
          'slug',
          'tagline',
          'tags',
          'type',
        ].sort(),
      );
    });

    it("getGateCard carries the caller's pending join request status", async () => {
      communities.findOne.mockResolvedValue({
        ...GATED_COMMUNITY,
        accessTier: AccessTier.Request,
      });
      members.findOne.mockResolvedValue(null);
      joinRequests.findOne.mockResolvedValue({
        id: 'request-1',
        status: JoinRequestStatus.Pending,
      });

      const card = await service.getGateCard('queer-devs', 'applicant');

      expect(card.myJoinRequestStatus).toBe(JoinRequestStatus.Pending);
      // The caller's OWN newest request, and only theirs.
      expect(joinRequests.findOne).toHaveBeenCalledWith({
        where: { communityId: 'community-1', userId: 'applicant' },
        order: { createdAt: 'DESC' },
        select: { id: true, status: true },
      });
    });

    it('getGateCard answers null status for a caller who never applied', async () => {
      communities.findOne.mockResolvedValue({
        ...GATED_COMMUNITY,
        accessTier: AccessTier.Request,
      });
      members.findOne.mockResolvedValue(null);
      joinRequests.findOne.mockResolvedValue(null);

      const card = await service.getGateCard('queer-devs', 'stranger');

      expect(card.myJoinRequestStatus).toBeNull();
    });

    // A pending row that has expired, or whose sender left the mod team, or
    // that sits across a block, no longer opens the private door. The
    // liveness helper answers false for all of those.
    it('getGateCard 404s a private community whose only invitation is no longer live', async () => {
      communities.findOne.mockResolvedValue({
        ...GATED_COMMUNITY,
        accessTier: AccessTier.Private,
      });
      members.findOne.mockResolvedValue(null);
      hasLivePendingInviteMock.mockResolvedValue(false);

      await expect(
        service.getGateCard('queer-devs', 'former-invitee'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(hasLivePendingInviteMock).toHaveBeenCalledWith(
        invites,
        'community-1',
        'former-invitee',
      );
    });
  });

  describe('getRules', () => {
    const RULED_COMMUNITY = {
      id: 'community-1',
      slug: 'queer-devs',
      rules: ['rules.preset.respect', 'Bring your own mug'],
      rulesVersion: 3,
      archivedAt: null,
    };

    it('getRules serves a request-tier outsider the rules and a null accepted version', async () => {
      communities.findOne.mockResolvedValue({
        ...RULED_COMMUNITY,
        accessTier: AccessTier.Request,
      });
      members.findOne.mockResolvedValue(null);

      const rulesResponse = await service.getRules('queer-devs', 'stranger');

      expect(rulesResponse).toEqual({
        rules: ['rules.preset.respect', 'Bring your own mug'],
        rulesVersion: 3,
        rulesAcceptedVersion: null,
      });
    });

    it('getRules serves an invited private-tier outsider', async () => {
      communities.findOne.mockResolvedValue({
        ...RULED_COMMUNITY,
        accessTier: AccessTier.Private,
      });
      members.findOne.mockResolvedValue(null);
      hasLivePendingInviteMock.mockResolvedValue(true);

      const rulesResponse = await service.getRules('queer-devs', 'invitee');

      expect(rulesResponse.rulesVersion).toBe(3);
      expect(rulesResponse.rulesAcceptedVersion).toBeNull();
      expect(hasLivePendingInviteMock).toHaveBeenCalledWith(
        invites,
        'community-1',
        'invitee',
      );
    });

    // PRD-143 parity: members keep reading an archived community, so a plain
    // member (no staff role) still reaches its rules.
    it('getRules serves the roster of an archived community', async () => {
      communities.findOne.mockResolvedValue({
        ...RULED_COMMUNITY,
        accessTier: AccessTier.Request,
        archivedAt: new Date('2026-03-01T00:00:00.000Z'),
      });
      members.findOne.mockResolvedValue({
        role: RosterRole.Member,
        rulesVersionAccepted: 2,
      });

      const rulesResponse = await service.getRules('queer-devs', 'member-1');

      expect(rulesResponse.rules).toEqual([
        'rules.preset.respect',
        'Bring your own mug',
      ]);
      expect(rulesResponse.rulesAcceptedVersion).toBe(2);
    });

    it('getRules 404s an archived community to a non-member', async () => {
      communities.findOne.mockResolvedValue({
        ...RULED_COMMUNITY,
        accessTier: AccessTier.Request,
        archivedAt: new Date('2026-03-01T00:00:00.000Z'),
      });
      members.findOne.mockResolvedValue(null);

      await expect(
        service.getRules('queer-devs', 'stranger'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    // The archive widening reaches the roster; a takedown still stays with
    // the community's staff.
    it('getRules 404s a taken-down community to a plain member', async () => {
      communities.findOne.mockResolvedValue({
        ...RULED_COMMUNITY,
        accessTier: AccessTier.Request,
      });
      members.findOne.mockResolvedValue({
        role: RosterRole.Member,
        rulesVersionAccepted: 3,
      });
      contentModeration.stateFor.mockResolvedValue({
        hidden: false,
        removed: true,
      });

      await expect(
        service.getRules('queer-devs', 'member-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("getRules reports the member's accepted version", async () => {
      communities.findOne.mockResolvedValue({
        ...RULED_COMMUNITY,
        accessTier: AccessTier.Invite,
      });
      members.findOne.mockResolvedValue({
        role: RosterRole.Member,
        rulesVersionAccepted: 2,
      });

      const rulesResponse = await service.getRules('queer-devs', 'member-1');

      expect(rulesResponse).toEqual({
        rules: ['rules.preset.respect', 'Bring your own mug'],
        rulesVersion: 3,
        rulesAcceptedVersion: 2,
      });
    });
  });

  describe('getPublicTeaser', () => {
    it('never resolves a space (the teaser is out of v1 for spaces)', async () => {
      communities.findOne.mockResolvedValue(null);

      await expect(service.getPublicTeaser('a-space')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(communities.findOne).toHaveBeenCalledWith({
        where: expect.objectContaining({
          slug: 'a-space',
          parentId: IsNull(),
        }) as unknown,
      });
    });
  });
});
