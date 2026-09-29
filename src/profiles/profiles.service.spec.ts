import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { DataSource } from 'typeorm';
import { AmbassadorStatusService } from '../ambassadors/ambassador-status.service';
import { VALIDATION_PIPE_OPTIONS } from '../common/validation-pipe.options';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { ConnectionsService } from '../connections/connections.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { HandlesService } from '../handles/handles.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { StorageService } from '../storage/storage.service';
import { BlockFilterService } from '../social/block-filter.service';
import { HiddenFromService } from '../social/hidden-from.service';
import { Community } from '../communities/entities/community.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { VouchService } from '../vouch/vouch.service';
import { truncateAtWord } from './directory-blurb';
import { MemberSort } from './dto/list-members.query';
import { Activity } from './entities/activity.entity';
import {
  BoardKind,
  BoardPost,
  BoardPostStatus,
} from './entities/board-post.entity';
import { BoardPostResponse } from './entities/board-post-response.entity';
import { Group } from './entities/group.entity';
import { GroupMembership } from './entities/group-membership.entity';
import { ProfileFeaturedCommunity } from './entities/profile-featured-community.entity';
import { ProfileNowHistory } from './entities/profile-now-history.entity';
import { Shaping, ShapingKind } from './entities/shaping.entity';
import { Skill } from './entities/skill.entity';
import { SocialLink } from './entities/social-link.entity';
import { WorkItem } from './entities/work-item.entity';
import { ActivityVisibilityService } from './activity-visibility.service';
import { LastActiveService } from './last-active.service';
import { NowInsightsService } from './now-insights.service';
import { ProfilesService } from './profiles.service';

// A chainable query-builder stub whose terminal methods resolve to [].
const qbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'innerJoin',
    'leftJoin',
    'select',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'setParameters',
    // Singular, and distinct from `setParameters` above: the facet count
    // queries bind one parameter per filter clause as they build the select.
    'setParameter',
    'take',
    'skip',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue([]);
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  // Each facet count query reads one aggregate row. `undefined` is the honest
  // stub: `countByFilterClauses` treats a missing row as zero for every option.
  qb.getRawOne = jest.fn().mockResolvedValue(undefined);
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  return qb as Record<string, jest.Mock> & {
    getMany: jest.Mock;
    getRawMany: jest.Mock;
    getRawOne: jest.Mock;
    getManyAndCount: jest.Mock;
  };
};

const LONG_BIO =
  "I build things for the web and spend most weekends cooking for more people than my kitchen was designed for. Lately I've been learning to bind books.";

