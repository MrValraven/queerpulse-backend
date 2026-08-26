import { ForbiddenException, Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PublicEligibilityService } from './public-eligibility.service';
import { Profile } from '../users/entities/profile.entity';
import { MagazinePiece } from '../magazine/entities/magazine-piece.entity';
import { Event } from '../events/entities/event.entity';
import { EventCohost } from '../events/entities/event-cohost.entity';
import { EventRsvp } from '../events/entities/event-rsvp.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { ForumPost } from '../forum/entities/forum-post.entity';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { CommunityPostReply } from '../communities/entities/community-post-reply.entity';
import { Vouch } from '../vouch/entities/vouch.entity';
import { ConnectionsService } from '../connections/connections.service';
import { SubprofileEndorsementsService } from '../subprofiles/subprofile-endorsements.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { UserStatus } from '../users/entities/user.entity';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import {
  PUBLIC_ELIGIBILITY_REASON,
  type PublicEligibilityReasonCode,
} from './public-eligibility-response';
import { TENURE_FLOOR_DAYS } from './public-eligibility.rules';

/** The coarse code the 403 body carries, for the assertions below. */
function reasonCodeOf(error: unknown): PublicEligibilityReasonCode | undefined {
  const body = (error as ForbiddenException).getResponse();
  return (body as { reasonCode?: PublicEligibilityReasonCode }).reasonCode;
}

// Minimal query-builder stub: getCount / getMany / getRawMany resolve to fixtures.
function qbStub(result: { count?: number; many?: unknown[]; raw?: unknown[] }) {
  const queryBuilder: Record<string, unknown> = {};
  for (const method of [
    'innerJoin',
    'leftJoin',
    'where',
    'andWhere',
    'orWhere',
    'select',
    'orderBy',
    'limit',
    'setParameters',
  ]) {
    queryBuilder[method] = () => queryBuilder;
  }
  queryBuilder.getCount = async () => result.count ?? 0;
  queryBuilder.getMany = async () => result.many ?? [];
  queryBuilder.getRawMany = async () => result.raw ?? [];
  return queryBuilder;
}

const user: CurrentUserData = {
  userId: 'u1',
  email: 'a@b.c',
  status: UserStatus.Active,
  role: 'member',
};

