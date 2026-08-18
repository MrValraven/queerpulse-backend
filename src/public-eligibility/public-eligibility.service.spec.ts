import { Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PublicEligibilityService } from './public-eligibility.service';
import { Profile } from '../users/entities/profile.entity';
import { MagazinePiece } from '../magazine/entities/magazine-piece.entity';
import { Event } from '../events/entities/event.entity';
import { EventCohost } from '../events/entities/event-cohost.entity';
import { EventRsvp } from '../events/entities/event-rsvp.entity';
import { Workshop } from '../workshops/entities/workshop.entity';
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

const user = {
  userId: 'u1',
  email: 'a@b.c',
  status: UserStatus.Active,
  role: 'member',
} as any;

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
          provide: getRepositoryToken(Workshop),
          useValue: repoMock({ count: async () => 1 }),
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
    expect(dto.workshopsTaught).toBe(1);
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
});
