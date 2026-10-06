import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  AccessTier,
  Community,
  CommunityType,
} from '../communities/entities/community.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import {
  Changemaker,
  ChangemakerStatus,
} from '../changemakers/entities/changemaker.entity';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import {
  Event,
  EventStatus,
  EventVisibility,
} from '../events/entities/event.entity';
import { MagazineArticle } from '../magazine/entities/magazine-article.entity';
import { MagazineAuthor } from '../magazine/entities/magazine-author.entity';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import {
  LandingFeature,
  LandingSection,
} from './entities/landing-feature.entity';
import { LandingService } from './landing.service';

// A chainable query-builder stub whose terminal methods resolve to empty
// results by default, mirroring `companies.service.spec.ts`'s `qbStub`.
function qbStub() {
  const qb: Record<string, jest.Mock> = {};
  for (const method of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'innerJoin',
    'groupBy',
    'orderBy',
    'take',
    'setLock',
  ]) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue([]);
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  qb.getRawOne = jest.fn().mockResolvedValue(undefined);
  return qb;
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-id',
    status: UserStatus.Active,
    ...overrides,
  } as User;
}

function makeProfile(overrides: Partial<Profile>): Profile {
  return {
    userId: 'profile-id',
    slug: 'someone',
    firstName: 'Some',
    lastName: 'One',
    tagline: null,
    avatarUrl: null,
    photoVisible: true,
    hiddenUntil: null,
    visibility: ProfileVisibility.Open,
    featuredConsent: true,
    user: makeUser({ id: 'profile-id' }),
    ...overrides,
  } as Profile;
}

function makeCommunity(overrides: Partial<Community>): Community {
  return {
    id: 'community-id',
    slug: 'some-community',
    name: 'Some Community',
    accessTier: AccessTier.Public,
    archivedAt: null,
    frozenAt: null,
    // Top-level by default; a test that wants a space passes `parentId`.
    parentId: null,
    // The card renders a category badge, a "since ‹year›" line and the
    // "what you get" chips, so a fixture missing these blows up right here in
    // the mapper, early and clearly.
    type: CommunityType.Social,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    features: [],
    coverImageUrl: null,
    rosterVisible: true,
    ...overrides,
  } as Community;
}