describe('PublicEligibilityService', () => {
  async function build(overrides: Provider[] = []) {
    const profile = {
      userId: 'u1',
      slug: 'ada',
      verified: true,
      vouchCount: 3,
      joinedAt: new Date('2024-01-01T00:00:00Z'),
    };
    const repoMock = (impl: Record<string, unknown>) => ({
      count: async () => 0,
      find: async () => [],
      findOne: async () => null,
      createQueryBuilder: () => qbStub({}),
      ...impl,
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        PublicEligibilityService,
        {
          provide: getRepositoryToken(Profile),
          useValue: repoMock({ findOne: async () => profile }),
        },
        {
          provide: getRepositoryToken(MagazinePiece),
          useValue: repoMock({
            createQueryBuilder: () =>
              qbStub({
                raw: [{ publishedAt: new Date('2026-07-01T00:00:00Z') }],
              }),
          }),
        },
        {
          provide: getRepositoryToken(Event),
          useValue: repoMock({
            createQueryBuilder: () =>
              qbStub({ many: [{ startAt: new Date('2026-06-01T00:00:00Z') }] }),
          }),
        },
        {
          provide: getRepositoryToken(EventCohost),
          useValue: repoMock({ find: async () => [] }),
        },
        {
          provide: getRepositoryToken(EventRsvp),
          useValue: repoMock({
            createQueryBuilder: () => qbStub({ count: 4 }),
          }),
        },
        {
          provide: getRepositoryToken(Subprofile),
          useValue: repoMock({
            find: async () => [{ id: 's1' }, { id: 's2' }],
          }),
        },
        {
          provide: getRepositoryToken(ForumThread),
          useValue: repoMock({ count: async () => 2 }),
        },
        {
          provide: getRepositoryToken(ForumPost),
          useValue: repoMock({ count: async () => 3 }),
        },
        {
          provide: getRepositoryToken(CommunityPost),
          useValue: repoMock({ count: async () => 1 }),
        },
        {
          provide: getRepositoryToken(CommunityPostReply),
          useValue: repoMock({ count: async () => 0 }),
        },
        {
          provide: getRepositoryToken(Vouch),
          useValue: repoMock({ count: async () => 5 }),
        },
        {
          provide: ConnectionsService,
          useValue: {
            counts: async () => ({
              all: 12,
              incoming: 0,
              outgoing: 0,
              vouched: 0,
            }),
          },
        },
        {
          provide: SubprofileEndorsementsService,
          useValue: {
            loadEndorsementCountsFor: async (ids: string[]) =>
              new Map(ids.map((id) => [id, 2])),
          },
        },
        {
          provide: ContentModerationService,
          useValue: { statesForAnyType: async () => new Map() },
        },
        ...overrides,
      ],
    }).compile();
    return moduleRef.get(PublicEligibilityService);
  }

  it('composes the full signal set from all sources', async () => {
    const service = await build();
    const dto = await service.getSignals(user);
    expect(dto.verified).toBe(true);
    expect(dto.vouchCount).toBe(3);
    expect(dto.vouchesGivenCount).toBe(5);
    expect(dto.tenureDays).toBeGreaterThan(365);
    expect(dto.publishedPieces).toEqual(['2026-07-01T00:00:00.000Z']);
    expect(dto.hostedOpenEvents).toEqual(['2026-06-01T00:00:00.000Z']);
    expect(dto.publishedSubprofiles).toBe(2);
    expect(dto.endorsementCount).toBe(4); // 2 subprofiles × 2
    expect(dto.connectionCount).toBe(12);
    expect(dto.eventsAttended).toBe(4);
    expect(dto.communityPosts).toBe(6); // 2+3+1+0
    expect(dto.lastActiveDaysAgo).toBe(0);
    expect(dto.standingOk).toBe(true);
  });

  it('standingOk is false when a member-level moderation takedown exists', async () => {
    // Fixture `profile.slug` is 'ada' (see `build()` above) — the service
    // queries moderation state keyed by [profile.slug, userId], so a hidden
    // state under the slug is what a real takedown on this member looks like.
    const blockingContentModeration = {
      statesForAnyType: async () =>
        new Map([['ada', { hidden: true, removed: false }]]),
    };
    const service = await build([
      {
        provide: ContentModerationService,
        useValue: blockingContentModeration,
      },
    ]);
    const dto = await service.getSignals(user);
    expect(dto.standingOk).toBe(false);
  });

  it('standingOk is false when the account is not Active', async () => {
    const service = await build();
    const dto = await service.getSignals({
      ...user,
      status: UserStatus.Deactivated,
    });
    expect(dto.standingOk).toBe(false);
  });

  it('surfaces a co-hosted (not owned) open event in hostedOpenEvents', async () => {
    // A member who only co-hosts (never the `hostId`) must still show up.
    // The qbStub ignores the `Brackets` predicate entirely, so this test
    // cannot verify the SQL `OR event.id IN (:...cohostIds)` clause itself —
    // it verifies the two real steps around it: the cohost lookup returns the
    // co-hosted event id, and whatever the (stubbed) event query then returns
    // flows unchanged into `hostedOpenEvents`.
    const cohostedEventRepo = {
      provide: getRepositoryToken(EventCohost),
      useValue: {
        count: async () => 0,
        find: async () => [{ eventId: 'e-cohosted' }],
        findOne: async () => null,
      },
    };
    const cohostedEventQuery = {
      provide: getRepositoryToken(Event),
      useValue: {
        count: async () => 0,
        find: async () => [],
        findOne: async () => null,
        createQueryBuilder: () =>
          qbStub({ many: [{ startAt: new Date('2026-04-01T00:00:00Z') }] }),
      },
    };
    const service = await build([cohostedEventRepo, cohostedEventQuery]);
    const dto = await service.getSignals(user);
    expect(dto.hostedOpenEvents).toContain('2026-04-01T00:00:00.000Z');
  });

  // ---- The server-side publication gate (SOC-11) --------------------------
  //
  // The rule used to live only in frontend JavaScript, so `PUT
  // /me/public-profile` published to the open web on request. These pin the
  // decision to the server. The arithmetic itself is pinned separately in
  // `public-eligibility.rules.spec.ts`; here we only check that the service
  // applies it and that the gate throws.

  describe('the decision', () => {
    it('ships the decision alongside the signals so the client cannot drift', async () => {
      const service = await build();

      const dto = await service.getSignals(user);

      expect(dto.decision).toBeDefined();
      expect(dto.decision.gates.isVerifiedMet).toBe(true);
      expect(dto.decision.gates.tenureFloorDays).toBe(TENURE_FLOOR_DAYS);
      expect(dto.decision.score.target).toBe(100);
      expect(dto.decision.score.families).toHaveLength(3);
      expect(dto.decision.isStandingOk).toBe(true);
    });

    it('agrees with getSignals when asked for the verdict alone', async () => {
      const service = await build();

      const [dto, decision] = await Promise.all([
        service.getSignals(user),
        service.evaluate(user),
      ]);

      expect(decision.isEligible).toBe(dto.decision.isEligible);
      expect(decision.gates).toEqual(dto.decision.gates);
    });
  });

  describe('assertMayGoPublic', () => {
    it('refuses an unverified member and names the gate they can act on', async () => {
      const unverifiedProfile = {
        provide: getRepositoryToken(Profile),
        useValue: {
          count: async () => 0,
          find: async () => [],
          findOne: async () => ({
            userId: 'u1',
            slug: 'ada',
            verified: false,
            vouchCount: 3,
            joinedAt: new Date('2024-01-01T00:00:00Z'),
          }),
          createQueryBuilder: () => qbStub({}),
        },
      };
      const service = await build([unverifiedProfile]);

      expect.assertions(2);
      try {
        await service.assertMayGoPublic(user);
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenException);
        expect(reasonCodeOf(error)).toBe(PUBLIC_ELIGIBILITY_REASON.NotVerified);
      }
    });

    it('refuses a member who has not served the tenure floor', async () => {
      const brandNewProfile = {
        provide: getRepositoryToken(Profile),
        useValue: {
          count: async () => 0,
          find: async () => [],
          findOne: async () => ({
            userId: 'u1',
            slug: 'ada',
            verified: true,
            vouchCount: 3,
            joinedAt: new Date(),
          }),
          createQueryBuilder: () => qbStub({}),
        },
      };
      const service = await build([brandNewProfile]);

      expect.assertions(2);
      try {
        await service.assertMayGoPublic(user);
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenException);
        expect(reasonCodeOf(error)).toBe(
          PUBLIC_ELIGIBILITY_REASON.TenureTooShort,
        );
      }
    });

    // Publishing to the open web while suspended must be impossible, whatever
    // the member's score. `CurrentUserData.status` is re-read from the row on
    // every request by `JwtStrategy.validate`, so this is not a stale claim.
    it('vetoes a suspended account on standing', async () => {
      const service = await build();
      const suspended = { ...user, status: UserStatus.Suspended };

      const decision = await service.evaluate(suspended);
      expect(decision.isStandingOk).toBe(false);
      expect(decision.isEligible).toBe(false);

      await expect(service.assertMayGoPublic(suspended)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    // Same for a member under a moderator takedown, and the reason stays the
    // generic catch-all: this endpoint must never confirm a takedown.
    it('vetoes a member under a moderation takedown', async () => {
      const service = await build([
        {
          provide: ContentModerationService,
          useValue: {
            statesForAnyType: async () =>
              new Map([['ada', { hidden: true, removed: false }]]),
          },
        },
      ]);

      const decision = await service.evaluate(user);
      expect(decision.isStandingOk).toBe(false);

      await expect(service.assertMayGoPublic(user)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });
});
