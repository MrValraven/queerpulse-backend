import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { PartnersService } from '../partners/partners.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { VolunteerOpportunityTeam } from './entities/volunteer-opportunity-team.entity';
import {
  OpportunityCause,
  OpportunityCommitLevel,
  OpportunityStatus,
  VolunteerOpportunity,
} from './entities/volunteer-opportunity.entity';
import {
  SignupStatus,
  VolunteerSignup,
} from './entities/volunteer-signup.entity';
import { VolunteeringService } from './volunteering.service';

// A chainable query-builder stub whose terminal methods resolve to empty
// results by default (mirrors `companies.service.spec.ts`'s `qbStub`).
const qbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'select',
    'addSelect',
    'innerJoin',
    'where',
    'andWhere',
    'groupBy',
    'addGroupBy',
    'orderBy',
    'skip',
    'take',
    'update',
    'set',
    'execute',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  qb.getMany = jest.fn().mockResolvedValue([]);
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  qb.getExists = jest.fn().mockResolvedValue(false);
  qb.execute = jest.fn().mockResolvedValue({ affected: 0 });
  return qb;
};

describe('VolunteeringService', () => {
  let service: VolunteeringService;
  let opportunities: {
    findOne: jest.Mock;
    exists: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let team: {
    find: jest.Mock;
    exists: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let signups: {
    count: jest.Mock;
    exists: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: {
    findOne: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let partnersService: { ownedIdBySlug: jest.Mock; refsByIds: jest.Mock };
  let communityMembership: {
    assertOwnerOrModBySlug: jest.Mock;
    isSubcommunity: jest.Mock;
    refsByIds: jest.Mock;
    ownerOrModCommunityIdsForUser: jest.Mock;
    isOwnerOrMod: jest.Mock;
  };
  let notificationsService: { create: jest.Mock };
  let contentModerationService: { stateFor: jest.Mock };
  let blockFilter: { blockedUserIds: jest.Mock };
  let managerFindOne: jest.Mock;

  const baseDto = {
    org: 'Queer Youth Collective',
    role: 'Mentor',
    causes: [OpportunityCause.Youth],
    commit: OpportunityCommitLevel.Low,
    time: '2 hrs / week',
    location: 'Lisbon',
    desc: 'Mentor queer youth.',
    spotsTotal: 3,
    applyRole: 'Volunteer Coordinator',
  };

  beforeEach(async () => {
    opportunities = {
      findOne: jest.fn(),
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((v: object) => v),
      // Synthesizes generated columns so a mapper reading them off a
      // `save()` result never sees `undefined` (the A4 lesson, mirrored from
      // `companies.service.spec.ts`/`jobs.service.spec.ts`).
      save: jest.fn((o: unknown) =>
        Promise.resolve({
          id: 'opp-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          ...(o as object),
        }),
      ),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    team = {
      find: jest.fn().mockResolvedValue([]),
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((v: object) => v),
      save: jest.fn((v: unknown) => Promise.resolve(v)),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    signups = {
      count: jest.fn().mockResolvedValue(0),
      exists: jest.fn().mockResolvedValue(false),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((v: object) => v),
      save: jest.fn((v: unknown) =>
        Promise.resolve({
          id: 'signup-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          ...(v as object),
        }),
      ),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    profiles = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    // Default: a partnerSlug names no partner (404), and no opportunity
    // carries a partner link, so every test that sends no partnerSlug never
    // reaches Partners. The partner-link tests override these per case.
    partnersService = {
      ownedIdBySlug: jest
        .fn()
        .mockRejectedValue(new NotFoundException('Partner not found')),
      refsByIds: jest.fn().mockResolvedValue(new Map()),
    };
    // Default: the poster owns or moderates any community slug they send and
    // no community link exists yet. The community-link tests override these
    // per case.
    communityMembership = {
      assertOwnerOrModBySlug: jest.fn().mockResolvedValue('community-1'),
      // Default: a top-level community. The space case overrides it.
      isSubcommunity: jest.fn().mockResolvedValue(false),
      refsByIds: jest.fn().mockResolvedValue(new Map()),
      // Default: the viewer holds standing nowhere, so `listMine` stays
      // poster-scoped and the applicant guards fall through to the poster
      // check. The community-tier tests override these per case.
      ownerOrModCommunityIdsForUser: jest.fn().mockResolvedValue([]),
      isOwnerOrMod: jest.fn().mockResolvedValue(false),
    };
    notificationsService = { create: jest.fn().mockResolvedValue(null) };
    // Default: every subject resolves visible (no takedown row), so the
    // existing tests exercise the un-moderated path unchanged. The
    // hidden/removed cases below override this per test.
    contentModerationService = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };
    // Default: the viewer is in no block with anyone, so every existing test
    // names the same members it always did. The ENG-474 cases override it.
    blockFilter = { blockedUserIds: jest.fn().mockResolvedValue(new Set()) };
    managerFindOne = jest.fn();

    // `manager.getRepository(Entity)` routes to the same mocks the outer
    // `@InjectRepository` tokens use, so assertions work whether the code
    // path runs inside the transaction or not — mirrors
    // `companies.service.spec.ts`. `manager.findOne` backs `signup()`'s
    // row-locked read, mirroring `rsvp.service.spec.ts`.
    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === VolunteerOpportunity) return opportunities;
        if (entity === VolunteerOpportunityTeam) return team;
        if (entity === VolunteerSignup) return signups;
        if (entity === Profile) return profiles;
        throw new Error(
          `unexpected entity in getRepository: ${String(entity)}`,
        );
      }),
      findOne: managerFindOne,
    };
    const dataSource = {
      transaction: jest.fn(
        async (cb: (m: typeof manager) => Promise<unknown>) => cb(manager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VolunteeringService,
        {
          provide: getRepositoryToken(VolunteerOpportunity),
          useValue: opportunities,
        },
        {
          provide: getRepositoryToken(VolunteerOpportunityTeam),
          useValue: team,
        },
        { provide: getRepositoryToken(VolunteerSignup), useValue: signups },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: DataSource, useValue: dataSource },
        { provide: PartnersService, useValue: partnersService },
        {
          provide: CommunityMembershipService,
          useValue: communityMembership,
        },
        { provide: NotificationsService, useValue: notificationsService },
        // `confirmCompletion` emits `VOLUNTEER_SESSION_COMPLETED` on the
        // global bus; `EventEmitterModule.forRoot()` is not in this testing
        // module, so the token has to be provided explicitly.
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: ContentModerationService,
          useValue: contentModerationService,
        },
        { provide: BlockFilterService, useValue: blockFilter },
      ],
    }).compile();
    service = module.get(VolunteeringService);
  });

  describe('create', () => {
    it('stores partnerId: null when partnerSlug is empty', async () => {
      const res = await service.create('poster-1', {
        ...baseDto,
        partnerSlug: '',
      });

      expect(partnersService.ownedIdBySlug).not.toHaveBeenCalled();
      expect(opportunities.save).toHaveBeenCalledWith(
        expect.objectContaining({ partnerId: null, posterId: 'poster-1' }),
      );
      expect(res.partner).toBeNull();
      expect(res.canReviewApplicants).toBe(true);
      expect(res.canEditOpportunity).toBe(true);
    });

    it('links a partner the poster maintains via PartnersService.ownedIdBySlug', async () => {
      partnersService.ownedIdBySlug.mockResolvedValue('partner-1');

      await service.create('poster-1', {
        ...baseDto,
        partnerSlug: 'ilga-portugal',
      });

      expect(partnersService.ownedIdBySlug).toHaveBeenCalledWith(
        'ilga-portugal',
        'poster-1',
      );
      expect(opportunities.save).toHaveBeenCalledWith(
        expect.objectContaining({ partnerId: 'partner-1' }),
      );
    });

    it('rejects a partner the poster does not maintain', async () => {
      partnersService.ownedIdBySlug.mockRejectedValue(
        new ForbiddenException('You can only link a partner you maintain'),
      );

      await expect(
        service.create('poster-1', {
          ...baseDto,
          partnerSlug: 'ilga-portugal',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(opportunities.save).not.toHaveBeenCalled();
    });

    it('rejects a request naming both a partner and a community (400)', async () => {
      await expect(
        service.create('poster-1', {
          ...baseDto,
          partnerSlug: 'ilga-portugal',
          communitySlug: 'queer-devs',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(partnersService.ownedIdBySlug).not.toHaveBeenCalled();
      expect(communityMembership.assertOwnerOrModBySlug).not.toHaveBeenCalled();
      expect(opportunities.save).not.toHaveBeenCalled();
    });

    it('resolves team slugs via MemberLookup and seeds volunteer_opportunity_team rows, deduping the poster', async () => {
      const qb = qbStub();
      qb.getMany = jest.fn().mockResolvedValue([
        { slug: 'jo', userId: 'teammate-1' },
        { slug: 'poster-slug', userId: 'poster-1' }, // resolves to the poster -> deduped
      ]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      await service.create('poster-1', {
        ...baseDto,
        team: ['jo', 'poster-slug'],
      });

      expect(team.save).toHaveBeenCalledWith([
        expect.objectContaining({
          opportunityId: 'opp-1',
          userId: 'teammate-1',
        }),
      ]);
    });

    it('resolves a communitySlug to community_id via CommunityMembershipService.assertOwnerOrModBySlug', async () => {
      await service.create('poster-1', {
        ...baseDto,
        communitySlug: 'queer-devs',
      });

      expect(communityMembership.assertOwnerOrModBySlug).toHaveBeenCalledWith(
        'queer-devs',
        'poster-1',
      );
      expect(opportunities.save).toHaveBeenCalledWith(
        expect.objectContaining({ communityId: 'community-1' }),
      );
    });

    it('refuses a communitySlug that names a space (volunteering is out of v1 for spaces)', async () => {
      communityMembership.isSubcommunity.mockResolvedValue(true);

      await expect(
        service.create('poster-1', {
          ...baseDto,
          communitySlug: 'queer-devs-parents',
        }),
      ).rejects.toMatchObject({
        response: { code: 'SUBCOMMUNITY_FEATURE_UNAVAILABLE' },
      });
      expect(opportunities.save).not.toHaveBeenCalled();
    });

    it('rejects a communitySlug the poster only has plain membership in', async () => {
      communityMembership.assertOwnerOrModBySlug.mockRejectedValue(
        new ForbiddenException(
          'Only the community owner or a moderator can do that',
        ),
      );

      await expect(
        service.create('poster-1', {
          ...baseDto,
          communitySlug: 'queer-devs',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('causes', () => {
    it("deduplicates causes on create, keeping the poster's order", async () => {
      await service.create('poster-1', {
        ...baseDto,
        causes: [
          OpportunityCause.Youth,
          OpportunityCause.MentalHealth,
          OpportunityCause.Youth,
        ],
      });

      // First occurrence wins, so `causes[0]` stays the cause the poster led
      // with (the one the card tints from). `@ArrayMaxSize` counts what was
      // SENT, so without the dedupe this row would print "Youth" twice.
      expect(opportunities.save).toHaveBeenCalledWith(
        expect.objectContaining({
          causes: [OpportunityCause.Youth, OpportunityCause.MentalHealth],
        }),
      );
    });

    it('filters the list by array overlap, so a chip finds a cause in any position', async () => {
      const qb = qbStub();
      opportunities.createQueryBuilder.mockReturnValue(qb);

      await service.list({ cause: OpportunityCause.MentalHealth });

      // `&&`, never `=`: an opportunity listing Mental health SECOND must
      // still come back under the Mental health chip.
      expect(qb.andWhere).toHaveBeenCalledWith(
        'o.causes && ARRAY[:cause]::volunteer_opportunities_cause_enum[]',
        { cause: OpportunityCause.MentalHealth },
      );
    });
  });

  describe('getBySlug / spotsPct', () => {
    it('404s an unknown slug', async () => {
      opportunities.findOne.mockResolvedValue(null);
      await expect(service.getBySlug('nope', 'u1')).rejects.toThrow(
        'Opportunity not found',
      );
    });

    it('derives spotsFilled/spotsPct from the signup count', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'mentor-qyc',
        org: 'Queer Youth Collective',
        partnerId: null,
        role: 'Mentor',
        causes: [OpportunityCause.Youth],
        commit: OpportunityCommitLevel.Low,
        time: '2 hrs / week',
        location: 'Lisbon',
        skills: [],
        desc: 'Mentor queer youth.',
        detail: {
          why: [],
          tasks: [],
          commitments: [],
          goodFor: [],
          teamIntro: null,
        },
        spotsTotal: 4,
        applyRole: 'Volunteer Coordinator',
        posterId: 'poster-1',
        status: OpportunityStatus.Open,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      signups.count.mockResolvedValue(3);

      const detail = await service.getBySlug('mentor-qyc', 'viewer-1');

      expect(detail.spotsFilled).toBe(3);
      expect(detail.spotsPct).toBe(75); // round(3/4 * 100)
      expect(detail.canReviewApplicants).toBe(false);
      expect(detail.canEditOpportunity).toBe(false);
    });

    it('404s a hidden opportunity for an ordinary viewer (moderator takedown withheld exactly like an unknown slug)', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'mentor-qyc',
        org: 'Queer Youth Collective',
        partnerId: null,
        role: 'Mentor',
        causes: [OpportunityCause.Youth],
        commit: OpportunityCommitLevel.Low,
        time: '2 hrs / week',
        location: 'Lisbon',
        skills: [],
        desc: 'Mentor queer youth.',
        detail: {
          why: [],
          tasks: [],
          commitments: [],
          goodFor: [],
          teamIntro: null,
        },
        spotsTotal: 4,
        applyRole: 'Volunteer Coordinator',
        posterId: 'poster-1',
        status: OpportunityStatus.Open,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      contentModerationService.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });

      await expect(service.getBySlug('mentor-qyc', 'viewer-1')).rejects.toThrow(
        'Opportunity not found',
      );
      expect(contentModerationService.stateFor).toHaveBeenCalledWith(
        'volunteering',
        'mentor-qyc',
      );
    });

    it('still shows a hidden opportunity to its own poster', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'mentor-qyc',
        org: 'Queer Youth Collective',
        partnerId: null,
        role: 'Mentor',
        causes: [OpportunityCause.Youth],
        commit: OpportunityCommitLevel.Low,
        time: '2 hrs / week',
        location: 'Lisbon',
        skills: [],
        desc: 'Mentor queer youth.',
        detail: {
          why: [],
          tasks: [],
          commitments: [],
          goodFor: [],
          teamIntro: null,
        },
        spotsTotal: 4,
        applyRole: 'Volunteer Coordinator',
        posterId: 'poster-1',
        status: OpportunityStatus.Open,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      contentModerationService.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });

      const detail = await service.getBySlug('mentor-qyc', 'poster-1');
      expect(detail.slug).toBe('mentor-qyc');
    });

    it('still shows a removed opportunity to platform staff', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'mentor-qyc',
        org: 'Queer Youth Collective',
        partnerId: null,
        role: 'Mentor',
        causes: [OpportunityCause.Youth],
        commit: OpportunityCommitLevel.Low,
        time: '2 hrs / week',
        location: 'Lisbon',
        skills: [],
        desc: 'Mentor queer youth.',
        detail: {
          why: [],
          tasks: [],
          commitments: [],
          goodFor: [],
          teamIntro: null,
        },
        spotsTotal: 4,
        applyRole: 'Volunteer Coordinator',
        posterId: 'poster-1',
        status: OpportunityStatus.Open,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      contentModerationService.stateFor.mockResolvedValue({
        hidden: false,
        removed: true,
      });

      const detail = await service.getBySlug(
        'mentor-qyc',
        'moderator-1',
        'moderator',
      );
      expect(detail.slug).toBe('mentor-qyc');
    });

    it('guards divide-by-zero when spotsTotal is 0', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-2',
        slug: 'zero-spots',
        org: 'Org',
        partnerId: null,
        role: 'Role',
        causes: [OpportunityCause.Arts],
        commit: OpportunityCommitLevel.Medium,
        time: '1 hr',
        location: 'Porto',
        skills: [],
        desc: 'desc',
        detail: {
          why: [],
          tasks: [],
          commitments: [],
          goodFor: [],
          teamIntro: null,
        },
        spotsTotal: 0,
        applyRole: 'Coordinator',
        posterId: 'poster-1',
        status: OpportunityStatus.Open,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      signups.count.mockResolvedValue(0);

      const detail = await service.getBySlug('zero-spots', 'viewer-1');

      expect(detail.spotsPct).toBe(0);
    });
  });

  describe('getBySlug / who the detail names (ENG-474)', () => {
    const opportunityRow = () => ({
      id: 'opp-1',
      slug: 'mentor-qyc',
      org: 'Queer Youth Collective',
      partnerId: null,
      role: 'Mentor',
      causes: [OpportunityCause.Youth],
      commit: OpportunityCommitLevel.Low,
      time: '2 hrs / week',
      location: 'Lisbon',
      skills: [],
      desc: 'Mentor queer youth.',
      detail: {
        why: [],
        tasks: [],
        commitments: [],
        goodFor: [],
        teamIntro: null,
      },
      spotsTotal: 4,
      applyRole: 'Volunteer Coordinator',
      posterId: 'poster-1',
      status: OpportunityStatus.Open,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const profileRow = (userId: string, slug: string) => ({
      userId,
      slug,
      firstName: slug,
      lastName: 'Member',
      pronouns: null,
      avatarUrl: null,
      photoVisible: true,
    });
    let activeProfilesQuery: ReturnType<typeof qbStub>;
    // Held as its own non-optional mock: indexing the stub's record types it
    // as possibly undefined.
    let activeProfilesGetMany: jest.Mock;

    beforeEach(() => {
      opportunities.findOne.mockResolvedValue(opportunityRow());
      team.find.mockResolvedValue([
        { opportunityId: 'opp-1', userId: 'teammate-1' },
        { opportunityId: 'opp-1', userId: 'teammate-2' },
      ]);
      activeProfilesQuery = qbStub();
      activeProfilesGetMany = jest
        .fn()
        .mockResolvedValue([
          profileRow('poster-1', 'poster'),
          profileRow('teammate-1', 'jo'),
          profileRow('teammate-2', 'sam'),
        ]);
      activeProfilesQuery.getMany = activeProfilesGetMany;
      profiles.createQueryBuilder.mockReturnValue(activeProfilesQuery);
    });

    it('names nobody to an anonymous reader and runs no member query at all', async () => {
      const detail = await service.getBySlug('mentor-qyc', null);

      expect(detail.team).toEqual([]);
      expect(detail.poster).toBeNull();
      expect(team.find).not.toHaveBeenCalled();
      expect(profiles.createQueryBuilder).not.toHaveBeenCalled();
      expect(blockFilter.blockedUserIds).not.toHaveBeenCalled();
    });

    it('tells an anonymous reader a team exists without naming anyone', async () => {
      const activeTeamQuery = qbStub();
      const getExists = jest.fn().mockResolvedValue(true);
      activeTeamQuery.getExists = getExists;
      team.createQueryBuilder.mockReturnValue(activeTeamQuery);

      const detail = await service.getBySlug('mentor-qyc', null);

      expect(detail.hasTeam).toBe(true);
      expect(detail.team).toEqual([]);
      expect(activeTeamQuery.where).toHaveBeenCalledWith(
        expect.stringContaining('"opportunity_id" = :opportunityId'),
        { opportunityId: 'opp-1' },
      );
      expect(getExists).toHaveBeenCalledTimes(1);
    });

    it('counts only active teammates toward an anonymous hasTeam, through the users join', async () => {
      // A suspended, deactivated or erasure-grace teammate fails the join,
      // so a team of only those answers false.
      const activeTeamQuery = qbStub();
      team.createQueryBuilder.mockReturnValue(activeTeamQuery);

      const detail = await service.getBySlug('mentor-qyc', null);

      expect(activeTeamQuery.innerJoin).toHaveBeenCalledWith(
        User,
        'team_user',
        expect.stringContaining('"team_user"."status" = :active'),
        { active: UserStatus.Active },
      );
      expect(detail.hasTeam).toBe(false);
      expect(team.exists).not.toHaveBeenCalled();
    });

    it('reports hasTeam false to an anonymous reader when the opportunity has no team', async () => {
      const detail = await service.getBySlug('mentor-qyc', null);

      expect(detail.hasTeam).toBe(false);
    });

    it('reports hasTeam false to a signed-in viewer when no teammate is active', async () => {
      // Only the poster comes back from the active-user join.
      activeProfilesGetMany.mockResolvedValue([
        profileRow('poster-1', 'poster'),
      ]);

      const detail = await service.getBySlug('mentor-qyc', 'viewer-1');

      expect(detail.team).toEqual([]);
      expect(detail.hasTeam).toBe(false);
    });

    it('reports hasTeam from the team rows to a signed-in viewer, even when every teammate is hidden', async () => {
      blockFilter.blockedUserIds.mockResolvedValue(
        new Set(['teammate-1', 'teammate-2']),
      );

      const detail = await service.getBySlug('mentor-qyc', 'viewer-1');

      expect(detail.team).toEqual([]);
      expect(detail.hasTeam).toBe(true);
      expect(team.exists).not.toHaveBeenCalled();
    });

    it('names the poster and every teammate to a signed-in viewer with no blocks', async () => {
      const detail = await service.getBySlug('mentor-qyc', 'viewer-1');

      expect(detail.poster?.slug).toBe('poster');
      expect(detail.team.map((member) => member.slug)).toEqual(['jo', 'sam']);
      expect(blockFilter.blockedUserIds).toHaveBeenCalledWith('viewer-1', [
        'poster-1',
        'teammate-1',
        'teammate-2',
      ]);
    });

    it('resolves members through the active-user join, so a suspended or deactivated teammate drops out', async () => {
      // The join is in the query, so an inactive account simply never comes
      // back from it: here `teammate-2` and the poster are not active.
      activeProfilesGetMany.mockResolvedValue([profileRow('teammate-1', 'jo')]);

      const detail = await service.getBySlug('mentor-qyc', 'viewer-1');

      expect(activeProfilesQuery.innerJoin).toHaveBeenCalledWith(
        'p.user',
        'u',
        'u.status = :active',
        { active: 'active' },
      );
      expect(detail.team.map((member) => member.slug)).toEqual(['jo']);
      expect(detail.poster).toBeNull();
    });

    it('drops a teammate in a block with the viewer, either direction', async () => {
      blockFilter.blockedUserIds.mockResolvedValue(new Set(['teammate-2']));

      const detail = await service.getBySlug('mentor-qyc', 'viewer-1');

      expect(detail.team.map((member) => member.slug)).toEqual(['jo']);
      expect(detail.poster?.slug).toBe('poster');
    });

    it('drops a poster in a block with the viewer', async () => {
      blockFilter.blockedUserIds.mockResolvedValue(new Set(['poster-1']));

      const detail = await service.getBySlug('mentor-qyc', 'viewer-1');

      expect(detail.poster).toBeNull();
      expect(detail.team.map((member) => member.slug)).toEqual(['jo', 'sam']);
    });

    it('still names the poster to themselves', async () => {
      const detail = await service.getBySlug('mentor-qyc', 'poster-1');

      // The viewer goes in as the actor. `BlockFilterService.blockedUserIds`
      // never reports its actor as blocked from itself, which is why the
      // poster survives the block rule on their own detail.
      expect(blockFilter.blockedUserIds).toHaveBeenCalledWith(
        'poster-1',
        expect.arrayContaining(['poster-1']),
      );
      expect(detail.poster?.slug).toBe('poster');
      expect(detail.canEditOpportunity).toBe(true);
    });
  });

  describe('update', () => {
    it('rejects a non-poster', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
      });
      await expect(
        service.update('x', 'intruder', { role: 'Hijacked' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('re-resolves partnerId when partnerSlug is patched (unlike handle/team, this IS a legitimate PATCH field)', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
        partnerId: null,
        detail: {
          why: [],
          tasks: [],
          commitments: [],
          goodFor: [],
          teamIntro: null,
        },
      });
      partnersService.ownedIdBySlug.mockResolvedValue('partner-2');

      await service.update('x', 'poster-1', { partnerSlug: 'a-partner' });

      expect(partnersService.ownedIdBySlug).toHaveBeenCalledWith(
        'a-partner',
        'poster-1',
      );
      expect(opportunities.save).toHaveBeenCalledWith(
        expect.objectContaining({ partnerId: 'partner-2' }),
      );
    });

    it('leaves the existing partner link untouched when partnerSlug is omitted', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
        partnerId: 'partner-1',
        detail: {
          why: [],
          tasks: [],
          commitments: [],
          goodFor: [],
          teamIntro: null,
        },
      });

      await service.update('x', 'poster-1', { role: 'New role' });

      expect(partnersService.ownedIdBySlug).not.toHaveBeenCalled();
      expect(opportunities.save).toHaveBeenCalledWith(
        expect.objectContaining({ partnerId: 'partner-1' }),
      );
    });

    it('re-resolves communityId when communitySlug is patched, asserting owner/mod standing', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
        communityId: null,
        detail: {
          why: [],
          tasks: [],
          commitments: [],
          goodFor: [],
          teamIntro: null,
        },
      });

      await service.update('x', 'poster-1', { communitySlug: 'queer-devs' });

      expect(communityMembership.assertOwnerOrModBySlug).toHaveBeenCalledWith(
        'queer-devs',
        'poster-1',
      );
      expect(opportunities.save).toHaveBeenCalledWith(
        expect.objectContaining({ communityId: 'community-1' }),
      );
    });

    it('still asserts owner/mod standing when the patch names a different community', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
        communityId: 'community-1',
        detail: {
          why: [],
          tasks: [],
          commitments: [],
          goodFor: [],
          teamIntro: null,
        },
      });
      communityMembership.refsByIds.mockResolvedValue(
        new Map([
          [
            'community-1',
            {
              slug: 'old-community',
              name: 'Old',
              avatarImageUrl: null,
            },
          ],
        ]),
      );
      communityMembership.assertOwnerOrModBySlug.mockRejectedValue(
        new ForbiddenException(
          'Only the community owner or a moderator can do that',
        ),
      );

      await expect(
        service.update('x', 'poster-1', { communitySlug: 'queer-devs' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(communityMembership.assertOwnerOrModBySlug).toHaveBeenCalledWith(
        'queer-devs',
        'poster-1',
      );
      expect(opportunities.save).not.toHaveBeenCalled();
    });

    it('keeps an unchanged community link without the owner/mod check (the poster lost their mod role)', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
        partnerId: null,
        communityId: 'community-1',
        detail: {
          why: [],
          tasks: [],
          commitments: [],
          goodFor: [],
          teamIntro: null,
        },
      });
      communityMembership.refsByIds.mockResolvedValue(
        new Map([
          [
            'community-1',
            {
              slug: 'queer-devs',
              name: 'Queer Devs',
              avatarImageUrl: null,
            },
          ],
        ]),
      );
      communityMembership.assertOwnerOrModBySlug.mockRejectedValue(
        new ForbiddenException(
          'Only the community owner or a moderator can do that',
        ),
      );

      // The edit form re-sends the full state on every save.
      await service.update('x', 'poster-1', {
        role: 'New role',
        partnerSlug: '',
        communitySlug: 'queer-devs',
      });

      expect(communityMembership.assertOwnerOrModBySlug).not.toHaveBeenCalled();
      expect(communityMembership.isSubcommunity).not.toHaveBeenCalled();
      expect(opportunities.save).toHaveBeenCalledWith(
        expect.objectContaining({
          communityId: 'community-1',
          partnerId: null,
          role: 'New role',
        }),
      );
    });

    it('keeps an unchanged legacy partner link without the ownership check', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
        partnerId: 'partner-legacy',
        communityId: null,
        detail: {
          why: [],
          tasks: [],
          commitments: [],
          goodFor: [],
          teamIntro: null,
        },
      });
      partnersService.refsByIds.mockResolvedValue(
        new Map([
          [
            'partner-legacy',
            { slug: 'legacy-org', name: 'Legacy', logo: 'LO' },
          ],
        ]),
      );
      partnersService.ownedIdBySlug.mockRejectedValue(
        new ForbiddenException('You can only link a partner you maintain'),
      );

      await service.update('x', 'poster-1', {
        role: 'New role',
        partnerSlug: 'legacy-org',
        communitySlug: '',
      });

      expect(partnersService.ownedIdBySlug).not.toHaveBeenCalled();
      expect(opportunities.save).toHaveBeenCalledWith(
        expect.objectContaining({
          partnerId: 'partner-legacy',
          communityId: null,
        }),
      );
    });

    it('runs the ownership check when a legacy partner link is swapped for another partner', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
        partnerId: 'partner-legacy',
        communityId: null,
        detail: {
          why: [],
          tasks: [],
          commitments: [],
          goodFor: [],
          teamIntro: null,
        },
      });
      partnersService.refsByIds.mockResolvedValue(
        new Map([
          [
            'partner-legacy',
            { slug: 'legacy-org', name: 'Legacy', logo: 'LO' },
          ],
        ]),
      );
      partnersService.ownedIdBySlug.mockRejectedValue(
        new ForbiddenException('You can only link a partner you maintain'),
      );

      await expect(
        service.update('x', 'poster-1', { partnerSlug: 'other-org' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(partnersService.ownedIdBySlug).toHaveBeenCalledWith(
        'other-org',
        'poster-1',
      );
      expect(opportunities.save).not.toHaveBeenCalled();
    });

    it('rejects a patch naming both a partner and a community (400)', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
        partnerId: null,
        communityId: null,
      });

      await expect(
        service.update('x', 'poster-1', {
          partnerSlug: 'ilga-portugal',
          communitySlug: 'queer-devs',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(partnersService.ownedIdBySlug).not.toHaveBeenCalled();
      expect(communityMembership.assertOwnerOrModBySlug).not.toHaveBeenCalled();
      expect(opportunities.save).not.toHaveBeenCalled();
    });

    it('clears the community link when a partial patch links a partner', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
        partnerId: null,
        communityId: 'community-1',
        detail: {
          why: [],
          tasks: [],
          commitments: [],
          goodFor: [],
          teamIntro: null,
        },
      });
      partnersService.ownedIdBySlug.mockResolvedValue('partner-1');

      await service.update('x', 'poster-1', { partnerSlug: 'ilga-portugal' });

      expect(opportunities.save).toHaveBeenCalledWith(
        expect.objectContaining({ partnerId: 'partner-1', communityId: null }),
      );
    });

    it('clears the partner link when a partial patch links a community', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
        partnerId: 'partner-1',
        communityId: null,
        detail: {
          why: [],
          tasks: [],
          commitments: [],
          goodFor: [],
          teamIntro: null,
        },
      });

      await service.update('x', 'poster-1', { communitySlug: 'queer-devs' });

      expect(communityMembership.assertOwnerOrModBySlug).toHaveBeenCalledWith(
        'queer-devs',
        'poster-1',
      );
      expect(opportunities.save).toHaveBeenCalledWith(
        expect.objectContaining({
          partnerId: null,
          communityId: 'community-1',
        }),
      );
    });
  });

  describe('signup', () => {
    it('refuses a signup to a hidden opportunity, the same way getBySlug withholds its detail', async () => {
      managerFindOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
        spotsTotal: 5,
      });
      contentModerationService.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });

      await expect(service.signup('x', 'user-1', {})).rejects.toThrow(
        'Opportunity not found',
      );
      expect(signups.save).not.toHaveBeenCalled();
    });

    it('maps a full opportunity (accepted-only count) to 409 Conflict', async () => {
      managerFindOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
        spotsTotal: 2,
      });
      signups.count.mockResolvedValue(2); // 2 ACCEPTED signups already at capacity

      await expect(service.signup('x', 'user-1', {})).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(signups.save).not.toHaveBeenCalled();
    });

    it('does not count pending applications toward capacity', async () => {
      managerFindOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
        spotsTotal: 2,
      });
      // count() is scoped to accepted-only by the service, so a mock
      // returning 0 here simulates "2 pending, 0 accepted" — capacity check
      // passes even though 2 people have already applied.
      signups.count.mockResolvedValue(0);
      profiles.find.mockResolvedValue([
        {
          userId: 'user-1',
          slug: 'jo',
          firstName: 'Jo',
          lastName: 'D',
          avatarUrl: null,
        },
      ]);

      const res = await service.signup('x', 'user-1', {});
      expect(signups.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'accepted',
          }) as Partial<VolunteerSignup>,
        }),
      );
      expect(res.status).toBe('pending');
    });

    it('maps a duplicate (opportunity, user) signup — still pending — to 409 Conflict', async () => {
      managerFindOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
        spotsTotal: 5,
      });
      signups.count.mockResolvedValue(1);
      signups.findOne.mockResolvedValue({
        id: 'signup-1',
        opportunityId: 'opp-1',
        userId: 'user-1',
        status: 'pending',
      });

      await expect(service.signup('x', 'user-1', {})).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(signups.save).not.toHaveBeenCalled();
    });

    it('creates a pending signup under capacity and resolves the member MemberRef', async () => {
      managerFindOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
        spotsTotal: 5,
      });
      signups.count.mockResolvedValue(1);
      profiles.find.mockResolvedValue([
        {
          userId: 'user-1',
          slug: 'jo',
          firstName: 'Jo',
          lastName: 'D',
          avatarUrl: null,
        },
      ]);

      const res = await service.signup('x', 'user-1', { note: 'Excited!' });

      expect(res.member?.slug).toBe('jo');
      expect(res.note).toBe('Excited!');
      expect(res.status).toBe('pending');
      expect(signups.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'pending', note: 'Excited!' }),
      );
    });

    it('reapplying after a decline reactivates the same row instead of inserting a new one', async () => {
      managerFindOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
        spotsTotal: 5,
      });
      signups.count.mockResolvedValue(0);
      signups.findOne.mockResolvedValue({
        id: 'signup-1',
        opportunityId: 'opp-1',
        userId: 'user-1',
        note: 'old note',
        status: 'declined',
        decidedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      profiles.find.mockResolvedValue([
        {
          userId: 'user-1',
          slug: 'jo',
          firstName: 'Jo',
          lastName: 'D',
          avatarUrl: null,
        },
      ]);

      const res = await service.signup('x', 'user-1', { note: 'new note' });

      expect(signups.create).not.toHaveBeenCalled();
      expect(signups.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'signup-1',
          note: 'new note',
          status: 'pending',
          decidedAt: null,
        }),
      );
      expect(res.status).toBe('pending');
    });

    it('notifies the poster (best-effort) on a new pending application', async () => {
      managerFindOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
        spotsTotal: 5,
      });
      signups.count.mockResolvedValue(0);
      profiles.find.mockResolvedValue([
        {
          userId: 'user-1',
          slug: 'jo',
          firstName: 'Jo',
          lastName: 'D',
          avatarUrl: null,
        },
      ]);

      await service.signup('x', 'user-1', {});

      expect(notificationsService.create).toHaveBeenCalledWith(
        'poster-1',
        NotificationType.VolunteerApplicationReceived,
        expect.objectContaining({ opportunitySlug: 'x' }),
        'user-1',
      );
    });

    it('still returns the created signup when the notification write fails', async () => {
      managerFindOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
        spotsTotal: 5,
      });
      signups.count.mockResolvedValue(0);
      profiles.find.mockResolvedValue([
        {
          userId: 'user-1',
          slug: 'jo',
          firstName: 'Jo',
          lastName: 'D',
          avatarUrl: null,
        },
      ]);
      notificationsService.create.mockRejectedValue(new Error('down'));

      await expect(service.signup('x', 'user-1', {})).resolves.toEqual(
        expect.objectContaining({ status: 'pending' }),
      );
    });
  });

  describe('withdraw', () => {
    it('deletes the viewer signup for the resolved opportunity', async () => {
      opportunities.findOne.mockResolvedValue({ id: 'opp-1', slug: 'x' });

      await service.withdraw('x', 'user-1');

      expect(signups.delete).toHaveBeenCalledWith({
        opportunityId: 'opp-1',
        userId: 'user-1',
      });
    });
  });

  describe('listSignups', () => {
    it('rejects a non-poster (403)', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
      });
      await expect(service.listSignups('x', 'intruder')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('lists signups for the poster', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
      });
      signups.find.mockResolvedValue([
        {
          id: 'signup-1',
          opportunityId: 'opp-1',
          userId: 'user-1',
          note: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]);
      profiles.find.mockResolvedValue([
        {
          userId: 'user-1',
          slug: 'jo',
          firstName: 'Jo',
          lastName: 'D',
          avatarUrl: null,
        },
      ]);

      const res = await service.listSignups('x', 'poster-1');

      expect(res).toHaveLength(1);
      expect(res[0]!.member?.slug).toBe('jo');
    });
  });

  describe('decideSignup', () => {
    const pendingSignup = {
      id: 'signup-1',
      opportunityId: 'opp-1',
      userId: 'user-1',
      note: 'Excited!',
      status: 'pending',
      decidedAt: null,
      createdAt: new Date('2026-08-16T00:00:00.000Z'),
    };

    it('rejects a non-poster (403)', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
      });
      await expect(
        service.decideSignup(
          'x',
          'signup-1',
          'intruder',
          SignupStatus.Accepted,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s an unknown signup id', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
      });
      signups.findOne.mockResolvedValue(null);
      await expect(
        service.decideSignup('x', 'nope', 'poster-1', SignupStatus.Accepted),
      ).rejects.toThrow('Signup not found');
    });

    it('409s an already-decided signup', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
      });
      signups.findOne.mockResolvedValue({
        ...pendingSignup,
        status: 'accepted',
      });
      await expect(
        service.decideSignup(
          'x',
          'signup-1',
          'poster-1',
          SignupStatus.Declined,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('409s when the conditional claim UPDATE affects 0 rows (race)', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
      });
      signups.findOne.mockResolvedValue({ ...pendingSignup });
      const qb = qbStub();
      qb.update = jest.fn().mockReturnValue(qb);
      qb.set = jest.fn().mockReturnValue(qb);
      qb.execute = jest.fn().mockResolvedValue({ affected: 0 });
      signups.createQueryBuilder.mockReturnValue(qb);

      await expect(
        service.decideSignup(
          'x',
          'signup-1',
          'poster-1',
          SignupStatus.Accepted,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('accepts a pending signup, sets decidedAt, and returns the updated DTO', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
      });
      signups.findOne.mockResolvedValue({ ...pendingSignup });
      const qb = qbStub();
      qb.update = jest.fn().mockReturnValue(qb);
      qb.set = jest.fn().mockReturnValue(qb);
      qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
      signups.createQueryBuilder.mockReturnValue(qb);
      profiles.find.mockResolvedValue([
        {
          userId: 'user-1',
          slug: 'jo',
          firstName: 'Jo',
          lastName: 'D',
          avatarUrl: null,
        },
      ]);

      const res = await service.decideSignup(
        'x',
        'signup-1',
        'poster-1',
        SignupStatus.Accepted,
      );

      expect(res.status).toBe('accepted');
      expect(res.decidedAt).not.toBeNull();
    });

    it('notifies the applicant (best-effort) of the decision', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
      });
      signups.findOne.mockResolvedValue({
        id: 'signup-1',
        opportunityId: 'opp-1',
        userId: 'user-1',
        status: 'pending',
        decidedAt: null,
        createdAt: new Date('2026-08-16T00:00:00.000Z'),
      });
      const qb = qbStub();
      qb.update = jest.fn().mockReturnValue(qb);
      qb.set = jest.fn().mockReturnValue(qb);
      qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
      signups.createQueryBuilder.mockReturnValue(qb);
      profiles.find.mockResolvedValue([
        {
          userId: 'user-1',
          slug: 'jo',
          firstName: 'Jo',
          lastName: 'D',
          avatarUrl: null,
        },
      ]);

      await service.decideSignup(
        'x',
        'signup-1',
        'poster-1',
        SignupStatus.Declined,
      );

      expect(notificationsService.create).toHaveBeenCalledWith(
        'user-1',
        NotificationType.VolunteerApplicationDecided,
        expect.objectContaining({ opportunitySlug: 'x', status: 'declined' }),
      );
    });
  });

  describe('listMine', () => {
    it('returns posted opportunities with pending/accepted counts', async () => {
      opportunities.find = jest.fn().mockResolvedValue([
        {
          id: 'opp-1',
          slug: 'x',
          role: 'Mentor',
          org: 'QYC',
          status: OpportunityStatus.Open,
          spotsTotal: 5,
          createdAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ]);
      const qb = qbStub();
      qb.getRawMany = jest.fn().mockResolvedValue([
        { opportunityId: 'opp-1', status: 'pending', count: '2' },
        { opportunityId: 'opp-1', status: 'accepted', count: '3' },
      ]);
      signups.createQueryBuilder.mockReturnValue(qb);

      const res = await service.listMine('poster-1');

      expect(opportunities.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: [{ posterId: 'poster-1' }] }),
      );
      expect(res).toEqual([
        expect.objectContaining({
          slug: 'x',
          pendingCount: 2,
          acceptedCount: 3,
        }),
      ]);
    });

    it('returns an empty list for a poster with no opportunities', async () => {
      opportunities.find = jest.fn().mockResolvedValue([]);
      expect(await service.listMine('poster-1')).toEqual([]);
    });

    it('also matches opportunities of communities the viewer organises', async () => {
      communityMembership.ownerOrModCommunityIdsForUser.mockResolvedValue([
        'community-1',
        'community-2',
      ]);
      opportunities.find = jest.fn().mockResolvedValue([]);

      await service.listMine('mod-1');

      expect(opportunities.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: [
            { posterId: 'mod-1' },
            { communityId: In(['community-1', 'community-2']) },
          ],
        }),
      );
    });
  });

  describe('community organisers reviewing applicants', () => {
    const communityOpportunity = {
      id: 'opp-1',
      slug: 'x',
      posterId: 'poster-1',
      communityId: 'community-1',
    };

    it('lets an owner/mod of the attributed community list signups', async () => {
      opportunities.findOne.mockResolvedValue(communityOpportunity);
      communityMembership.isOwnerOrMod.mockResolvedValue(true);
      signups.find.mockResolvedValue([]);

      await expect(service.listSignups('x', 'mod-1')).resolves.toEqual([]);
      expect(communityMembership.isOwnerOrMod).toHaveBeenCalledWith(
        'community-1',
        'mod-1',
      );
    });

    it('still rejects a plain member of the attributed community (403)', async () => {
      opportunities.findOne.mockResolvedValue(communityOpportunity);
      communityMembership.isOwnerOrMod.mockResolvedValue(false);

      await expect(service.listSignups('x', 'member-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('never consults the roster for an opportunity with no community', async () => {
      opportunities.findOne.mockResolvedValue({
        id: 'opp-1',
        slug: 'x',
        posterId: 'poster-1',
        communityId: null,
      });

      await expect(service.listSignups('x', 'intruder')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(communityMembership.isOwnerOrMod).not.toHaveBeenCalled();
    });
  });
});