function makeChangemaker(overrides: Partial<Changemaker>): Changemaker {
  return {
    id: 'changemaker-id',
    slug: 'some-changemaker',
    name: 'Some Changemaker',
    status: ChangemakerStatus.Published,
    imageUrl: null,
    ...overrides,
  } as Changemaker;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function makeEvent(overrides: Partial<Event>): Event {
  return {
    id: 'event-id',
    slug: 'some-gathering',
    title: 'Some Gathering',
    startAt: new Date(Date.now() + ONE_DAY_MS),
    endAt: null,
    timezone: 'Europe/Lisbon',
    neighbourhood: 'Arroios',
    isOnline: false,
    onlineUrl: null,
    venue: 'The Back Room Bar',
    address: 'Rua Exemplo 1, 2 Esq',
    arrivalNotes: 'Ring the bell on the left',
    hostId: 'host-user-id',
    coverImageUrl: null,
    status: EventStatus.Published,
    visibility: EventVisibility.Public,
    ...overrides,
  } as Event;
}

function makeArticle(overrides: Partial<MagazineArticle>): MagazineArticle {
  return {
    id: 'article-id',
    slug: 'some-story',
    title: 'Some Story',
    dek: 'A short dek',
    heroImageKey: '',
    authorId: 'author-id',
    readMinutes: 6,
    publishedAt: new Date(Date.now() - ONE_DAY_MS),
    translationOfArticleId: null,
    ...overrides,
  } as MagazineArticle;
}

function makeAuthor(overrides: Partial<MagazineAuthor>): MagazineAuthor {
  return {
    id: 'author-id',
    userId: 'author-user-id',
    slug: 'some-author',
    name: 'Some Author',
    ...overrides,
  } as MagazineAuthor;
}

function makeFeature(overrides: Partial<LandingFeature>): LandingFeature {
  return {
    id: 'feature-id',
    section: LandingSection.Member,
    targetId: 'target-id',
    position: 0,
    copy: { quote: 'A real quote' },
    active: true,
    createdBy: 'admin-id',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('LandingService', () => {
  let service: LandingService;
  let landingFeatures: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: {
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let communities: {
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let changemakers: {
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let communityMembers: { createQueryBuilder: jest.Mock };
  let events: {
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let articles: {
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let authors: { find: jest.Mock };
  let contentModeration: { find: jest.Mock };
  // The transactional `EntityManager` seen inside `dataSource.transaction`'s
  // callback. `createFeature` and `reorderFeatures` both now do their
  // section-row-locking + writes through this, distinct from the outer
  // `landingFeatures` repo mock.
  let manager: {
    createQueryBuilder: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock; query: jest.Mock };

  beforeEach(async () => {
    landingFeatures = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      // Pass-through, like `companies.service.spec.ts`'s repo mocks: the
      // entity is whatever fields were given.
      create: jest.fn((value: object) => value),
      save: jest.fn((value: unknown) => Promise.resolve(value)),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    profiles = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    communities = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    changemakers = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    communityMembers = { createQueryBuilder: jest.fn(() => qbStub()) };
    events = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    articles = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    authors = { find: jest.fn().mockResolvedValue([]) };
    contentModeration = { find: jest.fn().mockResolvedValue([]) };
    manager = {
      createQueryBuilder: jest.fn(() => qbStub()),
      save: jest.fn((value: unknown) => Promise.resolve(value)),
      update: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      transaction: jest.fn(
        async (callback: (manager: unknown) => Promise<unknown>) =>
          callback(manager),
      ),
      // The community roster strip picks its faces with one window-function
      // query across the whole batch. Default: no faces.
      query: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LandingService,
        {
          provide: getRepositoryToken(LandingFeature),
          useValue: landingFeatures,
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(Changemaker), useValue: changemakers },
        {
          provide: getRepositoryToken(CommunityMember),
          useValue: communityMembers,
        },
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(MagazineArticle), useValue: articles },
        { provide: getRepositoryToken(MagazineAuthor), useValue: authors },
        {
          provide: getRepositoryToken(ContentModeration),
          useValue: contentModeration,
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get(LandingService);
  });

  describe('getPublicFeatures', () => {
    it('drops a featured member whose profile visibility is Network', async () => {
      landingFeatures.find.mockImplementation(
        ({ where }: { where: { section: LandingSection } }) => {
          if (where.section !== LandingSection.Member) return [];
          return [
            makeFeature({ id: 'f-open', targetId: 'p-open', position: 0 }),
            makeFeature({
              id: 'f-network',
              targetId: 'p-network',
              position: 1,
            }),
          ];
        },
      );
      profiles.find.mockResolvedValue([
        makeProfile({ userId: 'p-open', slug: 'open-member' }),
        makeProfile({
          userId: 'p-network',
          slug: 'network-member',
          visibility: ProfileVisibility.Network,
        }),
      ]);

      const result = await service.getPublicFeatures();

      expect(result.members.map((member) => member.slug)).toEqual([
        'open-member',
      ]);
    });

    it('drops a featured member who revoked featuredConsent', async () => {
      landingFeatures.find.mockImplementation(
        ({ where }: { where: { section: LandingSection } }) => {
          if (where.section !== LandingSection.Member) return [];
          return [makeFeature({ id: 'f-1', targetId: 'p-1', position: 0 })];
        },
      );
      profiles.find.mockResolvedValue([
        makeProfile({
          userId: 'p-1',
          slug: 'no-consent',
          featuredConsent: false,
        }),
      ]);

      const result = await service.getPublicFeatures();

      expect(result.members).toEqual([]);
    });

    it('drops a community that is not AccessTier.Public', async () => {
      landingFeatures.find.mockImplementation(
        ({ where }: { where: { section: LandingSection } }) => {
          if (where.section !== LandingSection.Community) return [];
          return [
            makeFeature({
              id: 'f-public',
              section: LandingSection.Community,
              targetId: 'c-public',
              position: 0,
              copy: { blurb: 'welcoming' },
            }),
            makeFeature({
              id: 'f-request',
              section: LandingSection.Community,
              targetId: 'c-request',
              position: 1,
              copy: { blurb: 'request only' },
            }),
          ];
        },
      );
      communities.find.mockResolvedValue([
        makeCommunity({ id: 'c-public', slug: 'public-community' }),
        makeCommunity({
          id: 'c-request',
          slug: 'request-community',
          accessTier: AccessTier.Request,
        }),
      ]);

      const result = await service.getPublicFeatures();

      expect(result.communities.map((community) => community.slug)).toEqual([
        'public-community',
      ]);
    });

    it('drops a featured community that is a space (has a parentId)', async () => {
      landingFeatures.find.mockImplementation(
        ({ where }: { where: { section: LandingSection } }) => {
          if (where.section !== LandingSection.Community) return [];
          return [
            makeFeature({
              id: 'f-top-level',
              section: LandingSection.Community,
              targetId: 'c-top-level',
              position: 0,
              copy: { blurb: 'a real top-level community' },
            }),
            makeFeature({
              id: 'f-space',
              section: LandingSection.Community,
              targetId: 'c-space',
              position: 1,
              copy: { blurb: 'a space inside another community' },
            }),
          ];
        },
      );
      communities.find.mockResolvedValue([
        makeCommunity({ id: 'c-top-level', slug: 'top-level-community' }),
        makeCommunity({
          id: 'c-space',
          slug: 'a-space',
          parentId: 'c-top-level',
        }),
      ]);

      const result = await service.getPublicFeatures();

      expect(result.communities.map((community) => community.slug)).toEqual([
        'top-level-community',
      ]);
    });

    it('drops a changemaker that is not Published', async () => {
      landingFeatures.find.mockImplementation(
        ({ where }: { where: { section: LandingSection } }) => {
          if (where.section !== LandingSection.Changemaker) return [];
          return [
            makeFeature({
              id: 'f-published',
              section: LandingSection.Changemaker,
              targetId: 'cm-published',
              position: 0,
              copy: { cause: 'Housing', blurb: 'Fights for housing.' },
            }),
            makeFeature({
              id: 'f-draft',
              section: LandingSection.Changemaker,
              targetId: 'cm-draft',
              position: 1,
              copy: { cause: 'Health', blurb: 'Fights for health.' },
            }),
          ];
        },
      );
      changemakers.find.mockResolvedValue([
        makeChangemaker({ id: 'cm-published', slug: 'published-changemaker' }),
        makeChangemaker({
          id: 'cm-draft',
          slug: 'draft-changemaker',
          status: ChangemakerStatus.Draft,
        }),
      ]);

      const result = await service.getPublicFeatures();

      expect(
        result.changemakers.map((changemaker) => changemaker.slug),
      ).toEqual(['published-changemaker']);
    });

    it('orders survivors by position ascending within each section', async () => {
      // Simulates what `IDX_landing_feature_section_active_position` already
      // guarantees at the DB layer (`ORDER BY position ASC`): the service
      // must preserve that order through filtering, with no re-sorting or
      // shuffling afterward.
      landingFeatures.find.mockImplementation(
        ({ where }: { where: { section: LandingSection } }) => {
          if (where.section !== LandingSection.Member) return [];
          return [
            makeFeature({ id: 'f-a', targetId: 'p-a', position: 0 }),
            makeFeature({ id: 'f-b', targetId: 'p-b', position: 1 }),
            makeFeature({ id: 'f-c', targetId: 'p-c', position: 2 }),
          ];
        },
      );
      profiles.find.mockResolvedValue([
        makeProfile({ userId: 'p-a', slug: 'member-a' }),
        makeProfile({ userId: 'p-b', slug: 'member-b' }),
        makeProfile({ userId: 'p-c', slug: 'member-c' }),
      ]);

      const result = await service.getPublicFeatures();

      expect(result.members.map((member) => member.slug)).toEqual([
        'member-a',
        'member-b',
        'member-c',
      ]);
    });

    it('roster faces skip private, hidden and suspended members', async () => {
      // The ranked subquery itself does the skipping in Postgres; this spec
      // runs against a mocked `dataSource.query`, so the assertion checks the
      // generated SQL text carries the join and every filter, mirroring how
      // `isPublicFace`'s SQL twin is meant to read.
      landingFeatures.find.mockImplementation(
        ({ where }: { where: { section: LandingSection } }) => {
          if (where.section !== LandingSection.Community) return [];
          return [
            makeFeature({
              id: 'f-c',
              section: LandingSection.Community,
              targetId: 'c-1',
              position: 0,
              copy: { blurb: 'a community' },
            }),
          ];
        },
      );
      communities.find.mockResolvedValue([makeCommunity({ id: 'c-1' })]);

      await service.getPublicFeatures();

      expect(dataSource.query).toHaveBeenCalledTimes(1);
      const [sql, params] = dataSource.query.mock.calls[0] as [
        string,
        unknown[],
      ];
      expect(sql).toContain('JOIN users u ON u.id = m.user_id');
      expect(sql).toContain('u.status = $3');
      expect(sql).toContain(`p.visibility = 'open'`);
      expect(sql).toContain(
        '(p.hidden_until IS NULL OR p.hidden_until <= now())',
      );
      expect(params[0]).toEqual(['c-1']);
      expect(params[2]).toBe(UserStatus.Active);
    });

    it('a member who hid their photo appears with a null avatar', async () => {
      landingFeatures.find.mockImplementation(
        ({ where }: { where: { section: LandingSection } }) => {
          if (where.section !== LandingSection.Community) return [];
          return [
            makeFeature({
              id: 'f-c',
              section: LandingSection.Community,
              targetId: 'c-1',
              position: 0,
              copy: { blurb: 'a community' },
            }),
          ];
        },
      );
      communities.find.mockResolvedValue([
        makeCommunity({ id: 'c-1', rosterVisible: true }),
      ]);
      dataSource.query.mockResolvedValue([
        {
          communityId: 'c-1',
          firstName: 'Hidden',
          lastName: 'Photo',
          avatarUrl: 'avatar-key.jpg',
          photoVisible: false,
        },
      ]);

      const result = await service.getPublicFeatures();

      const community = result.communities[0];
      if (!community) throw new Error('expected a featured community');
      expect(community.faces).toEqual([
        { name: 'Hidden Photo', avatarUrl: null },
      ]);
    });

    it('owner face is null when the owner profile is private', async () => {
      landingFeatures.find.mockImplementation(
        ({ where }: { where: { section: LandingSection } }) => {
          if (where.section !== LandingSection.Community) return [];
          return [
            makeFeature({
              id: 'f-c',
              section: LandingSection.Community,
              targetId: 'c-1',
              position: 0,
              copy: { blurb: 'a community' },
            }),
          ];
        },
      );
      communities.find.mockResolvedValue([
        makeCommunity({ id: 'c-1', ownerId: 'owner-1' }),
      ]);
      profiles.find.mockResolvedValue([
        makeProfile({
          userId: 'owner-1',
          slug: 'the-owner',
          visibility: ProfileVisibility.Network,
        }),
      ]);

      const result = await service.getPublicFeatures();

      const community = result.communities[0];
      if (!community) throw new Error('expected a featured community');
      expect(community.owner).toBeNull();
    });

    it('a public, active owner with their photo visible renders name and avatar', async () => {
      // Guards the positive path against a regression in `isPublicFace` (or
      // its wiring in `getPublicFeatures`) that would drop every owner
      // indiscriminately, well past the ones the gate is meant to catch.
      landingFeatures.find.mockImplementation(
        ({ where }: { where: { section: LandingSection } }) => {
          if (where.section !== LandingSection.Community) return [];
          return [
            makeFeature({
              id: 'f-c',
              section: LandingSection.Community,
              targetId: 'c-1',
              position: 0,
              copy: { blurb: 'a community' },
            }),
          ];
        },
      );
      communities.find.mockResolvedValue([
        makeCommunity({ id: 'c-1', ownerId: 'owner-1' }),
      ]);
      profiles.find.mockResolvedValue([
        makeProfile({
          userId: 'owner-1',
          slug: 'the-owner',
          firstName: 'Open',
          lastName: 'Owner',
          avatarUrl: 'https://example.com/owner-avatar.jpg',
          photoVisible: true,
        }),
      ]);

      const result = await service.getPublicFeatures();

      const community = result.communities[0];
      if (!community) throw new Error('expected a featured community');
      expect(community.owner).toEqual({
        name: 'Open Owner',
        avatarUrl: 'https://example.com/owner-avatar.jpg',
      });
    });

    it('a featured member with the photo off ships a null avatar', async () => {
      landingFeatures.find.mockImplementation(
        ({ where }: { where: { section: LandingSection } }) => {
          if (where.section !== LandingSection.Member) return [];
          return [makeFeature({ id: 'f-1', targetId: 'p-1', position: 0 })];
        },
      );
      profiles.find.mockResolvedValue([
        makeProfile({
          userId: 'p-1',
          slug: 'photo-off-member',
          avatarUrl: 'avatar-key.jpg',
          photoVisible: false,
        }),
      ]);

      const result = await service.getPublicFeatures();

      expect(result.members).toHaveLength(1);
      const member = result.members[0];
      if (!member) throw new Error('expected a featured member');
      expect(member.avatarUrl).toBeNull();
    });

    it('a suspended featured member is dropped', async () => {
      landingFeatures.find.mockImplementation(
        ({ where }: { where: { section: LandingSection } }) => {
          if (where.section !== LandingSection.Member) return [];
          return [makeFeature({ id: 'f-1', targetId: 'p-1', position: 0 })];
        },
      );
      profiles.find.mockResolvedValue([
        makeProfile({
          userId: 'p-1',
          slug: 'suspended-member',
          user: makeUser({ id: 'p-1', status: UserStatus.Suspended }),
        }),
      ]);

      const result = await service.getPublicFeatures();

      expect(result.members).toEqual([]);
    });

    it('keeps only public, published, upcoming gatherings that are not taken down', async () => {
      landingFeatures.find.mockImplementation(
        ({ where }: { where: { section: LandingSection } }) => {
          if (where.section !== LandingSection.Gathering) return [];
          return [
            'e-open',
            'e-members',
            'e-invite',
            'e-community',
            'e-cancelled',
            'e-draft',
            'e-ended',
            'e-taken-down',
            'e-deleted',
          ].map((targetId, position) =>
            makeFeature({
              id: `f-${targetId}`,
              section: LandingSection.Gathering,
              targetId,
              position,
              copy: {},
            }),
          );
        },
      );
      events.find.mockResolvedValue([
        makeEvent({ id: 'e-open', slug: 'open-gathering' }),
        makeEvent({
          id: 'e-members',
          slug: 'members-gathering',
          visibility: EventVisibility.Members,
        }),
        makeEvent({
          id: 'e-invite',
          slug: 'invite-gathering',
          visibility: EventVisibility.InviteOnly,
        }),
        makeEvent({
          id: 'e-community',
          slug: 'community-gathering',
          visibility: EventVisibility.Community,
        }),
        makeEvent({
          id: 'e-cancelled',
          slug: 'cancelled-gathering',
          status: EventStatus.Cancelled,
        }),
        makeEvent({
          id: 'e-draft',
          slug: 'draft-gathering',
          status: EventStatus.Draft,
        }),
        makeEvent({
          id: 'e-ended',
          slug: 'ended-gathering',
          startAt: new Date(Date.now() - 2 * ONE_DAY_MS),
          endAt: new Date(Date.now() - ONE_DAY_MS),
        }),
        makeEvent({ id: 'e-taken-down', slug: 'taken-down-gathering' }),
      ]);
      contentModeration.find.mockResolvedValue([
        { subjectId: 'e-taken-down', hiddenAt: new Date(), removedAt: null },
      ]);

      const result = await service.getPublicFeatures();

      expect(result.gatherings.map((gathering) => gathering.slug)).toEqual([
        'open-gathering',
      ]);
      // Batched: one entity query and one moderation query for the section.
      expect(events.find).toHaveBeenCalledTimes(1);
      expect(contentModeration.find).toHaveBeenCalledTimes(1);
    });

    it('keeps a gathering that has started and is still running', async () => {
      landingFeatures.find.mockImplementation(
        ({ where }: { where: { section: LandingSection } }) => {
          if (where.section !== LandingSection.Gathering) return [];
          return [
            makeFeature({
              section: LandingSection.Gathering,
              targetId: 'e-running',
              copy: {},
            }),
          ];
        },
      );
      events.find.mockResolvedValue([
        makeEvent({
          id: 'e-running',
          slug: 'running-gathering',
          startAt: new Date(Date.now() - ONE_DAY_MS),
          endAt: new Date(Date.now() + ONE_DAY_MS),
        }),
      ]);

      const result = await service.getPublicFeatures();

      expect(result.gatherings.map((gathering) => gathering.slug)).toEqual([
        'running-gathering',
      ]);
    });

    it('a public gathering card carries the area only, with no address, venue, host or attendees', async () => {
      landingFeatures.find.mockImplementation(
        ({ where }: { where: { section: LandingSection } }) => {
          if (where.section !== LandingSection.Gathering) return [];
          return [
            makeFeature({
              id: 'f-gathering',
              section: LandingSection.Gathering,
              targetId: 'e-1',
              copy: { blurb: 'Editor pick' },
            }),
          ];
        },
      );
      const startAt = new Date(Date.now() + ONE_DAY_MS);
      events.find.mockResolvedValue([
        makeEvent({ id: 'e-1', slug: 'supper-club', startAt }),
      ]);

      const result = await service.getPublicFeatures();

      expect(result.gatherings).toEqual([
        {
          id: 'f-gathering',
          slug: 'supper-club',
          title: 'Some Gathering',
          startAt: startAt.toISOString(),
          timezone: 'Europe/Lisbon',
          area: 'Arroios',
          isOnline: false,
          coverImageUrl: null,
          blurb: 'Editor pick',
        },
      ]);
    });

    it('keeps only published stories and credits the byline as printed', async () => {
      landingFeatures.find.mockImplementation(
        ({ where }: { where: { section: LandingSection } }) => {
          if (where.section !== LandingSection.Story) return [];
          return ['a-live', 'a-draft', 'a-scheduled', 'a-deleted'].map(
            (targetId, position) =>
              makeFeature({
                id: `f-${targetId}`,
                section: LandingSection.Story,
                targetId,
                position,
                copy: {},
              }),
          );
        },
      );
      articles.find.mockResolvedValue([
        makeArticle({ id: 'a-live', slug: 'live-story' }),
        makeArticle({ id: 'a-draft', slug: 'draft-story', publishedAt: null }),
        makeArticle({
          id: 'a-scheduled',
          slug: 'scheduled-story',
          publishedAt: new Date(Date.now() + ONE_DAY_MS),
        }),
      ]);
      authors.find.mockResolvedValue([makeAuthor({ name: 'Inês Duarte' })]);

      const result = await service.getPublicFeatures();

      expect(result.stories).toEqual([
        {
          id: 'f-a-live',
          slug: 'live-story',
          title: 'Some Story',
          dek: 'A short dek',
          coverImageUrl: null,
          authorName: 'Inês Duarte',
          readMinutes: 6,
          blurb: null,
        },
      ]);
      // Batched: one article query and one byline query for the section.
      expect(articles.find).toHaveBeenCalledTimes(1);
      expect(authors.find).toHaveBeenCalledTimes(1);
    });
  });

  describe('createFeature', () => {
    it('rejects an ineligible member target with BadRequestException', async () => {
      profiles.findOne.mockResolvedValue(
        makeProfile({ userId: 'p-1', visibility: ProfileVisibility.Network }),
      );

      await expect(
        service.createFeature('admin-1', {
          section: LandingSection.Member,
          targetId: 'p-1',
          copy: { quote: 'Hello' },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Ineligibility is caught before the position-assigning transaction is
      // ever opened.
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects a duplicate (section, target) as a ConflictException', async () => {
      profiles.findOne.mockResolvedValue(makeProfile({ userId: 'p-1' }));
      const uniqueViolation = Object.assign(new Error('duplicate key'), {
        driverError: {
          code: '23505',
          constraint: 'UQ_landing_feature_section_target',
        },
      });
      manager.save.mockRejectedValue(uniqueViolation);

      await expect(
        service.createFeature('admin-1', {
          section: LandingSection.Member,
          targetId: 'p-1',
          copy: { quote: 'Hello' },
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('assigns position = current max + 1 within the section', async () => {
      profiles.findOne.mockResolvedValue(makeProfile({ userId: 'p-1' }));
      // The transactional manager issues two `createQueryBuilder` calls: the
      // section-row lock (`getMany`, irrelevant here, defaults to `[]`) and
      // the `MAX(position)` read, both served by fresh stubs off the same
      // implementation, so both see the same `maxPosition`.
      manager.createQueryBuilder.mockImplementation(() => {
        const qb = qbStub();
        qb.getRawOne!.mockResolvedValue({ maxPosition: '3' });
        return qb;
      });

      const created = await service.createFeature('admin-1', {
        section: LandingSection.Member,
        targetId: 'p-1',
        copy: { quote: 'Hello' },
      });

      expect(created.position).toBe(4);
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ position: 4 }),
      );
    });
  });

  describe('createFeature (gatherings and stories)', () => {
    const ineligibleGatherings: Array<[string, Partial<Event>]> = [
      ['members-only', { visibility: EventVisibility.Members }],
      ['private to a network', { visibility: EventVisibility.Network }],
      ['cancelled', { status: EventStatus.Cancelled }],
      [
        'already over',
        {
          startAt: new Date(Date.now() - 2 * ONE_DAY_MS),
          endAt: new Date(Date.now() - ONE_DAY_MS),
        },
      ],
    ];

    it.each(ineligibleGatherings)(
      'rejects a gathering that is %s',
      async (_label, overrides) => {
        events.findOne.mockResolvedValue(
          makeEvent({ id: 'e-1', ...overrides }),
        );

        await expect(
          service.createFeature('admin-1', {
            section: LandingSection.Gathering,
            targetId: 'e-1',
            copy: {},
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(dataSource.transaction).not.toHaveBeenCalled();
      },
    );

    it('rejects a gathering a moderator took down', async () => {
      events.findOne.mockResolvedValue(makeEvent({ id: 'e-1' }));
      contentModeration.find.mockResolvedValue([
        { subjectId: 'e-1', hiddenAt: null, removedAt: new Date() },
      ]);

      await expect(
        service.createFeature('admin-1', {
          section: LandingSection.Gathering,
          targetId: 'e-1',
          copy: {},
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates a feature for a public upcoming gathering', async () => {
      events.findOne.mockResolvedValue(
        makeEvent({ id: 'e-1', slug: 'supper-club' }),
      );

      const created = await service.createFeature('admin-1', {
        section: LandingSection.Gathering,
        targetId: 'e-1',
        copy: { blurb: 'Editor pick' },
      });

      expect(created.eligible).toBe(true);
      expect(created.target?.slug).toBe('supper-club');
    });

    it('rejects a story that is not published yet', async () => {
      articles.findOne.mockResolvedValue(
        makeArticle({ id: 'a-1', publishedAt: null }),
      );

      await expect(
        service.createFeature('admin-1', {
          section: LandingSection.Story,
          targetId: 'a-1',
          copy: {},
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects a published translation so each piece is featured once', async () => {
      articles.findOne.mockResolvedValue(
        makeArticle({ id: 'a-pt', translationOfArticleId: 'a-en' }),
      );

      await expect(
        service.createFeature('admin-1', {
          section: LandingSection.Story,
          targetId: 'a-pt',
          copy: {},
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe('stories and translations', () => {
    it('drops a curated translation from the public read', async () => {
      landingFeatures.find.mockImplementation(
        ({ where }: { where: { section: LandingSection } }) => {
          if (where.section !== LandingSection.Story) return [];
          return ['a-en', 'a-pt'].map((targetId, position) =>
            makeFeature({
              id: `f-${targetId}`,
              section: LandingSection.Story,
              targetId,
              position,
              copy: {},
            }),
          );
        },
      );
      articles.find.mockResolvedValue([
        makeArticle({ id: 'a-en', slug: 'original-story' }),
        makeArticle({
          id: 'a-pt',
          slug: 'historia-traduzida',
          translationOfArticleId: 'a-en',
        }),
      ]);
      authors.find.mockResolvedValue([makeAuthor({})]);

      const result = await service.getPublicFeatures();

      expect(result.stories.map((story) => story.slug)).toEqual([
        'original-story',
      ]);
    });

    it('labels a curated translation not_public on the admin roster', async () => {
      landingFeatures.find.mockResolvedValue([
        makeFeature({
          id: 'f-pt',
          section: LandingSection.Story,
          targetId: 'a-pt',
          copy: {},
        }),
      ]);
      articles.find.mockResolvedValue([
        makeArticle({ id: 'a-pt', translationOfArticleId: 'a-en' }),
      ]);

      const roster = await service.listAdminFeatures(LandingSection.Story);

      expect(roster.map((row) => [row.eligible, row.hiddenReason])).toEqual([
        [false, 'not_public'],
      ]);
    });

    it('keeps translations out of the story picker query', async () => {
      const storyQuery = qbStub();
      articles.createQueryBuilder.mockReturnValue(storyQuery);

      await service.listEligible(LandingSection.Story);

      expect(storyQuery.andWhere).toHaveBeenCalledWith(
        '"story"."translation_of_article_id" IS NULL',
      );
    });
  });

  describe('listAdminFeatures (gatherings)', () => {
    it('labels a cancelled gathering and an ended one with their reasons', async () => {
      landingFeatures.find.mockResolvedValue([
        makeFeature({
          id: 'f-cancelled',
          section: LandingSection.Gathering,
          targetId: 'e-cancelled',
          copy: {},
        }),
        makeFeature({
          id: 'f-ended',
          section: LandingSection.Gathering,
          targetId: 'e-ended',
          copy: {},
        }),
      ]);
      events.find.mockResolvedValue([
        makeEvent({ id: 'e-cancelled', status: EventStatus.Cancelled }),
        makeEvent({
          id: 'e-ended',
          startAt: new Date(Date.now() - ONE_DAY_MS),
        }),
      ]);

      const rows = await service.listAdminFeatures(LandingSection.Gathering);

      expect(rows.map((row) => [row.eligible, row.hiddenReason])).toEqual([
        [false, 'cancelled'],
        [false, 'ended'],
      ]);
    });
  });

  describe('reorderFeatures', () => {
    it('rewrites positions to contiguous 0..n-1 in the given id order', async () => {
      const featuresStore: LandingFeature[] = [
        makeFeature({
          id: 'f-a',
          section: LandingSection.Community,
          targetId: 'c-a',
          position: 5,
        }),
        makeFeature({
          id: 'f-b',
          section: LandingSection.Community,
          targetId: 'c-b',
          position: 6,
        }),
        makeFeature({
          id: 'f-c',
          section: LandingSection.Community,
          targetId: 'c-c',
          position: 7,
        }),
      ];
      // `listAdminFeatures` re-reads the section via the outer `landingFeatures`
      // repo AFTER the transaction commits, kept in sync with the same
      // `featuresStore` the transactional lock/update below mutate.
      landingFeatures.find.mockImplementation(
        ({
          where,
          order,
        }: {
          where: { section: LandingSection };
          order?: { position: 'ASC' };
        }) => {
          const rows = featuresStore.filter(
            (feature) => feature.section === where.section,
          );
          return order?.position === 'ASC'
            ? [...rows].sort((a, b) => a.position - b.position)
            : rows;
        },
      );
      // The in-transaction lock+validate read (`manager.createQueryBuilder(...)
      // .getMany()`) reads from the same store.
      manager.createQueryBuilder.mockImplementation(() => {
        const qb = qbStub();
        qb.getMany = jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve(
              featuresStore.filter(
                (feature) => feature.section === LandingSection.Community,
              ),
            ),
          );
        return qb;
      });
      const updateSpy = jest.fn(
        (
          _entity: unknown,
          criteria: { id: string },
          partial: Partial<LandingFeature>,
        ) => {
          const row = featuresStore.find(
            (feature) => feature.id === criteria.id,
          );
          if (row) Object.assign(row, partial);
        },
      );
      manager.update = updateSpy;
      communities.find.mockResolvedValue([
        makeCommunity({ id: 'c-a', slug: 'community-a' }),
        makeCommunity({ id: 'c-b', slug: 'community-b' }),
        makeCommunity({ id: 'c-c', slug: 'community-c' }),
      ]);

      const result = await service.reorderFeatures({
        section: LandingSection.Community,
        orderedIds: ['f-c', 'f-a', 'f-b'],
      });

      expect(updateSpy).toHaveBeenCalledTimes(3);
      expect(result.map((feature) => feature.id)).toEqual([
        'f-c',
        'f-a',
        'f-b',
      ]);
      expect(result.map((feature) => feature.position)).toEqual([0, 1, 2]);
    });

    it("rejects when orderedIds does not match the section's current feature ids", async () => {
      // Validation now happens INSIDE the transaction (under the row lock),
      // so the read it validates against comes from `manager`, the
      // transactional handle used throughout this test.
      manager.createQueryBuilder.mockImplementation(() => {
        const qb = qbStub();
        qb.getMany = jest
          .fn()
          .mockResolvedValue([
            makeFeature({ id: 'f-a', section: LandingSection.Community }),
            makeFeature({ id: 'f-b', section: LandingSection.Community }),
          ]);
        return qb;
      });

      await expect(
        service.reorderFeatures({
          section: LandingSection.Community,
          orderedIds: ['f-a'], // missing f-b
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // The transaction DOES open (the lock+validate read happens inside it),
      // it just never reaches the position-rewrite loop.
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    });
  });
});