describe('ProfilesService.getBySlug visibility', () => {
  let service: ProfilesService;
  let profiles: {
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
    exists: jest.Mock;
  };
  let connections: {
    areConnected: jest.Mock;
    acceptedConnectionsAmong: jest.Mock;
  };
  let vouchService: {
    getVouchCount: jest.Mock;
    getVouchCounts: jest.Mock;
    getNamedVoucherIds: jest.Mock;
  };
  let blockFilter: { isBlockedEitherWay: jest.Mock; excludeBlocked: jest.Mock };
  let handles: { rename: jest.Mock; previousProfileOwnerOf: jest.Mock };
  let nowHistory: { create: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  // Board fixtures for the `loadBoardResponses` visibility-gate test below.
  // Defaulted to empty so every OTHER test in this describe (which never
  // touches the board) is unaffected: `loadBoardResponses` short-circuits on
  // an empty `postIds` before ever calling `boardResponses.createQueryBuilder`.
  let boardPosts: { find: jest.Mock };
  let boardResponses: { find: jest.Mock; createQueryBuilder?: jest.Mock };
  let contentModeration: { statesForAnyType: jest.Mock };
  const findEmpty = () => ({ find: jest.fn().mockResolvedValue([]) });

  const profile = (overrides = {}): Profile =>
    ({
      userId: 'owner-1',
      slug: 'jo',
      firstName: 'Jo',
      lastName: 'Lee',
      pronouns: 'they/them',
      tagline: 'hi',
      bio: 'longform',
      location: 'Lisbon',
      now: 'now text',
      avatarUrl: null,
      visibility: ProfileVisibility.Open,
      openTo: [],
      identities: ['Queer'],
      lookingFor: ['Community & friendship'],
      tags: [],
      verified: false,
      joinedAt: new Date('2024-03-01T00:00:00.000Z'),
      ...overrides,
    }) as unknown as Profile;

  beforeEach(async () => {
    profiles = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => qbStub()),
      // The account-status gate (ENG-435). Every member is active by default.
      exists: jest.fn().mockResolvedValue(true),
    };
    connections = {
      areConnected: jest.fn().mockResolvedValue(false),
      acceptedConnectionsAmong: jest.fn().mockResolvedValue(new Set()),
    };
    vouchService = {
      getVouchCount: jest.fn().mockResolvedValue(0),
      getVouchCounts: jest.fn().mockResolvedValue(new Map()),
      // Empty by default: `loadMutualVoucherCount` short-circuits on an empty
      // batch before ever calling `visibleMemberIds` or
      // `acceptedConnectionsAmong`, so every OTHER test in this describe
      // (which never sets `vouchersVisible: true`) is unaffected.
      getNamedVoucherIds: jest.fn().mockResolvedValue([]),
    };
    blockFilter = {
      isBlockedEitherWay: jest.fn().mockResolvedValue(false),
      excludeBlocked: jest.fn((qb: unknown) => qb),
    };
    handles = {
      rename: jest.fn(),
      // PRD-204: a missing slug asks the handle ledger whether it was renamed
      // away from. No reservation by default.
      previousProfileOwnerOf: jest.fn().mockResolvedValue(null),
    };
    // `create` mirrors TypeORM's Repository.create: it merges the input into
    // a plain object rather than persisting anything itself. Persistence
    // happens through the transactional manager in `dataSource.transaction`,
    // which individual tests configure to capture what was saved.
    nowHistory = {
      create: jest.fn(
        (input: Partial<ProfileNowHistory>) =>
          ({ ...input }) as ProfileNowHistory,
      ),
    };
    dataSource = { transaction: jest.fn() };
    boardPosts = { find: jest.fn().mockResolvedValue([]) };
    boardResponses = { find: jest.fn().mockResolvedValue([]) };
    contentModeration = {
      statesForAnyType: jest.fn().mockResolvedValue(new Map()),
    };
    const groupMemberships = {
      ...findEmpty(),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProfilesService,
        {
          provide: AmbassadorStatusService,
          useValue: { findActive: jest.fn().mockResolvedValue(null) },
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(SocialLink), useValue: findEmpty() },
        { provide: getRepositoryToken(WorkItem), useValue: findEmpty() },
        { provide: getRepositoryToken(Skill), useValue: findEmpty() },
        { provide: getRepositoryToken(BoardPost), useValue: boardPosts },
        {
          provide: getRepositoryToken(BoardPostResponse),
          useValue: boardResponses,
        },
        { provide: getRepositoryToken(Shaping), useValue: findEmpty() },
        { provide: getRepositoryToken(Activity), useValue: findEmpty() },
        { provide: getRepositoryToken(Group), useValue: findEmpty() },
        {
          provide: getRepositoryToken(GroupMembership),
          useValue: groupMemberships,
        },
        {
          provide: getRepositoryToken(ProfileFeaturedCommunity),
          useValue: { createQueryBuilder: jest.fn(() => qbStub()) },
        },
        {
          provide: getRepositoryToken(Community),
          useValue: { createQueryBuilder: jest.fn(() => qbStub()) },
        },
        {
          provide: getRepositoryToken(CommunityMember),
          useValue: { createQueryBuilder: jest.fn(() => qbStub()) },
        },
        {
          provide: getRepositoryToken(ProfileNowHistory),
          useValue: nowHistory,
        },
        { provide: DataSource, useValue: dataSource },
        { provide: VouchService, useValue: vouchService },
        { provide: ConnectionsService, useValue: connections },
        { provide: BlockFilterService, useValue: blockFilter },
        {
          provide: HiddenFromService,
          useValue: {
            isHiddenFrom: jest.fn().mockResolvedValue(false),
            excludeHiddenFrom: jest.fn((qb: unknown) => qb),
          },
        },
        { provide: HandlesService, useValue: handles },
        {
          provide: StorageService,
          useValue: { deleteObjectByReference: jest.fn() },
        },
        {
          // No takedown by default; `assertNotTakenDown` sees an empty map.
          provide: ContentModerationService,
          useValue: contentModeration,
        },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        {
          // The activity privacy gate is read-only here and has its own spec.
          // Passing rows straight through keeps every existing assertion about
          // the activity section exactly as it was before the gate existed.
          provide: ActivityVisibilityService,
          useValue: {
            filterVisible: jest
              .fn()
              .mockImplementation((rows: unknown[]) => Promise.resolve(rows)),
          },
        },
        {
          // The coarse "recently active" band is read-only here and its own
          // spec covers it; a member with nothing recorded reads as no band,
          // which is the state every assertion in this file assumes.
          provide: LastActiveService,
          useValue: {
            getSignal: jest
              .fn()
              .mockResolvedValue({ band: null, isHidden: false }),
            getSignals: jest.fn().mockResolvedValue(new Map()),
          },
        },
        {
          // Its own spec covers the aggregate; every assertion in this file
          // is indifferent to `respondsWithin`, so a plain null default keeps
          // them all unaffected by its addition.
          provide: NowInsightsService,
          useValue: { getRespondsWithin: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();
    service = module.get(ProfilesService);
  });

  it('404s an unknown slug', async () => {
    profiles.findOne.mockResolvedValue(null);
    await expect(service.getBySlug('nope', 'v1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  describe('PRD-204 renamed-username forwarding', () => {
    it('answers PROFILE_MOVED with the current slug for a handle still in its reclaim cooldown', async () => {
      // First lookup is by the old slug (gone), second is the former owner by
      // userId.
      profiles.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(profile({ slug: 'jo-new' }));
      handles.previousProfileOwnerOf.mockResolvedValue('owner-1');
      await expect(service.getBySlug('jo', 'viewer')).rejects.toMatchObject({
        response: { code: 'PROFILE_MOVED', slug: 'jo-new' },
      });
      expect(handles.previousProfileOwnerOf).toHaveBeenCalledWith('jo');
    });

    it('gives the plain 404 once the cooldown has lapsed or someone else holds the name', async () => {
      // `previousProfileOwnerOf` is the single place that decision is made, and
      // it answers null in both cases.
      profiles.findOne.mockResolvedValue(null);
      handles.previousProfileOwnerOf.mockResolvedValue(null);
      await expect(service.getBySlug('jo', 'viewer')).rejects.toMatchObject({
        response: { message: 'Profile not found' },
      });
    });

    it('never reveals a move to a viewer the former owner has blocked', async () => {
      profiles.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(profile({ slug: 'jo-new' }));
      handles.previousProfileOwnerOf.mockResolvedValue('owner-1');
      blockFilter.isBlockedEitherWay.mockResolvedValue(true);
      await expect(service.getBySlug('jo', 'viewer')).rejects.toMatchObject({
        response: { message: 'Profile not found' },
      });
    });
  });

  it('returns the full profile for an open profile to any viewer', async () => {
    profiles.findOne.mockResolvedValue(
      profile({ visibility: ProfileVisibility.Open }),
    );
    const res = await service.getBySlug('jo', 'someone-else');
    expect(res.limited).toBe(false);
    expect((res as { bio: string }).bio).toBe('longform');
    // Private Interests fields stay hidden from a non-owner viewer.
    const full = res as Extract<typeof res, { limited: false }>;
    expect(full.identities).toEqual([]);
    expect(full.lookingFor).toEqual([]);
    // privateNetwork is a private preference — omitted entirely, not just
    // false, for a non-owner viewer.
    expect(full).not.toHaveProperty('privateNetwork');
  });

  it('returns a limited card for a private profile to a non-owner', async () => {
    profiles.findOne.mockResolvedValue(
      profile({ visibility: ProfileVisibility.Private }),
    );
    const res = await service.getBySlug('jo', 'someone-else');
    expect(res.limited).toBe(true);
    expect((res as unknown as Record<string, unknown>).bio).toBeUndefined();
  });

  it('returns the full profile to the owner regardless of visibility', async () => {
    profiles.findOne.mockResolvedValue(
      profile({ visibility: ProfileVisibility.Private }),
    );
    const res = await service.getBySlug('jo', 'owner-1');
    expect(res.limited).toBe(false);
    // The owner gets their private Interests fields back.
    const full = res as Extract<typeof res, { limited: false }>;
    expect(full.identities).toEqual(['Queer']);
    expect(full.lookingFor).toEqual(['Community & friendship']);
  });

  it('treats network as limited for a non-owner (until Phase 6 connections)', async () => {
    profiles.findOne.mockResolvedValue(
      profile({ visibility: ProfileVisibility.Network }),
    );
    const res = await service.getBySlug('jo', 'someone-else');
    expect(res.limited).toBe(true);
  });

  it('returns the full network profile to an accepted connection', async () => {
    profiles.findOne.mockResolvedValue(
      profile({ visibility: ProfileVisibility.Network }),
    );
    connections.areConnected.mockResolvedValue(true);
    const res = await service.getBySlug('jo', 'someone-else');
    expect(res.limited).toBe(false);
  });

  describe('unlisted work (adultWork) visibility on the full profile', () => {
    // Coordinator ruling 15: unlisted (`adultWork`) work shows on the full
    // profile only to the owner and to the owner's accepted connections,
    // whatever the profile's `visibility` tier says. An `open` profile is
    // otherwise full to every signed-in member (see `canViewFull`), which
    // would make the member directory a slug sweep away from rebuilding the
    // list this feature exists to prevent. See
    // professions.ts#UNLISTED_DISCIPLINE_IDS.
    const sexWorkerProfile = (overrides = {}) =>
      profile({
        discipline: ['healthcare', 'adultWork'],
        profession: ['nurse', 'sexWorker'],
        ...overrides,
      });

    it('strips adultWork/sexWorker from an open profile for a non-connected viewer', async () => {
      profiles.findOne.mockResolvedValue(
        sexWorkerProfile({ visibility: ProfileVisibility.Open }),
      );
      const res = await service.getBySlug('jo', 'someone-else');
      const full = res as Extract<typeof res, { limited: false }>;
      expect(full.discipline).toEqual(['healthcare']);
      expect(full.profession).toEqual(['nurse']);
    });

    it('keeps adultWork/sexWorker on an open profile for an accepted connection', async () => {
      profiles.findOne.mockResolvedValue(
        sexWorkerProfile({ visibility: ProfileVisibility.Open }),
      );
      connections.areConnected.mockResolvedValue(true);
      const res = await service.getBySlug('jo', 'someone-else');
      const full = res as Extract<typeof res, { limited: false }>;
      expect(full.discipline).toEqual(['healthcare', 'adultWork']);
      expect(full.profession).toEqual(['nurse', 'sexWorker']);
    });

    it('keeps adultWork/sexWorker for the owner without ever calling areConnected', async () => {
      profiles.findOne.mockResolvedValue(
        sexWorkerProfile({ visibility: ProfileVisibility.Open }),
      );
      // The owner reads their own profile through the same getBySlug path
      // `getMine` delegates to; `viewerUserId` equal to the profile's
      // `userId` ('owner-1', see the `profile` factory above) is that case.
      const res = await service.getBySlug('jo', 'owner-1');
      const full = res as Extract<typeof res, { limited: false }>;
      expect(full.discipline).toEqual(['healthcare', 'adultWork']);
      expect(full.profession).toEqual(['nurse', 'sexWorker']);
      expect(connections.areConnected).not.toHaveBeenCalled();
    });

    it('never calls areConnected for a profile with no unlisted work', async () => {
      profiles.findOne.mockResolvedValue(
        profile({ visibility: ProfileVisibility.Open }),
      );
      await service.getBySlug('jo', 'someone-else');
      // `hasUnlistedWork` short-circuits the connection lookup for the
      // overwhelming majority of profiles that never selected `adultWork`,
      // so an ordinary profile read costs no extra query.
      expect(connections.areConnected).not.toHaveBeenCalled();
    });
  });

  it('assembles the full profile with new relations and ISO joinedAt', async () => {
    profiles.findOne.mockResolvedValue(
      profile({ visibility: ProfileVisibility.Open }),
    );
    const res = await service.getBySlug('jo', 'viewer');
    expect(res.limited).toBe(false);
    const full = res as Extract<typeof res, { limited: false }>;
    expect(full.joinedAt).toBe('2024-03-01T00:00:00.000Z');
    expect(full.now).toBe('now text');
    expect(full.skills).toEqual([]);
    expect(full.board).toEqual([]);
    expect(full.groups).toEqual([]);
    expect(full.activity).toEqual([]);
    expect(full.related).toEqual([]);
  });

  it('skips the related-members query when the member has no tags or location', async () => {
    profiles.findOne.mockResolvedValue(
      profile({ tags: [], location: null, visibility: ProfileVisibility.Open }),
    );
    await service.getBySlug('jo', 'viewer');
    // loadRelated short-circuits: profiles.createQueryBuilder is only ever
    // called for related members, so with no tags/location it is never called.
    expect(profiles.createQueryBuilder).not.toHaveBeenCalled();
  });

  describe('loadRelated photoVisible gate', () => {
    // `related` excludes the PROFILE OWNER (`p.user_id != :self`) but not the
    // VIEWER — a related member (matched by shared tags) can legitimately be
    // the person looking at this page. They must see their own real photo
    // regardless of their own `photoVisible` toggle; anyone else's related
    // card is gated like every other non-owner card.
    it("hides a related member's photo when they turned photoVisible off", async () => {
      profiles.findOne.mockResolvedValue(
        profile({ tags: ['queer'], visibility: ProfileVisibility.Open }),
      );
      const qb = qbStub();
      qb.getMany.mockResolvedValue([
        profile({
          userId: 'someone-else',
          slug: 'other',
          tags: ['queer'],
          avatarUrl: 'https://x/other.png',
          photoVisible: false,
        }),
      ]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      const res = await service.getBySlug('jo', 'viewer-1');
      const full = res as Extract<typeof res, { limited: false }>;
      expect(full.related[0]?.avatarUrl).toBeNull();
    });

    it('shows the viewer their own real photo when they turn up in their own related list', async () => {
      profiles.findOne.mockResolvedValue(
        profile({ tags: ['queer'], visibility: ProfileVisibility.Open }),
      );
      const qb = qbStub();
      qb.getMany.mockResolvedValue([
        profile({
          userId: 'viewer-1',
          slug: 'me',
          tags: ['queer'],
          avatarUrl: 'https://x/me.png',
          photoVisible: false,
        }),
      ]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      const res = await service.getBySlug('jo', 'viewer-1');
      const full = res as Extract<typeof res, { limited: false }>;
      expect(full.related[0]?.avatarUrl).toBe('https://x/me.png');
    });
  });

  describe('loadBoardResponses visibility gate (Task 5 fix round 2)', () => {
    const boardPost = {
      id: 'post-1',
      userId: 'owner-1',
      kind: BoardKind.Looking,
      title: 'A collaborator for a queer zine',
      slug: 'zine-collab',
      status: BoardPostStatus.Open,
      position: 0,
      closedNote: null,
      closedAt: null,
      expiresAt: new Date('2026-09-15T00:00:00.000Z'),
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      tags: ['Illustration'],
      renewedAt: null,
      renewCount: 0,
    } as BoardPost;

    it('gates board responders by the ACTUAL VIEWER, not the profile owner, and drops takedowns before counting', async () => {
      profiles.findOne.mockResolvedValue(
        profile({ visibility: ProfileVisibility.Open }),
      );
      boardPosts.find.mockResolvedValue([boardPost]);
      const qb = qbStub();
      qb.getRawMany.mockResolvedValue([
        {
          post_id: 'post-1',
          kind: 'help',
          created_at: new Date('2026-08-15T00:00:00.000Z'),
          slug: 'beatriz',
          first: 'Beatriz',
          avatar_url: null,
          photo_visible: true,
          user_id: 'beatriz-user-id',
        },
      ]);
      boardResponses.createQueryBuilder = jest.fn().mockReturnValue(qb);
      // The one responder row above has been taken down by a moderator.
      contentModeration.statesForAnyType.mockResolvedValue(
        new Map([['beatriz-user-id', { hidden: true, removed: false }]]),
      );

      const res = await service.getBySlug('jo', 'viewer-1');

      // The single assertion that catches an owner-for-viewer swap: this MUST
      // be called with 'viewer-1' (the actual caller), not 'owner-1' (the
      // profile owner `jo` resolves to) — a swap here would gate a
      // responder's visibility against the wrong person entirely.
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        qb,
        'viewer-1',
        '"profile"."user_id"',
      );

      // Takedown runs BEFORE the response is counted, not after: the one
      // response above is from a taken-down member, so it must not inflate
      // `responseCount`/`helloCount` or appear in `responders`.
      const full = res as Extract<typeof res, { limited: false }>;
      expect(full.board[0]!.responseCount).toBe(0);
      expect(full.board[0]!.helloCount).toBe(0);
      expect(full.board[0]!.responders).toEqual([]);
    });
  });

  describe('account-status gate (ENG-435)', () => {
    it('asks whether the owner account is active with the shared status predicate', async () => {
      profiles.findOne.mockResolvedValue(profile());
      await service.getBySlug('jo', 'someone-else');
      expect(profiles.exists).toHaveBeenCalledWith({
        where: { userId: 'owner-1', user: { status: 'active' } },
      });
    });

    it('404s a deactivated, pending-deletion or suspended member for another viewer, same as the other gates', async () => {
      profiles.findOne.mockResolvedValue(profile());
      profiles.exists.mockResolvedValue(false);
      await expect(
        service.getBySlug('jo', 'someone-else'),
      ).rejects.toMatchObject({
        response: { message: 'Profile not found' },
      });
    });

    it('lets platform staff open an inactive member, same exemption as the takedown gate', async () => {
      profiles.findOne.mockResolvedValue(profile());
      profiles.exists.mockResolvedValue(false);
      for (const role of ['moderator', 'admin']) {
        const res = await service.getBySlug('jo', 'staff-1', role);
        expect(res.limited).toBe(false);
      }
      // Staff short-circuit the gate before any status read.
      expect(profiles.exists).not.toHaveBeenCalled();
    });

    it('still 404s a regular member on an inactive profile', async () => {
      profiles.findOne.mockResolvedValue(profile());
      profiles.exists.mockResolvedValue(false);
      await expect(
        service.getBySlug('jo', 'member-1', 'member'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s findBySlugOrThrow, so the mutuals and vouchers routes inherit the gate', async () => {
      profiles.findOne.mockResolvedValue(profile());
      profiles.exists.mockResolvedValue(false);
      await expect(
        service.findBySlugOrThrow('jo', 'someone-else'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('still returns the full profile to the owner and skips the status read', async () => {
      profiles.findOne.mockResolvedValue(profile());
      profiles.exists.mockResolvedValue(false);
      const res = await service.getBySlug('jo', 'owner-1');
      expect(res.limited).toBe(false);
      expect(profiles.exists).not.toHaveBeenCalled();
    });

    it('never reveals a move for a former owner who has since deactivated', async () => {
      profiles.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(profile({ slug: 'jo-new' }));
      handles.previousProfileOwnerOf.mockResolvedValue('owner-1');
      profiles.exists.mockResolvedValue(false);
      await expect(service.getBySlug('jo', 'viewer')).rejects.toMatchObject({
        response: { message: 'Profile not found' },
      });
    });
  });

  describe('hiddenUntil self-hide gate (member profile v2 Task 6)', () => {
    it('404s a non-owner viewer while hiddenUntil is still in the future', async () => {
      profiles.findOne.mockResolvedValue(
        profile({ hiddenUntil: new Date(Date.now() + 60_000) }),
      );
      await expect(
        service.getBySlug('jo', 'someone-else'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('still returns the full profile to the owner regardless of hiddenUntil', async () => {
      profiles.findOne.mockResolvedValue(
        profile({ hiddenUntil: new Date(Date.now() + 60_000) }),
      );
      const res = await service.getBySlug('jo', 'owner-1');
      expect(res.limited).toBe(false);
    });

    it('leaves a non-owner viewer unaffected once hiddenUntil is in the past', async () => {
      profiles.findOne.mockResolvedValue(
        profile({ hiddenUntil: new Date(Date.now() - 60_000) }),
      );
      const res = await service.getBySlug('jo', 'someone-else');
      expect(res.limited).toBe(false);
    });

    it('leaves a non-owner viewer unaffected when hiddenUntil is null', async () => {
      profiles.findOne.mockResolvedValue(profile({ hiddenUntil: null }));
      const res = await service.getBySlug('jo', 'someone-else');
      expect(res.limited).toBe(false);
    });
  });

  it('updateMe writes now and returns the full profile', async () => {
    const p = profile({ visibility: ProfileVisibility.Open });
    profiles.findOne.mockResolvedValue(p);
    (profiles as unknown as { save: jest.Mock }).save = jest
      .fn()
      .mockResolvedValue(p);
    const res = await service.updateMe('owner-1', {
      now: 'new now',
      identities: ['Trans'],
      lookingFor: ['Creative collaboration'],
    });
    expect(p.now).toBe('new now');
    expect(p.identities).toEqual(['Trans']);
    expect(res.limited).toBe(false);
    const full = res;
    expect(full.now).toBe('new now');
    // updateMe is always the owner, so private fields come back.
    expect(full.identities).toEqual(['Trans']);
    expect(full.lookingFor).toEqual(['Creative collaboration']);
  });

  it('updateMe persists privateNetwork and returns it on the owner profile', async () => {
    const p = profile({ visibility: ProfileVisibility.Open });
    profiles.findOne.mockResolvedValue(p);
    (profiles as unknown as { save: jest.Mock }).save = jest
      .fn()
      .mockResolvedValue(p);

    const res = await service.updateMe('owner-1', { privateNetwork: true });

    expect(p.privateNetwork).toBe(true);
    const full = res;
    expect(full.privateNetwork).toBe(true);
  });

  it('updateMe clears now when sent an empty string', async () => {
    const p = profile({ now: 'old status' });
    profiles.findOne.mockResolvedValue(p);
    (profiles as unknown as { save: jest.Mock }).save = jest
      .fn()
      .mockResolvedValue(p);

    const res = await service.updateMe('owner-1', { now: '' });

    expect(p.now).toBeNull();
    const full = res;
    expect(full.now).toBeNull();
  });

  it('updateMe leaves now untouched when the field is omitted', async () => {
    const untouchedNowUpdatedAt = new Date('2026-01-01T00:00:00.000Z');
    const p = profile({
      now: 'old status',
      nowUpdatedAt: untouchedNowUpdatedAt,
    });
    profiles.findOne.mockResolvedValue(p);
    (profiles as unknown as { save: jest.Mock }).save = jest
      .fn()
      .mockResolvedValue(p);

    await service.updateMe('owner-1', { tagline: 'new tagline' });

    expect(p.now).toBe('old status');
    // Proves the stamp is genuinely left alone rather than both sides just
    // being undefined: `now` omitted means the whole branch is skipped, so
    // nowUpdatedAt must still read the date it carried before the call.
    expect(p.nowUpdatedAt).toEqual(untouchedNowUpdatedAt);
  });

  describe('updateMe now history', () => {
    // TypeORM would hand `dataSource.transaction` a real EntityManager. This
    // captures every entity the service saves through it, keeping a profile
    // save apart from an archived-status save by shape rather than by call
    // order, so a test does not need to assume how many saves happen first.
    let savedHistoryRows: ProfileNowHistory[];

    const captureHistoryTransaction = () => {
      savedHistoryRows = [];
      dataSource.transaction = jest.fn(
        async (fn: (manager: { save: jest.Mock }) => Promise<void>) => {
          const manager = {
            save: jest.fn((entity: unknown) => {
              if (entity && typeof entity === 'object' && 'text' in entity) {
                savedHistoryRows.push(entity as ProfileNowHistory);
              }
              return Promise.resolve(entity);
            }),
          };
          await fn(manager);
        },
      );
    };

    it('archives the outgoing status and stamps nowUpdatedAt', async () => {
      captureHistoryTransaction();
      const oldNowUpdatedAt = new Date('2026-01-01T00:00:00.000Z');
      const p = profile({ now: 'Old status', nowUpdatedAt: oldNowUpdatedAt });
      profiles.findOne.mockResolvedValue(p);

      await service.updateMe('owner-1', { now: 'New status' });

      expect(savedHistoryRows).toHaveLength(1);
      expect(savedHistoryRows[0]).toMatchObject({
        userId: 'owner-1',
        text: 'Old status',
        startedAt: oldNowUpdatedAt,
      });
      expect(p.now).toBe('New status');
      expect(p.nowUpdatedAt).not.toEqual(oldNowUpdatedAt);
    });

    it('writes nothing when the status is unchanged, including when only surrounding whitespace differs', async () => {
      captureHistoryTransaction();
      const oldNowUpdatedAt = new Date('2026-01-01T00:00:00.000Z');
      const p = profile({ now: 'Same status', nowUpdatedAt: oldNowUpdatedAt });
      profiles.findOne.mockResolvedValue(p);
      (profiles as unknown as { save: jest.Mock }).save = jest
        .fn()
        .mockResolvedValue(p);

      await service.updateMe('owner-1', { now: '  Same status  ' });

      expect(savedHistoryRows).toHaveLength(0);
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(p.nowUpdatedAt).toEqual(oldNowUpdatedAt);
    });

    it('archives the old status when the member clears it', async () => {
      captureHistoryTransaction();
      // nowUpdatedAt is deliberately left unset here: this is the one test
      // that exercises the startedAt fallback to profile.createdAt, so
      // createdAt must be seeded and asserted on, or a swapped operand (or a
      // wrong field entirely) would still pass.
      const createdAt = new Date('2025-06-01T00:00:00.000Z');
      const p = profile({ now: 'Old status', createdAt });
      profiles.findOne.mockResolvedValue(p);

      await service.updateMe('owner-1', { now: '' });

      expect(savedHistoryRows).toHaveLength(1);
      expect(savedHistoryRows[0]?.text).toBe('Old status');
      expect(savedHistoryRows[0]?.startedAt).toEqual(createdAt);
      expect(p.now).toBeNull();
    });

    it('archives nothing when the member had no status', async () => {
      captureHistoryTransaction();
      const p = profile({ now: null });
      profiles.findOne.mockResolvedValue(p);
      (profiles as unknown as { save: jest.Mock }).save = jest
        .fn()
        .mockResolvedValue(p);

      await service.updateMe('owner-1', { now: 'First status' });

      expect(savedHistoryRows).toHaveLength(0);
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(p.nowUpdatedAt).toBeInstanceOf(Date);
    });
  });

  // Same explicit `!== undefined` clearing shape as `now` above, for the
  // three Task 2 text fields.
  it.each([
    ['pronunciation', 'old pronunciation'],
    ['bioPt', 'old bioPt'],
    ['notHereFor', 'old notHereFor'],
  ] as const)(
    'updateMe clears %s when sent an empty string, and leaves it when omitted',
    async (field, oldValue) => {
      const p = profile({ [field]: oldValue });
      profiles.findOne.mockResolvedValue(p);
      (profiles as unknown as { save: jest.Mock }).save = jest
        .fn()
        .mockResolvedValue(p);

      await service.updateMe('owner-1', { [field]: '' });
      expect(p[field]).toBeNull();

      const p2 = profile({ [field]: oldValue });
      profiles.findOne.mockResolvedValue(p2);
      (profiles as unknown as { save: jest.Mock }).save = jest
        .fn()
        .mockResolvedValue(p2);
      await service.updateMe('owner-1', { tagline: 'new tagline' });
      expect(p2[field]).toBe(oldValue);
    },
  );

  it('updateMe stores hiddenUntil as a Date and clears it on null', async () => {
    const p = profile({ hiddenUntil: null });
    profiles.findOne.mockResolvedValue(p);
    (profiles as unknown as { save: jest.Mock }).save = jest
      .fn()
      .mockResolvedValue(p);

    await service.updateMe('owner-1', {
      hiddenUntil: '2026-08-19T12:00:00.000Z',
    });
    expect(p.hiddenUntil).toEqual(new Date('2026-08-19T12:00:00.000Z'));

    await service.updateMe('owner-1', { hiddenUntil: null });
    expect(p.hiddenUntil).toBeNull();
  });

  // Regression: onboarding sends ONLY `lookingFor`. Run that body through the
  // real production transform (the global ValidationPipe's options) so the DTO
  // updateMe receives is byte-for-byte what the controller gets — then feed it
  // in. Before `exposeUnsetFields: false`, class-transformer materialised every
  // omitted field as an own `undefined` key, `Object.assign(profile, rest)`
  // clobbered the hydrated `tags: []` with `undefined`, and buildFullProfile ->
  // loadRelated threw "Cannot read properties of undefined (reading 'length')".
  it('updateMe does not clobber untouched columns when a partial DTO is sent through the real transform', async () => {
    // The transformed DTO must not carry omitted fields at all — this is the
    // exact behaviour the fix depends on, asserted up front for a clear signal.
    const dto = plainToInstance(
      UpdateProfileDto,
      { lookingFor: ['Community'] },
      VALIDATION_PIPE_OPTIONS.transformOptions,
    );
    expect(Object.prototype.hasOwnProperty.call(dto, 'tags')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(dto, 'location')).toBe(false);

    const p = profile({
      tags: ['queer', 'lisbon'],
      location: 'Lisbon',
      lookingFor: [],
      visibility: ProfileVisibility.Open,
    });
    profiles.findOne.mockResolvedValue(p);
    (profiles as unknown as { save: jest.Mock }).save = jest
      .fn()
      .mockResolvedValue(p);

    // Must not throw, and must apply lookingFor while leaving tags/location intact.
    const res = await service.updateMe('owner-1', dto);

    expect(p.tags).toEqual(['queer', 'lisbon']);
    expect(p.location).toBe('Lisbon');
    expect(p.lookingFor).toEqual(['Community']);
    expect(res.limited).toBe(false);
  });

  it('updateMe replaces openTo wholesale and keeps custom labels verbatim', async () => {
    const p = profile({ openTo: [{ kind: 'preset', id: 'swaps' }] });
    profiles.findOne.mockResolvedValue(p);
    (profiles as unknown as { save: jest.Mock }).save = jest
      .fn()
      .mockResolvedValue(p);

    const res = await service.updateMe('owner-1', {
      openTo: [
        { kind: 'preset', id: 'mentoring' },
        { kind: 'custom', label: 'A nurse or two for the testing nights' },
      ],
    });

    // A REPLACE, not a merge: the previous `swaps` chip is gone.
    expect(p.openTo).toEqual([
      { kind: 'preset', id: 'mentoring' },
      { kind: 'custom', label: 'A nurse or two for the testing nights' },
    ]);
    const full = res;
    expect(full.openTo).toEqual([
      { kind: 'preset', id: 'mentoring' },
      { kind: 'custom', label: 'A nurse or two for the testing nights' },
    ]);
  });

  it('updateMe clears openTo when sent an empty list', async () => {
    const p = profile({ openTo: [{ kind: 'preset', id: 'swaps' }] });
    profiles.findOne.mockResolvedValue(p);
    (profiles as unknown as { save: jest.Mock }).save = jest
      .fn()
      .mockResolvedValue(p);

    await service.updateMe('owner-1', { openTo: [] });

    expect(p.openTo).toEqual([]);
  });

  it('updateMe normalizes openTo before saving', async () => {
    const p = profile();
    profiles.findOne.mockResolvedValue(p);
    (profiles as unknown as { save: jest.Mock }).save = jest
      .fn()
      .mockResolvedValue(p);

    await service.updateMe('owner-1', {
      openTo: [
        { kind: 'preset', id: 'mentoring' },
        { kind: 'preset', id: 'mentoring' },
        { kind: 'custom', label: '  Studio time  ' },
        { kind: 'custom', label: '   ' },
      ],
    });

    expect(p.openTo).toEqual([
      { kind: 'preset', id: 'mentoring' },
      { kind: 'custom', label: 'Studio time' },
    ]);
  });

  describe('visibleMemberIds (ENG-436 vouchers roster)', () => {
    it('answers a whole batch in one query with every directory gate', async () => {
      const qb = qbStub();
      qb.getRawMany.mockResolvedValue([{ user_id: 'v2' }]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      const visible = await service.visibleMemberIds('viewer-1', [
        'v1',
        'v2',
        'v1',
      ]);

      expect(visible).toEqual(new Set(['v2']));
      expect(profiles.createQueryBuilder).toHaveBeenCalledTimes(1);
      // Active accounts only.
      expect(qb.innerJoin).toHaveBeenCalledWith(
        'p.user',
        'u',
        'u.status = :active',
        { active: 'active' },
      );
      // The batch, de-duplicated.
      expect(qb.where).toHaveBeenCalledWith(
        'p.user_id IN (:...visibleCandidateIds)',
        { visibleCandidateIds: ['v1', 'v2'] },
      );
      // Block either way, scoped to the viewer.
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        qb,
        'viewer-1',
        '"p"."user_id"',
      );
      const predicates = (
        qb.andWhere as jest.Mock<unknown, unknown[]>
      ).mock.calls.map((call: unknown[]) => String(call[0]));
      // The 24h hide and the moderator takedown.
      expect(
        predicates.some((predicate) => predicate.includes('hidden_until')),
      ).toBe(true);
      expect(
        predicates.some((predicate) =>
          predicate.includes('content_moderation'),
        ),
      ).toBe(true);
    });

    it('skips the query for an empty batch', async () => {
      const visible = await service.visibleMemberIds('viewer-1', []);
      expect(visible.size).toBe(0);
      expect(profiles.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('loadMutualVoucherCount vouchers-roster boundary (M2)', () => {
    it('does not count a named voucher the vouchers roster would hide from this viewer', async () => {
      profiles.findOne.mockResolvedValue(
        profile({
          visibility: ProfileVisibility.Private,
          vouchersVisible: true,
        }),
      );
      vouchService.getNamedVoucherIds.mockResolvedValue([
        'hidden-1',
        'visible-1',
      ]);
      const qb = qbStub();
      // Only `visible-1` clears the vouchers-roster gates (account status,
      // block, hidden-from, 24h hide, takedown) for this viewer.
      qb.getRawMany.mockResolvedValue([{ user_id: 'visible-1' }]);
      profiles.createQueryBuilder.mockReturnValue(qb);
      // Both read as accepted connections, so the roster gate alone must
      // drop `hidden-1` from the count.
      connections.acceptedConnectionsAmong.mockResolvedValue(
        new Set(['hidden-1', 'visible-1']),
      );

      const res = await service.getBySlug('jo', 'viewer-1');

      expect((res as { mutualVoucherCount: number }).mutualVoucherCount).toBe(
        1,
      );
      expect(connections.acceptedConnectionsAmong).toHaveBeenCalledWith(
        'viewer-1',
        ['visible-1'],
      );
    });

    it('returns 0 without a connections lookup when every named voucher is hidden from this viewer', async () => {
      profiles.findOne.mockResolvedValue(
        profile({
          visibility: ProfileVisibility.Private,
          vouchersVisible: true,
        }),
      );
      vouchService.getNamedVoucherIds.mockResolvedValue([
        'hidden-1',
        'hidden-2',
      ]);
      const qb = qbStub();
      qb.getRawMany.mockResolvedValue([]);
      profiles.createQueryBuilder.mockReturnValue(qb);
      connections.acceptedConnectionsAmong.mockResolvedValue(
        new Set(['hidden-1', 'hidden-2']),
      );

      const res = await service.getBySlug('jo', 'viewer-1');

      expect((res as { mutualVoucherCount: number }).mutualVoucherCount).toBe(
        0,
      );
      expect(connections.acceptedConnectionsAmong).not.toHaveBeenCalled();
    });
  });

  describe('searchMembers', () => {
    it('drops moderator-taken-down members in SQL, keyed by slug or user id (ENG-437)', async () => {
      const qb = qbStub();
      qb.getManyAndCount.mockResolvedValue([[], 0]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      await service.searchMembers({}, 'viewer-1');

      const andWhereCalls: unknown[][] = (
        qb.andWhere as jest.Mock<unknown, unknown[]>
      ).mock.calls;
      const takedownCall = andWhereCalls.find(
        (call: unknown[]) =>
          typeof call[0] === 'string' && call[0].includes('content_moderation'),
      );
      expect(takedownCall).toBeDefined();
      const [predicate, parameters] = takedownCall as [
        string,
        Record<string, string>,
      ];
      expect(predicate).toContain('NOT EXISTS');
      expect(predicate).toContain('("p"."slug", "p"."user_id"::text)');
      // A removal withholds the member as well as a hide.
      expect(predicate).toContain('"hidden_at" IS NOT NULL');
      expect(predicate).toContain('"removed_at" IS NOT NULL');
      expect(parameters).toEqual({ memberTakedownSubjectType: 'member' });
      // Filtered in the query, so the page, the total and the facet counts
      // all agree, and no post-fetch lookup runs.
      expect(contentModeration.statesForAnyType).not.toHaveBeenCalled();
    });

    it('applies the takedown gate to every facet count query as well', async () => {
      const builders: ReturnType<typeof qbStub>[] = [];
      profiles.createQueryBuilder.mockImplementation(() => {
        const qb = qbStub();
        builders.push(qb);
        return qb;
      });

      await service.searchMembers({}, 'viewer-1');

      // The page query plus one per facet group, each built by
      // `directoryBaseQuery`.
      expect(builders.length).toBeGreaterThan(1);
      for (const qb of builders) {
        const hasTakedownGate = (
          qb.andWhere as jest.Mock<unknown, unknown[]>
        ).mock.calls.some(
          (call: unknown[]) =>
            typeof call[0] === 'string' &&
            call[0].includes('content_moderation'),
        );
        expect(hasTakedownGate).toBe(true);
      }
    });

    it('applies excludeBlocked scoped to the viewer and the p.user_id column', async () => {
      const qb = qbStub();
      qb.getManyAndCount.mockResolvedValue([[], 0]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      await service.searchMembers({}, 'viewer-1');

      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        qb,
        'viewer-1',
        '"p"."user_id"',
      );
    });

    it('searches the bio and the Portuguese bio, accent-folded and ranked (SOC-08)', async () => {
      const qb = qbStub();
      qb.getManyAndCount.mockResolvedValue([[], 0]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      await service.searchMembers({ query: 'sao' }, 'viewer-1');

      const andWhereCalls: unknown[][] = (
        qb.andWhere as jest.Mock<unknown, unknown[]>
      ).mock.calls;
      const searchCall = andWhereCalls.find(
        (call: unknown[]) =>
          typeof call[0] === 'string' &&
          call[0].includes('websearch_to_tsquery'),
      );
      expect(searchCall).toBeDefined();
      const [predicate, parameters] = searchCall as [
        string,
        Record<string, string>,
      ];
      // Both bios reach the haystack — member search used to skip them.
      expect(predicate).toContain('"p"."bio"');
      expect(predicate).toContain('"p"."bio_pt"');
      // Accent folding on BOTH sides, so "sao" finds "São".
      expect(predicate).toContain('translate(lower(');
      // The substring branch survives alongside full text, so "trans" still
      // finds "transfeminine".
      expect(predicate).toContain('LIKE');
      expect(parameters.memberSearchTerm).toBe('sao');
      expect(parameters.memberSearchPattern).toBe('%sao%');
    });

    it('orders by relevance when a term is given and no sort was chosen', async () => {
      const qb = qbStub();
      qb.getManyAndCount.mockResolvedValue([[], 0]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      await service.searchMembers({ query: 'sao' }, 'viewer-1');

      expect(qb.addSelect).toHaveBeenCalledWith(
        expect.stringContaining('ts_rank'),
        'member_search_rank',
      );
      expect(qb.orderBy).toHaveBeenCalledWith('member_search_rank', 'DESC');
    });

    it('orders text hits first and then A to Z when the search carries profession ids', async () => {
      const qb = qbStub();
      qb.getManyAndCount.mockResolvedValue([[], 0]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      await service.searchMembers(
        {
          query: 'ana',
          searchProfessions: 'financialAnalyst',
          sort: MemberSort.AToZ,
        },
        'viewer-1',
      );

      expect(qb.addSelect).toHaveBeenCalledWith(
        expect.stringContaining('CASE WHEN'),
        'member_search_text_hit',
      );
      // The text-hit flag leads, and the chosen sort's keys follow it so
      // A to Z still decides the order inside each group.
      expect(qb.orderBy).toHaveBeenCalledTimes(1);
      expect(qb.orderBy).toHaveBeenCalledWith('member_search_text_hit', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledTimes(3);
      expect(qb.addOrderBy).toHaveBeenNthCalledWith(1, 'p.firstName', 'ASC');
      expect(qb.addOrderBy).toHaveBeenNthCalledWith(2, 'p.lastName', 'ASC');
      expect(qb.addOrderBy).toHaveBeenNthCalledWith(3, 'p.slug', 'ASC');
    });

    it('keeps A to Z exactly as it was when the search carries no profession ids', async () => {
      const qb = qbStub();
      qb.getManyAndCount.mockResolvedValue([[], 0]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      await service.searchMembers(
        { query: 'ana', sort: MemberSort.AToZ },
        'viewer-1',
      );

      expect(qb.addSelect).not.toHaveBeenCalledWith(
        expect.anything(),
        'member_search_text_hit',
      );
      expect(qb.orderBy).toHaveBeenCalledTimes(1);
      expect(qb.orderBy).toHaveBeenCalledWith('p.firstName', 'ASC');
      expect(qb.addOrderBy).toHaveBeenCalledTimes(2);
      expect(qb.addOrderBy).toHaveBeenNthCalledWith(1, 'p.lastName', 'ASC');
      expect(qb.addOrderBy).toHaveBeenNthCalledWith(2, 'p.slug', 'ASC');
    });

    it('keeps the newest-first default when there is no term to rank by', async () => {
      const qb = qbStub();
      qb.getManyAndCount.mockResolvedValue([[], 0]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      await service.searchMembers({}, 'viewer-1');

      expect(qb.orderBy).toHaveBeenCalledWith('p.joinedAt', 'DESC');
      expect(qb.addSelect).not.toHaveBeenCalledWith(
        expect.stringContaining('ts_rank'),
        'member_search_rank',
      );
    });

    it('takes a flat offset/limit from global search instead of the page window', async () => {
      const qb = qbStub();
      qb.getManyAndCount.mockResolvedValue([[], 0]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      await service.searchMembers({ query: 'sao' }, 'viewer-1', {
        offset: 50,
        limit: 11,
      });

      expect(qb.skip).toHaveBeenCalledWith(50);
      expect(qb.take).toHaveBeenCalledWith(11);
    });

    it('still applies every privacy gate when global search paginates deeply', async () => {
      const qb = qbStub();
      qb.getManyAndCount.mockResolvedValue([[], 0]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      await service.searchMembers({ query: 'sao' }, 'viewer-1', {
        offset: 50,
        limit: 11,
      });

      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        qb,
        'viewer-1',
        '"p"."user_id"',
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        '("p"."hidden_until" IS NULL OR "p"."hidden_until" <= now())',
      );
    });

    it("excludes members with a live hiddenUntil from every viewer's search, unconditionally (member profile v2 Task 6)", async () => {
      const qb = qbStub();
      qb.getManyAndCount.mockResolvedValue([[], 0]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      await service.searchMembers({}, 'viewer-1');

      // Unlike `excludeBlocked`/`excludeHiddenFrom` above, this predicate
      // takes no viewer parameter at all — it is spliced in verbatim and
      // applies to every candidate row regardless of who is searching.
      expect(qb.andWhere).toHaveBeenCalledWith(
        '("p"."hidden_until" IS NULL OR "p"."hidden_until" <= now())',
      );
    });

    it("hides another member's photo/hood on their card when they turned the toggle off", async () => {
      const p = profile({
        userId: 'someone-else',
        avatarUrl: 'https://x/a.png',
        location: 'Arroios',
        visibility: ProfileVisibility.Open,
        photoVisible: false,
        hoodVisible: false,
      });
      const qb = qbStub();
      qb.getManyAndCount.mockResolvedValue([[p], 1]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      const list = await service.searchMembers({}, 'viewer-1');
      expect(list.items[0]?.avatarUrl).toBeNull();
      expect(list.items[0]?.location).toBeNull();
      expect(list.items[0]?.hood).toBeNull();
      // The toggle itself is owner-only (ENG-444): another member's card
      // carries the gated photo and hood, and no flag saying they hid them.
      expect(list.items[0]).not.toHaveProperty('photoVisible');
    });

    // Directory search never excludes the viewer's own profile from their own
    // results (only blocked members are excluded — see the test above), so a
    // member CAN see their own row in their own search. When that happens
    // they must see their real photo/hood regardless of their own toggle.
    it('shows the viewer their own real photo/hood when their own card turns up in their own search, even with the toggle off', async () => {
      const p = profile({
        userId: 'viewer-1',
        avatarUrl: 'https://x/a.png',
        location: 'Arroios',
        visibility: ProfileVisibility.Open,
        photoVisible: false,
        hoodVisible: false,
      });
      const qb = qbStub();
      qb.getManyAndCount.mockResolvedValue([[p], 1]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      const list = await service.searchMembers({}, 'viewer-1');
      expect(list.items[0]?.avatarUrl).toBe('https://x/a.png');
      expect(list.items[0]?.location).toBe('Arroios');
    });

    it('serves the bio-derived blurb on the card, but the raw tagline on the profile', async () => {
      // The trap, end to end: one member, no short bio, a long bio. Their card
      // borrows the bio's opening so the directory isn't a grid of blank lines,
      // while GET /profiles/:slug must still say the short bio is empty —
      // otherwise the editor seeds its input with words they never wrote and a
      // Save silently commits them.
      const p = profile({ tagline: '', bio: LONG_BIO });
      const qb = qbStub();
      qb.getManyAndCount.mockResolvedValue([[p], 1]);
      profiles.createQueryBuilder.mockReturnValue(qb);
      profiles.findOne.mockResolvedValue(p);

      const list = await service.searchMembers({}, 'viewer-1');
      const firstItem = list.items[0];
      expect(firstItem?.tagline).toBe(truncateAtWord(LONG_BIO));
      expect(firstItem?.tagline?.endsWith('…')).toBe(true);
      expect(firstItem).not.toHaveProperty('bio');

      const detail = await service.getBySlug('jo', 'viewer-1');
      expect(detail.tagline).toBe('');
    });
  });

  describe('getMine', () => {
    it('resolves the caller own slug and returns the full profile', async () => {
      profiles.findOne.mockResolvedValue({ slug: 'tiago-costa', userId: 'u1' });
      const spy = jest
        .spyOn(service, 'getBySlug')
        .mockResolvedValue({ limited: false } as never);

      const res = await service.getMine('u1');

      expect(profiles.findOne).toHaveBeenCalledWith({
        where: { userId: 'u1' },
      });
      expect(spy).toHaveBeenCalledWith('tiago-costa', 'u1');
      expect(res).toEqual({ limited: false });
    });

    it('throws NotFound when the caller has no profile row', async () => {
      profiles.findOne.mockResolvedValue(null);
      await expect(service.getMine('u1')).rejects.toThrow(NotFoundException);
    });
  });
});

describe('ProfilesService replace-list endpoints', () => {
  let service: ProfilesService;
  const findEmpty = () => ({ find: jest.fn().mockResolvedValue([]) });
  type TxManager = {
    delete: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  const txDataSource = () => ({
    transaction: jest.fn(async (cb: (m: TxManager) => Promise<void>) => {
      await cb({
        delete: jest.fn(),
        create: jest.fn((_e: unknown, v: unknown) => v),
        save: jest.fn(),
      });
    }),
  });

  beforeEach(() => {
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  type RepoMock = {
    find?: jest.Mock;
    findOne?: jest.Mock;
    createQueryBuilder?: jest.Mock;
    save?: jest.Mock;
  };
  const build = async (overrides: {
    profiles?: RepoMock;
    skills?: RepoMock;
    shapings?: RepoMock;
    groups?: RepoMock;
    groupMemberships?: RepoMock;
    workItems?: RepoMock;
    communities?: RepoMock;
    featuredCommunities?: RepoMock;
    communityMembers?: RepoMock;
  }) => {
    const module = await Test.createTestingModule({
      providers: [
        ProfilesService,
        {
          provide: AmbassadorStatusService,
          useValue: { findActive: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: getRepositoryToken(Profile),
          useValue: overrides.profiles ?? {
            findOne: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
        { provide: getRepositoryToken(SocialLink), useValue: findEmpty() },
        {
          provide: getRepositoryToken(WorkItem),
          useValue: overrides.workItems ?? findEmpty(),
        },
        {
          provide: getRepositoryToken(Skill),
          useValue: overrides.skills ?? findEmpty(),
        },
        { provide: getRepositoryToken(BoardPost), useValue: findEmpty() },
        {
          provide: getRepositoryToken(BoardPostResponse),
          useValue: findEmpty(),
        },
        {
          provide: getRepositoryToken(Shaping),
          useValue: overrides.shapings ?? findEmpty(),
        },
        { provide: getRepositoryToken(Activity), useValue: findEmpty() },
        {
          provide: getRepositoryToken(Group),
          useValue: overrides.groups ?? findEmpty(),
        },
        {
          provide: getRepositoryToken(GroupMembership),
          useValue: overrides.groupMemberships ?? {
            ...findEmpty(),
            createQueryBuilder: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(ProfileFeaturedCommunity),
          useValue: overrides.featuredCommunities ?? {
            createQueryBuilder: jest.fn(() => qbStub()),
          },
        },
        {
          provide: getRepositoryToken(Community),
          useValue: overrides.communities ?? {
            createQueryBuilder: jest.fn(() => qbStub()),
          },
        },
        {
          provide: getRepositoryToken(CommunityMember),
          useValue: overrides.communityMembers ?? {
            createQueryBuilder: jest.fn(() => qbStub()),
          },
        },
        {
          provide: getRepositoryToken(ProfileNowHistory),
          useValue: { create: jest.fn((input: unknown) => input) },
        },
        { provide: DataSource, useValue: txDataSource() },
        {
          provide: VouchService,
          useValue: {
            getVouchCount: jest.fn().mockResolvedValue(0),
            getVouchCounts: jest.fn().mockResolvedValue(new Map()),
          },
        },
        { provide: ConnectionsService, useValue: { areConnected: jest.fn() } },
        {
          provide: BlockFilterService,
          useValue: {
            isBlockedEitherWay: jest.fn().mockResolvedValue(false),
            excludeBlocked: jest.fn((qb: unknown) => qb),
          },
        },
        {
          provide: HiddenFromService,
          useValue: {
            isHiddenFrom: jest.fn().mockResolvedValue(false),
            excludeHiddenFrom: jest.fn((qb: unknown) => qb),
          },
        },
        {
          provide: HandlesService,
          useValue: {
            rename: jest.fn(),
            // PRD-204: a missing slug asks the handle ledger whether it was
            // renamed away from. No reservation by default.
            previousProfileOwnerOf: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: StorageService,
          useValue: { deleteObjectByReference: jest.fn() },
        },
        {
          provide: ContentModerationService,
          useValue: {
            statesForAnyType: jest.fn().mockResolvedValue(new Map()),
          },
        },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        {
          // The activity privacy gate is read-only here and has its own spec.
          // Passing rows straight through keeps every existing assertion about
          // the activity section exactly as it was before the gate existed.
          provide: ActivityVisibilityService,
          useValue: {
            filterVisible: jest
              .fn()
              .mockImplementation((rows: unknown[]) => Promise.resolve(rows)),
          },
        },
        {
          // Same read-only stub as the module above: nothing recorded, so no
          // band, which is what every assertion in this file assumes.
          provide: LastActiveService,
          useValue: {
            getSignal: jest
              .fn()
              .mockResolvedValue({ band: null, isHidden: false }),
            getSignals: jest.fn().mockResolvedValue(new Map()),
          },
        },
        {
          // Same read-only stub as the module above: none of these
          // replace-list endpoints touch `respondsWithin`.
          provide: NowInsightsService,
          useValue: { getRespondsWithin: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();
    return module.get(ProfilesService);
  };

  it('replaceSkills persists and returns name/meta only', async () => {
    const skillsRepo = {
      find: jest.fn().mockResolvedValue([
        {
          id: 's1',
          userId: 'u1',
          name: 'Web dev',
          meta: 'React',
          position: 0,
        },
      ]),
    };
    service = await build({ skills: skillsRepo });
    const res = await service.replaceSkills('u1', [
      { name: 'Web dev', meta: 'React' },
    ]);
    expect(res).toEqual([{ name: 'Web dev', meta: 'React' }]);
  });

  it('replaceWork converts a stored image key to an API files URL on return', async () => {
    const key =
      'work/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000.png';
    const workItemsRepo = {
      find: jest.fn().mockResolvedValue([
        {
          id: 'w1',
          userId: 'u1',
          category: 'Dev',
          title: 'X',
          year: '2022',
          imageUrl: key,
          position: 0,
        },
      ]),
    };
    service = await build({ workItems: workItemsRepo });

    const res = await service.replaceWork('u1', [
      { category: 'Dev', title: 'X', year: '2022', imageUrl: key },
    ]);

    expect(res[0]?.imageUrl).toBe(`https://api.test/files/${key}`);
  });

  it('updateMe persists an uploaded avatar key to Profile.avatarUrl and returns it as a files URL', async () => {
    const key =
      'avatars/11111111-2222-3333-4444-555555555555/77777777-8888-9999-aaaa-bbbbbbbbbbbb.jpg';
    const p = {
      userId: 'u1',
      slug: 'jo',
      firstName: 'Jo',
      lastName: 'Lee',
      pronouns: null,
      tagline: null,
      bio: null,
      location: null,
      now: null,
      avatarUrl: null,
      visibility: ProfileVisibility.Open,
      openTo: [],
      identities: [],
      discoverableIdentities: [],
      lookingFor: [],
      tags: [],
      verified: false,
      joinedAt: new Date('2024-03-01T00:00:00.000Z'),
    } as unknown as Profile;
    const profilesRepo = {
      findOne: jest.fn().mockResolvedValue(p),
      createQueryBuilder: jest.fn(() => qbStub()),
      save: jest.fn().mockResolvedValue(p),
    };
    service = await build({
      profiles: profilesRepo,
      // buildFullProfile -> loadGroups needs a real chainable stub; the
      // default groupMemberships override only stubs `createQueryBuilder` as
      // a bare jest.fn(), which resolves to undefined and breaks the chain.
      groupMemberships: {
        find: jest.fn().mockResolvedValue([]),
        createQueryBuilder: jest.fn(() => qbStub()),
      },
    });

    const res = await service.updateMe('u1', { avatarUrl: key });

    // The DTO's avatarUrl rides in on `rest` via `Object.assign(profile, rest)`
    // — no dedicated service code, exactly like SubprofilesService.update.
    expect(p.avatarUrl).toBe(key);
    expect(profilesRepo.save).toHaveBeenCalledWith(p);
    expect(res.avatarUrl).toBe(`https://api.test/files/${key}`);
  });

  it('updateMe clears the avatar back to null when sent null', async () => {
    const p = {
      userId: 'u1',
      slug: 'jo',
      firstName: 'Jo',
      lastName: 'Lee',
      pronouns: null,
      tagline: null,
      bio: null,
      location: null,
      now: null,
      avatarUrl: 'avatars/11111111-2222-3333-4444-555555555555/old.jpg',
      visibility: ProfileVisibility.Open,
      openTo: [],
      identities: [],
      discoverableIdentities: [],
      lookingFor: [],
      tags: [],
      verified: false,
      joinedAt: new Date('2024-03-01T00:00:00.000Z'),
    } as unknown as Profile;
    const profilesRepo = {
      findOne: jest.fn().mockResolvedValue(p),
      createQueryBuilder: jest.fn(() => qbStub()),
      save: jest.fn().mockResolvedValue(p),
    };
    service = await build({
      profiles: profilesRepo,
      groupMemberships: {
        find: jest.fn().mockResolvedValue([]),
        createQueryBuilder: jest.fn(() => qbStub()),
      },
    });

    const res = await service.updateMe('u1', { avatarUrl: null });

    expect(p.avatarUrl).toBeNull();
    expect(res.avatarUrl).toBeNull();
  });

  it('replaceShapings rejects a duplicate kind with 400', async () => {
    service = await build({});
    const items = [
      { kind: ShapingKind.Film, title: 'A', note: 'x' },
      { kind: ShapingKind.Film, title: 'B', note: 'y' },
    ];
    await expect(service.replaceShapings('u1', items)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('replaceGroups rejects an unknown group slug with 400', async () => {
    const groups = { find: jest.fn().mockResolvedValue([]) }; // slug not found
    service = await build({ groups });
    await expect(
      service.replaceGroups('u1', [{ groupSlug: 'nope', role: 'Member' }]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('replaceGroups rejects a duplicate group slug with 400', async () => {
    const groups = {
      find: jest
        .fn()
        .mockResolvedValue([{ id: 'g1', slug: 'devs', name: 'Devs' }]),
    };
    service = await build({ groups });
    await expect(
      service.replaceGroups('u1', [
        { groupSlug: 'devs', role: 'Member' },
        { groupSlug: 'devs', role: 'Organiser' },
      ]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('updateMe rejects a space slug in featuredCommunities the same way it rejects an unknown one', async () => {
    const p = {
      userId: 'u1',
      slug: 'jo',
      firstName: 'Jo',
      lastName: 'Lee',
      pronouns: null,
      tagline: null,
      bio: null,
      location: null,
      now: null,
      avatarUrl: null,
      visibility: ProfileVisibility.Open,
      openTo: [],
      identities: [],
      discoverableIdentities: [],
      lookingFor: [],
      tags: [],
      verified: false,
      joinedAt: new Date('2024-03-01T00:00:00.000Z'),
    } as unknown as Profile;
    const profilesRepo = {
      findOne: jest.fn().mockResolvedValue(p),
      createQueryBuilder: jest.fn(() => qbStub()),
      save: jest.fn().mockResolvedValue(p),
    };
    const communityQueryBuilder = qbStub();
    const communitiesRepo = {
      createQueryBuilder: jest.fn(() => communityQueryBuilder),
    };
    // `topLevelOnly` drops a space's row from the eligibility query the same
    // way it would drop a row for a slug that never existed at all. The
    // stub's default `getRawMany` resolving `[]` is exactly that: no row
    // came back, so `resolveFeaturedCommunityIds` cannot tell "a space" apart
    // from "unknown", and neither can the member. Asserting on `andWhere`
    // below, alongside the rejection, proves the filter produced the empty
    // result; the stub's own default alone would give the same rejection.
    service = await build({
      profiles: profilesRepo,
      communities: communitiesRepo,
    });

    await expect(
      service.updateMe('u1', { featuredCommunities: ['a-space'] }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Unknown or ineligible community: a-space',
    });
    expect(communityQueryBuilder.andWhere).toHaveBeenCalledWith(
      'c.parent_id IS NULL',
    );
  });

  it('scopes loadFeaturedCommunities (the pin read) to top-level communities', async () => {
    const featuredCommunityQueryBuilder = qbStub();
    const featuredCommunitiesRepo = {
      createQueryBuilder: jest.fn(() => featuredCommunityQueryBuilder),
    };
    service = await build({ featuredCommunities: featuredCommunitiesRepo });

    // Private method, reached directly the way `updateMe`'s deep
    // `getBySlug`/`buildFullProfile` assembly reaches it, without wiring
    // every other batched read that assembly makes.
    await (
      service as unknown as {
        loadFeaturedCommunities: (userId: string) => Promise<unknown>;
      }
    ).loadFeaturedCommunities('u1');

    expect(featuredCommunityQueryBuilder.andWhere).toHaveBeenCalledWith(
      'c.parent_id IS NULL',
    );
  });

  it('scopes sharedCommunityNames to top-level communities', async () => {
    const membershipQueryBuilder = qbStub();
    const communityMembersRepo = {
      createQueryBuilder: jest.fn(() => membershipQueryBuilder),
    };
    service = await build({ communityMembers: communityMembersRepo });

    await (
      service as unknown as {
        sharedCommunityNames: (
          ownerUserId: string,
          otherIds: string[],
        ) => Promise<Map<string, string>>;
      }
    ).sharedCommunityNames('u1', ['u2']);

    expect(membershipQueryBuilder.andWhere).toHaveBeenCalledWith(
      'c.parent_id IS NULL',
    );
  });
});
