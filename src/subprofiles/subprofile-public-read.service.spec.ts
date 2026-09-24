import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import {
  Event,
  EventStatus,
  EventVisibility,
} from '../events/entities/event.entity';
import { Handle } from '../handles/entities/handle.entity';
import { HandlesService } from '../handles/handles.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { BlockFilterService } from '../social/block-filter.service';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { DIRECTORY_MAX_LIMIT } from './dto/list-directory.query';
import {
  Subprofile,
  SubprofileKind,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';
import { SubprofileAddressHistory } from './entities/subprofile-address-history.entity';
import { SubprofileAffiliation } from './entities/subprofile-affiliation.entity';
import {
  eligibilityKey,
  SubprofileAffiliationEligibilityService,
} from './subprofile-affiliation-eligibility.service';
import { SubprofileItem } from './entities/subprofile-item.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import { SubprofileSocialLink } from './entities/subprofile-social-link.entity';
import { SubprofileEndorsementsService } from './subprofile-endorsements.service';
import { SubprofileFollowersService } from './subprofile-followers.service';
import { SubprofileMembershipService } from './subprofile-membership.service';
import { SubprofilePublicReadService } from './subprofile-public-read.service';

// --- fixtures ---------------------------------------------------------------

function makeSubprofile(overrides: Partial<Subprofile> = {}): Subprofile {
  return {
    id: 'sp-1',
    userId: 'user-1',
    user: undefined as never,
    kind: SubprofileKind.Developer,
    slug: 'nightform',
    handle: 'nightform',
    displayName: 'Nightform',
    avatarUrl: null,
    tagline: null,
    bio: null,
    coverUrl: null,
    accent: null,
    availability: null,
    ctaLabel: null,
    ctaUrl: null,
    linkVisibility: SubprofileLinkVisibility.Unlinked,
    visibility: SubprofileVisibility.Open,
    status: SubprofileStatus.Published,
    position: 0,
    skinData: null,
    removedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Answers a TypeORM `findOne({ where })` from a fixed row list: a row matches
// when every key in `where` equals the row's own value. Enough for the plain
// equality lookups the forwarding reads make.
function findOneFrom<Row extends object>(rows: Row[]) {
  return ({ where }: { where: Record<string, unknown> }): Promise<Row | null> =>
    Promise.resolve(
      rows.find((row) =>
        Object.entries(where).every(
          ([key, value]) => (row as Record<string, unknown>)[key] === value,
        ),
      ) ?? null,
    );
}

// Resolves to whatever the promise rejected with, so a test can read the
// thrown response body directly. Fails the test if the promise resolves.
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject');
}

// Stubs the fluent `createQueryBuilder('sp')` chain `directory()` builds:
// every chained method (`select`/`where`/`andWhere`/`orderBy`/`addOrderBy`/
// `offset`/`limit`) returns the builder itself so calls compose exactly like the real
// TypeORM `SelectQueryBuilder` — no real query builder is constructed, but
// EVERY method the real `directory()` calls is implemented here (unlike the
// former stub in `subprofiles.service.spec.ts`, which predated offset
// pagination). Declared with explicit (non-index-signature) fields so each
// one reads back as a plain `jest.Mock`, not `jest.Mock | undefined`, under
// this repo's `noUncheckedIndexedAccess`. `getCount` and `getMany` are
// independently controllable so a test can prove `total` really comes from
// `getCount()`, not from `rows.length`.
interface DirectoryQueryBuilderStub {
  select: jest.Mock<DirectoryQueryBuilderStub, [string[]]>;
  where: jest.Mock<
    DirectoryQueryBuilderStub,
    [string, Record<string, unknown>?]
  >;
  andWhere: jest.Mock<
    DirectoryQueryBuilderStub,
    [string, Record<string, unknown>?]
  >;
  // The owner join `directory()` adds on the SEARCH path only, so the free-text
  // branch can match a linked persona by its owner's name.
  leftJoin: jest.Mock<
    DirectoryQueryBuilderStub,
    [unknown, string, string?, Record<string, unknown>?]
  >;
  orderBy: jest.Mock<DirectoryQueryBuilderStub, [string, 'ASC' | 'DESC']>;
  addOrderBy: jest.Mock<DirectoryQueryBuilderStub, [string, 'ASC' | 'DESC']>;
  offset: jest.Mock<DirectoryQueryBuilderStub, [number]>;
  limit: jest.Mock<DirectoryQueryBuilderStub, [number]>;
  getMany: jest.Mock<Promise<Subprofile[]>, []>;
  getCount: jest.Mock<Promise<number>, []>;
}
function makeSubprofilesQueryBuilderStub(
  rows: Subprofile[],
  count: number = rows.length,
): DirectoryQueryBuilderStub {
  const queryBuilder = {} as DirectoryQueryBuilderStub;
  queryBuilder.select = jest
    .fn<DirectoryQueryBuilderStub, [string[]]>()
    .mockReturnValue(queryBuilder);
  queryBuilder.where = jest
    .fn<DirectoryQueryBuilderStub, [string, Record<string, unknown>?]>()
    .mockReturnValue(queryBuilder);
  queryBuilder.andWhere = jest
    .fn<DirectoryQueryBuilderStub, [string, Record<string, unknown>?]>()
    .mockReturnValue(queryBuilder);
  queryBuilder.leftJoin = jest
    .fn<
      DirectoryQueryBuilderStub,
      [unknown, string, string?, Record<string, unknown>?]
    >()
    .mockReturnValue(queryBuilder);
  queryBuilder.orderBy = jest
    .fn<DirectoryQueryBuilderStub, [string, 'ASC' | 'DESC']>()
    .mockReturnValue(queryBuilder);
  queryBuilder.addOrderBy = jest
    .fn<DirectoryQueryBuilderStub, [string, 'ASC' | 'DESC']>()
    .mockReturnValue(queryBuilder);
  queryBuilder.offset = jest
    .fn<DirectoryQueryBuilderStub, [number]>()
    .mockReturnValue(queryBuilder);
  queryBuilder.limit = jest
    .fn<DirectoryQueryBuilderStub, [number]>()
    .mockReturnValue(queryBuilder);
  queryBuilder.getMany = jest
    .fn<Promise<Subprofile[]>, []>()
    .mockResolvedValue(rows);
  queryBuilder.getCount = jest
    .fn<Promise<number>, []>()
    .mockResolvedValue(count);
  return queryBuilder;
}

// Stubs the grouped-count `createQueryBuilder('socialLink')` chain
// `loadSocialCountsFor` builds (`.select().addSelect().where().groupBy()
// .getRawMany()`). Only `getRawMany`'s resolved value varies per test.
interface SocialCountsQueryBuilderStub {
  select: jest.Mock;
  addSelect: jest.Mock;
  where: jest.Mock;
  groupBy: jest.Mock;
  getRawMany: jest.Mock;
}
function makeSocialCountsQueryBuilderStub(
  rawRows: { subprofileId: string; count: string }[],
): SocialCountsQueryBuilderStub {
  const queryBuilder = {} as SocialCountsQueryBuilderStub;
  queryBuilder.select = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.addSelect = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.where = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.groupBy = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.getRawMany = jest.fn().mockResolvedValue(rawRows);
  return queryBuilder;
}

describe('SubprofilePublicReadService', () => {
  let service: SubprofilePublicReadService;
  let subprofiles: { createQueryBuilder: jest.Mock; findOne: jest.Mock };
  let socialLinks: { createQueryBuilder: jest.Mock; find: jest.Mock };
  let items: { find: jest.Mock };
  let profiles: { find: jest.Mock; findOne: jest.Mock };
  let addressHistory: { findOne: jest.Mock };
  let followersService: {
    loadFollowerCountsFor: jest.Mock;
    viewerFollowingFor: jest.Mock;
  };
  let blockFilter: {
    excludeBlocked: jest.Mock;
    isBlockedEitherWay: jest.Mock;
    blockedUserIds: jest.Mock;
  };
  let handles: {
    previousSubprofileOwnerOf: jest.Mock;
    previousProfileOwnerOf: jest.Mock;
  };
  let contentModeration: { stateFor: jest.Mock; statesFor: jest.Mock };
  let membership: { isMember: jest.Mock };
  // "Part of" eligibility. Defaults to "no owners, nothing eligible", which
  // only matters to a test that resolves affiliation rows.
  let affiliationEligibility: {
    ownerIdsFor: jest.Mock;
    eligibleTargetKeys: jest.Mock;
  };
  let module: TestingModule;

  beforeEach(async () => {
    subprofiles = {
      createQueryBuilder: jest.fn(),
      findOne: jest.fn().mockResolvedValue(null),
    };
    // Neither `loadSocialCountsFor` nor its `socialLinks` dependency is
    // exercised unless a test's rows have at least one id — default to an
    // empty grouped result so a test that doesn't care about socialCount is
    // unaffected.
    socialLinks = {
      createQueryBuilder: jest
        .fn()
        .mockReturnValue(makeSocialCountsQueryBuilderStub([])),
      find: jest.fn().mockResolvedValue([]),
    };
    items = { find: jest.fn().mockResolvedValue([]) };
    profiles = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    // No old addresses by default, so every pre-existing not-found case keeps
    // its plain 404.
    addressHistory = { findOne: jest.fn().mockResolvedValue(null) };
    followersService = {
      loadFollowerCountsFor: jest
        .fn()
        .mockResolvedValue(new Map<string, number>()),
      viewerFollowingFor: jest.fn().mockResolvedValue(new Set<string>()),
    };
    blockFilter = {
      excludeBlocked: jest.fn(),
      isBlockedEitherWay: jest.fn().mockResolvedValue(false),
      blockedUserIds: jest.fn().mockResolvedValue(new Set<string>()),
    };
    // PRD-204 reclaim lookups. Both answer "nobody" by default, so every
    // pre-existing not-found case here keeps its plain 404.
    handles = {
      previousSubprofileOwnerOf: jest.fn().mockResolvedValue(null),
      previousProfileOwnerOf: jest.fn().mockResolvedValue(null),
    };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
      statesFor: jest.fn().mockResolvedValue(new Map()),
    };
    membership = { isMember: jest.fn().mockResolvedValue(false) };
    affiliationEligibility = {
      ownerIdsFor: jest.fn().mockResolvedValue(new Map<string, string[]>()),
      eligibleTargetKeys: jest.fn().mockResolvedValue(new Set<string>()),
    };

    module = await Test.createTestingModule({
      providers: [
        SubprofilePublicReadService,
        { provide: getRepositoryToken(Subprofile), useValue: subprofiles },
        { provide: getRepositoryToken(SubprofileItem), useValue: items },
        {
          provide: getRepositoryToken(SubprofileSocialLink),
          useValue: socialLinks,
        },
        {
          provide: getRepositoryToken(SubprofileAffiliation),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(SubprofileMember),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(Event),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(Community),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        {
          provide: getRepositoryToken(SubprofileAddressHistory),
          useValue: addressHistory,
        },
        {
          provide: getRepositoryToken(Handle),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: HandlesService, useValue: handles },
        { provide: ContentModerationService, useValue: contentModeration },
        {
          provide: SubprofileEndorsementsService,
          useValue: {
            loadEndorsementCountsFor: jest
              .fn()
              .mockResolvedValue(new Map<string, number>()),
            viewerEndorsedFor: jest.fn().mockResolvedValue(new Set<string>()),
          },
        },
        { provide: SubprofileFollowersService, useValue: followersService },
        { provide: SubprofileMembershipService, useValue: membership },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        {
          provide: SubprofileAffiliationEligibilityService,
          useValue: affiliationEligibility,
        },
      ],
    }).compile();

    service = module.get(SubprofilePublicReadService);
  });

  // --- directory ---------------------------------------------------------

  describe('directory', () => {
    it('reads getCount() BEFORE paging is applied, and total comes from getCount(), not rows.length', async () => {
      const rows = [
        makeSubprofile({ id: 'sp-a' }),
        makeSubprofile({ id: 'sp-b' }),
      ];
      // getCount deliberately disagrees with rows.length (37 vs. 2) so a
      // test that passed merely because `total === rows.length` cannot
      // slip through — this proves `total` is really read off `getCount()`.
      const qb = makeSubprofilesQueryBuilderStub(rows, 37);
      subprofiles.createQueryBuilder.mockReturnValue(qb);

      const result = await service.directory({}, 'viewer-1');

      expect(result.total).toBe(37);
      expect(qb.getCount).toHaveBeenCalledTimes(1);
      // Ordering: getCount() must fire before offset()/limit() are chained
      // on (mirrors the production comment: computed BEFORE the page window
      // is applied, so it reflects the SAME filtered query pre-paging).
      const getCountOrder = qb.getCount.mock.invocationCallOrder[0]!;
      const offsetOrder = qb.offset.mock.invocationCallOrder[0]!;
      const limitOrder = qb.limit.mock.invocationCallOrder[0]!;
      expect(getCountOrder).toBeLessThan(offsetOrder);
      expect(getCountOrder).toBeLessThan(limitOrder);
    });

    it('constrains the base query to published, open, not-removed personas', async () => {
      const rows = [makeSubprofile({ id: 'sp-a' })];
      const qb = makeSubprofilesQueryBuilderStub(rows);
      subprofiles.createQueryBuilder.mockReturnValue(qb);

      await service.directory({}, 'viewer-1');

      // The three base constraints every directory row must satisfy,
      // asserted with the EXACT SQL fragment + param shape production
      // passes (subprofile-public-read.service.ts directory(), the three
      // `.where()`/`.andWhere()` calls right after `.select([...])`):
      // published status, open visibility, and not removed. `.where(...)`
      // opens the WHERE clause; the other two chain on via `.andWhere(...)`.
      expect(qb.where).toHaveBeenCalledWith('sp.status = :published', {
        published: SubprofileStatus.Published,
      });
      expect(qb.andWhere).toHaveBeenCalledWith('sp.visibility = :open', {
        open: SubprofileVisibility.Open,
      });
      expect(qb.andWhere).toHaveBeenCalledWith('sp.removedAt IS NULL');
    });

    it('derives offset/limit from page/limit, capped at DIRECTORY_MAX_LIMIT', async () => {
      const rows = [makeSubprofile({ id: 'sp-a' })];
      const qb = makeSubprofilesQueryBuilderStub(rows);
      subprofiles.createQueryBuilder.mockReturnValue(qb);

      const result = await service.directory(
        { page: 3, limit: 500 }, // 500 exceeds DIRECTORY_MAX_LIMIT (100)
        'viewer-1',
      );

      expect(qb.limit).toHaveBeenCalledWith(DIRECTORY_MAX_LIMIT);
      expect(qb.offset).toHaveBeenCalledWith((3 - 1) * DIRECTORY_MAX_LIMIT);
      expect(result.page).toBe(3);
      expect(result.limit).toBe(DIRECTORY_MAX_LIMIT);
    });

    it('applies the kind filter and LIKE-escapes a text query before wrapping it in wildcards', async () => {
      const rows = [makeSubprofile({ id: 'sp-a' })];
      const qb = makeSubprofilesQueryBuilderStub(rows);
      subprofiles.createQueryBuilder.mockReturnValue(qb);

      await service.directory(
        { kind: SubprofileKind.Musician, query: '50% off_grid' },
        'viewer-1',
      );

      expect(qb.andWhere).toHaveBeenCalledWith('sp.kind = :kind', {
        kind: SubprofileKind.Musician,
      });
      // `%` and `_` (LIKE metacharacters) are backslash-escaped BEFORE the
      // literal is wrapped in its own wildcard `%...%` pair, so a search for
      // a literal "50% off_grid" cannot accidentally become a wildcard match.
      // Asserted structurally rather than against the whole predicate string:
      // the owner branch splices in `foldedHaystack`'s generated SQL, and
      // pinning that here would only restate `search-text.ts` (which
      // `search-text.spec.ts` already pins against its own index migration).
      const searchCall = qb.andWhere.mock.calls.find((call) =>
        call[0].includes('sp.displayName ILIKE :term'),
      );
      expect(searchCall).toBeDefined();
      expect(searchCall?.[0]).toContain('sp.tagline ILIKE :term');
      expect(searchCall?.[1]).toMatchObject({ term: '%50\\% off\\_grid%' });
    });

    it('also matches a LINKED persona by its owner name, folded, and never an unlinked one', async () => {
      const rows = [makeSubprofile({ id: 'sp-a' })];
      const qb = makeSubprofilesQueryBuilderStub(rows);
      subprofiles.createQueryBuilder.mockReturnValue(qb);

      await service.directory({ query: 'Joao' }, 'viewer-1');

      // The owner is joined 1:1 off `sp.userId` so the name behind a linked
      // card is searchable at all.
      expect(qb.leftJoin).toHaveBeenCalledWith(
        Profile,
        'owner',
        'owner.userId = sp.userId',
      );
      const searchCall = qb.andWhere.mock.calls.find((call) =>
        call[0].includes('sp.displayName ILIKE :term'),
      );
      expect(searchCall).toBeDefined();
      // THE anonymity rule: the owner branch only fires for a persona whose
      // link visibility already puts the owner's name on the card. Without this
      // gate, searching a member's name would surface the anonymous personas
      // they run — the exact tie `toCardDTO` withholds.
      expect(searchCall?.[0]).toContain('sp.linkVisibility = :linkedForSearch');
      expect(searchCall?.[1]).toMatchObject({
        linkedForSearch: SubprofileLinkVisibility.Linked,
        // Folded on both sides, so "Joao" finds "João" — the same escaped,
        // wildcard-wrapped literal the persona-side branch binds.
        ownerTerm: '%Joao%',
      });
      // `translate(lower(...))` is `foldedHaystack`'s signature: the owner name
      // is compared accent-folded, not by a bare ILIKE.
      expect(searchCall?.[0]).toContain('translate(lower(');
      expect(searchCall?.[0]).toContain('"owner"."first_name"');
      expect(searchCall?.[0]).toContain('"owner"."last_name"');
    });

    it('does not join the owner table when there is no search term', async () => {
      const rows = [makeSubprofile({ id: 'sp-a' })];
      const qb = makeSubprofilesQueryBuilderStub(rows);
      subprofiles.createQueryBuilder.mockReturnValue(qb);

      await service.directory({}, 'viewer-1');

      // An unsearched browse is the common case and pays nothing for a join it
      // has no predicate for.
      expect(qb.leftJoin).not.toHaveBeenCalled();
    });

    it('withholds a moderated/taken-down persona via an in-query NOT EXISTS clause', async () => {
      const rows = [makeSubprofile({ id: 'sp-a' })];
      const qb = makeSubprofilesQueryBuilderStub(rows);
      subprofiles.createQueryBuilder.mockReturnValue(qb);

      await service.directory({}, 'viewer-1');

      const moderatedCall = qb.andWhere.mock.calls.find((call) =>
        call[0].includes('NOT EXISTS'),
      );
      expect(moderatedCall).toBeDefined();
      expect(moderatedCall![0]).toEqual(
        expect.stringContaining('content_moderation'),
      );
      expect(moderatedCall![1]).toEqual({
        subprofileSubjectType: 'subprofile',
      });
    });

    it('excludes personas blocked either way via blockFilter.excludeBlocked, against the raw snake_case column', async () => {
      const rows = [makeSubprofile({ id: 'sp-a' })];
      const qb = makeSubprofilesQueryBuilderStub(rows);
      subprofiles.createQueryBuilder.mockReturnValue(qb);

      await service.directory({}, 'viewer-42');

      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        qb,
        'viewer-42',
        '"sp"."user_id"',
      );
    });

    it('feeds each card the REAL batched follower/social/tags/owner reads, never a per-card query', async () => {
      const unlinkedRow = makeSubprofile({
        id: 'sp-a',
        handle: 'nightform',
        userId: 'creator-1',
        linkVisibility: SubprofileLinkVisibility.Unlinked,
      });
      const linkedRow = makeSubprofile({
        id: 'sp-b',
        handle: null,
        slug: 'starlet',
        displayName: 'Starlet',
        userId: 'owner-2',
        linkVisibility: SubprofileLinkVisibility.Linked,
      });
      const qb = makeSubprofilesQueryBuilderStub([unlinkedRow, linkedRow]);
      subprofiles.createQueryBuilder.mockReturnValue(qb);
      followersService.loadFollowerCountsFor.mockResolvedValue(
        new Map([
          ['sp-a', 12],
          ['sp-b', 0],
        ]),
      );
      socialLinks.createQueryBuilder.mockReturnValue(
        makeSocialCountsQueryBuilderStub([
          { subprofileId: 'sp-a', count: '3' },
        ]),
      );
      items.find.mockResolvedValue([
        { subprofileId: 'sp-a', tags: ['queer', 'art'] },
      ]);
      profiles.find.mockResolvedValue([
        {
          userId: 'owner-2',
          slug: 'starlet-owner',
          firstName: 'Ana',
          lastName: 'Reis',
        },
      ]);

      const result = await service.directory({}, 'viewer-1');

      // ONE grouped call per batch, over every row id on the page — never a
      // per-card call.
      expect(followersService.loadFollowerCountsFor).toHaveBeenCalledTimes(1);
      expect(followersService.loadFollowerCountsFor).toHaveBeenCalledWith([
        'sp-a',
        'sp-b',
      ]);
      // Owner identity resolution is batched over ONLY the linked rows'
      // userIds, and pulls the name parts on the SAME query as the slug — the
      // card's "Owner Name | Poet" title must never cost an extra read.
      expect(profiles.find).toHaveBeenCalledWith({
        where: { userId: In(['owner-2']) },
        select: ['userId', 'slug', 'firstName', 'lastName'],
      });

      const nightformCard = result.items.find(
        (card) => card.handle === 'nightform',
      );
      expect(nightformCard?.followerCount).toBe(12);
      expect(nightformCard?.socialCount).toBe(3);
      expect(nightformCard?.tags).toEqual(['queer', 'art']);
      // Never leaked for an unlinked persona, even though `profiles.find`
      // only ever resolves linked rows.
      expect(nightformCard?.ownerSlug).toBeNull();
      expect(nightformCard?.ownerName).toBeNull();

      const starletCard = result.items.find(
        (card) => card.displayName === 'Starlet',
      );
      expect(starletCard?.followerCount).toBe(0);
      expect(starletCard?.socialCount).toBe(0); // missing from the batched map
      expect(starletCard?.tags).toEqual([]);
      expect(starletCard?.ownerSlug).toBe('starlet-owner');
      // Composed from the profile's name parts, exactly like the public DTO's
      // `SubprofileOwnerRef.name`.
      expect(starletCard?.ownerName).toBe('Ana Reis');
    });
  });

  // --- nested persona forwarding after a creator handoff --------------------

  describe('getBySlugForProfile forwarding after a creator handoff', () => {
    interface ProfileRow {
      userId: string;
      slug: string;
      firstName: string;
      lastName: string;
    }
    interface AddressHistoryRow {
      previousUserId: string;
      slug: string;
      subprofileId: string;
    }

    const activeViewer: CurrentUserData = {
      userId: 'viewer-1',
      email: 'viewer@example.com',
      status: UserStatus.Active,
      role: 'member',
    };

    let profileRows: ProfileRow[];
    let personaRows: Subprofile[];
    let historyRows: AddressHistoryRow[];
    let rehomedPersona: Subprofile;

    beforeEach(() => {
      // Ana created "nightform", then left it. Bea, the longest-standing
      // co-owner, became its creator, and the slug collided with one of Bea's
      // own personas, so it now lives at /members/bea/nightform-2.
      profileRows = [
        {
          userId: 'creator-old',
          slug: 'ana',
          firstName: 'Ana',
          lastName: 'Reis',
        },
        {
          userId: 'creator-new',
          slug: 'bea',
          firstName: 'Bea',
          lastName: 'Lima',
        },
      ];
      rehomedPersona = makeSubprofile({
        id: 'sp-rehomed',
        userId: 'creator-new',
        slug: 'nightform-2',
        handle: null,
        linkVisibility: SubprofileLinkVisibility.Linked,
      });
      personaRows = [rehomedPersona];
      historyRows = [
        {
          previousUserId: 'creator-old',
          slug: 'nightform',
          subprofileId: 'sp-rehomed',
        },
      ];
      profiles.findOne.mockImplementation(findOneFrom(profileRows));
      subprofiles.findOne.mockImplementation(findOneFrom(personaRows));
      addressHistory.findOne.mockImplementation(findOneFrom(historyRows));
    });

    function responseBodyOf(error: unknown): Record<string, unknown> {
      expect(error).toBeInstanceOf(NotFoundException);
      return (error as NotFoundException).getResponse() as Record<
        string,
        unknown
      >;
    }

    it('forwards the old nested address to the current creator slug and persona slug', async () => {
      const error = await rejectionOf(
        service.getBySlugForProfile('ana', 'nightform', activeViewer),
      );

      expect(responseBodyOf(error)).toEqual({
        code: 'PERSONA_REHOMED',
        message: 'That persona has a new address',
        ownerSlug: 'bea',
        slug: 'nightform-2',
      });
      expect(addressHistory.findOne).toHaveBeenCalledWith({
        where: { previousUserId: 'creator-old', slug: 'nightform' },
        select: { subprofileId: true },
      });
    });

    it('forwards an anonymous visitor to an open persona', async () => {
      const error = await rejectionOf(
        service.getBySlugForProfile('ana', 'nightform', undefined),
      );

      expect(responseBodyOf(error)).toMatchObject({
        code: 'PERSONA_REHOMED',
        ownerSlug: 'bea',
        slug: 'nightform-2',
      });
      // An anonymous visitor has no account to block anyone, so no block
      // lookup runs and the cacheable anonymous answer stays viewer-independent.
      expect(blockFilter.isBlockedEitherWay).not.toHaveBeenCalled();
    });

    it.each<{ state: string; arrange: () => void }>([
      {
        state: 'a draft',
        arrange: () => {
          rehomedPersona.status = SubprofileStatus.Draft;
        },
      },
      {
        state: 'private',
        arrange: () => {
          rehomedPersona.visibility = SubprofileVisibility.Private;
        },
      },
    ])(
      'forwards a co-owner of the persona even while it is $state',
      async ({ arrange }) => {
        arrange();
        membership.isMember.mockImplementation(
          (userId: string, subprofileId: string) =>
            Promise.resolve(
              userId === 'viewer-1' && subprofileId === 'sp-rehomed',
            ),
        );

        const error = await rejectionOf(
          service.getBySlugForProfile('ana', 'nightform', activeViewer),
        );

        expect(responseBodyOf(error)).toMatchObject({
          code: 'PERSONA_REHOMED',
          ownerSlug: 'bea',
          slug: 'nightform-2',
        });
      },
    );

    it('serves a live linked persona at the requested address and never reads the history', async () => {
      personaRows.push(
        makeSubprofile({
          id: 'sp-live',
          userId: 'creator-old',
          slug: 'nightform',
          handle: null,
          linkVisibility: SubprofileLinkVisibility.Linked,
        }),
      );

      const view = await service.getBySlugForProfile(
        'ana',
        'nightform',
        activeViewer,
      );

      expect(view.id).toBe('sp-live');
      expect(addressHistory.findOne).not.toHaveBeenCalled();
    });

    it('still forwards when the old creator holds an UNLINKED persona under the same slug', async () => {
      // An unlinked persona could never answer this route, and letting it
      // suppress the forward would reveal that the member runs it.
      personaRows.push(
        makeSubprofile({
          id: 'sp-anonymous',
          userId: 'creator-old',
          slug: 'nightform',
          handle: 'nightform',
          linkVisibility: SubprofileLinkVisibility.Unlinked,
        }),
      );

      const error = await rejectionOf(
        service.getBySlugForProfile('ana', 'nightform', activeViewer),
      );

      expect(responseBodyOf(error)).toMatchObject({
        code: 'PERSONA_REHOMED',
        ownerSlug: 'bea',
        slug: 'nightform-2',
      });
    });

    it('gives the plain 404 when no old address matches', async () => {
      const error = await rejectionOf(
        service.getBySlugForProfile('ana', 'somebody-else', activeViewer),
      );

      const body = responseBodyOf(error);
      expect(body.message).toBe('Subprofile not found');
      expect(body.code).toBeUndefined();
    });

    it.each<{
      reason: string;
      viewer: CurrentUserData | undefined;
      arrange: () => void;
    }>([
      {
        reason: 'the persona is private',
        viewer: activeViewer,
        arrange: () => {
          rehomedPersona.visibility = SubprofileVisibility.Private;
        },
      },
      {
        reason: 'the persona is network-only and the visitor is anonymous',
        viewer: undefined,
        arrange: () => {
          rehomedPersona.visibility = SubprofileVisibility.Network;
        },
      },
      {
        reason: 'the persona is a draft',
        viewer: activeViewer,
        arrange: () => {
          rehomedPersona.status = SubprofileStatus.Draft;
        },
      },
      {
        reason: 'the persona is removed',
        viewer: activeViewer,
        arrange: () => {
          rehomedPersona.removedAt = new Date();
        },
      },
      {
        reason: 'the persona is taken down',
        viewer: activeViewer,
        arrange: () => {
          contentModeration.stateFor.mockResolvedValue({
            hidden: true,
            removed: false,
          });
        },
      },
      {
        reason: 'the viewer and the new creator are blocked either way',
        viewer: activeViewer,
        arrange: () => {
          blockFilter.isBlockedEitherWay.mockImplementation(
            (viewerId: string, otherUserId: string) =>
              Promise.resolve(
                viewerId === 'viewer-1' && otherUserId === 'creator-new',
              ),
          );
        },
      },
      {
        // The forward would confirm the previous creator made this persona,
        // and before the handoff this viewer got the plain 404 here.
        reason: 'the viewer and the previous creator are blocked either way',
        viewer: activeViewer,
        arrange: () => {
          blockFilter.isBlockedEitherWay.mockImplementation(
            (viewerId: string, otherUserId: string) =>
              Promise.resolve(
                viewerId === 'viewer-1' && otherUserId === 'creator-old',
              ),
          );
        },
      },
      {
        reason: 'the persona went unlinked',
        viewer: activeViewer,
        arrange: () => {
          rehomedPersona.linkVisibility = SubprofileLinkVisibility.Unlinked;
        },
      },
      {
        reason: 'the new creator has no profile',
        viewer: activeViewer,
        arrange: () => {
          profileRows.splice(
            profileRows.findIndex((row) => row.userId === 'creator-new'),
            1,
          );
        },
      },
      {
        reason: 'the persona no longer exists',
        viewer: activeViewer,
        arrange: () => {
          personaRows.length = 0;
        },
      },
    ])(
      'withholds the forward as the plain 404 when $reason',
      async ({ viewer, arrange }) => {
        arrange();

        const error = await rejectionOf(
          service.getBySlugForProfile('ana', 'nightform', viewer),
        );

        const body = responseBodyOf(error);
        expect(body.message).toBe('Subprofile not found');
        expect(body.code).toBeUndefined();
        expect(body.ownerSlug).toBeUndefined();
      },
    );

    it('resolves a persona handed on twice straight to where it lives now', async () => {
      // Ana to Bea, then Bea to Cleo. Both old addresses point at the persona
      // id, so each lands on Cleo's current slug.
      profileRows.push({
        userId: 'creator-third',
        slug: 'cleo',
        firstName: 'Cleo',
        lastName: 'Sousa',
      });
      rehomedPersona.userId = 'creator-third';
      rehomedPersona.slug = 'nightform-3';
      historyRows.push({
        previousUserId: 'creator-new',
        slug: 'nightform-2',
        subprofileId: 'sp-rehomed',
      });

      const fromFirstAddress = await rejectionOf(
        service.getBySlugForProfile('ana', 'nightform', activeViewer),
      );
      const fromSecondAddress = await rejectionOf(
        service.getBySlugForProfile('bea', 'nightform-2', activeViewer),
      );

      for (const error of [fromFirstAddress, fromSecondAddress]) {
        expect(responseBodyOf(error)).toMatchObject({
          code: 'PERSONA_REHOMED',
          ownerSlug: 'cleo',
          slug: 'nightform-3',
        });
      }
    });

    describe('when the old creator has also renamed', () => {
      beforeEach(() => {
        // Ana is now "ana-new"; "ana" is still inside its reclaim cooldown.
        profileRows[0]!.slug = 'ana-new';
        handles.previousProfileOwnerOf.mockImplementation((slug: string) =>
          Promise.resolve(slug === 'ana' ? 'creator-old' : null),
        );
      });

      it('forwards an old address of a renamed creator to the new creator', async () => {
        const error = await rejectionOf(
          service.getBySlugForProfile('ana', 'nightform', activeViewer),
        );

        expect(responseBodyOf(error)).toEqual({
          code: 'PERSONA_REHOMED',
          message: 'That persona has a new address',
          ownerSlug: 'bea',
          slug: 'nightform-2',
        });
        expect(addressHistory.findOne).toHaveBeenCalledWith({
          where: { previousUserId: 'creator-old', slug: 'nightform' },
          select: { subprofileId: true },
        });
      });

      it('withholds it with the unknown-owner message when the persona is private', async () => {
        rehomedPersona.visibility = SubprofileVisibility.Private;

        const error = await rejectionOf(
          service.getBySlugForProfile('ana', 'nightform', activeViewer),
        );

        const body = responseBodyOf(error);
        expect(body.message).toBe('Profile not found');
        expect(body.code).toBeUndefined();
      });
    });
  });

  // --- resolveAffiliationsFor: owner eligibility ------------------------------

  describe('resolveAffiliationsFor owner eligibility', () => {
    beforeEach(() => {
      module
        .get<{
          find: jest.Mock;
        }>(getRepositoryToken(SubprofileAffiliation))
        .find.mockResolvedValue([
          {
            subprofileId: 'sp-1',
            targetType: 'community',
            targetSlug: 'book-club',
            role: 'member',
            position: 0,
          },
          {
            subprofileId: 'sp-1',
            targetType: 'community',
            targetSlug: 'former-club',
            role: 'member',
            position: 1,
          },
          {
            subprofileId: 'sp-1',
            targetType: 'event',
            targetSlug: 'pride-picnic',
            role: 'attending',
            position: 2,
          },
        ]);
      module
        .get<{ find: jest.Mock }>(getRepositoryToken(Community))
        .find.mockResolvedValue([
          {
            id: 'community-1',
            slug: 'book-club',
            name: 'Queer Book Club',
            accessTier: AccessTier.Public,
            ownerId: null,
          },
          {
            id: 'community-2',
            slug: 'former-club',
            name: 'Former Club',
            accessTier: AccessTier.Public,
            ownerId: null,
          },
        ]);
      module
        .get<{ find: jest.Mock }>(getRepositoryToken(Event))
        .find.mockResolvedValue([
          {
            id: 'event-1',
            slug: 'pride-picnic',
            title: 'Pride Picnic',
            status: EventStatus.Published,
            visibility: EventVisibility.Public,
            hostId: null,
            coverImageUrl: null,
          },
        ]);
      affiliationEligibility.ownerIdsFor.mockResolvedValue(
        new Map([['sp-1', ['user-1', 'co-owner-1']]]),
      );
    });

    it('keeps a link any owner still qualifies for and drops the one no owner does', async () => {
      // The co-owner is in the book club, the creator is going to the picnic,
      // and nobody is in the former club any more.
      affiliationEligibility.eligibleTargetKeys.mockResolvedValue(
        new Set([
          eligibilityKey('community', 'community-1', 'co-owner-1'),
          eligibilityKey('event', 'event-1', 'user-1'),
        ]),
      );

      const result = await service.resolveAffiliationsFor('viewer-1', ['sp-1']);

      expect(result.get('sp-1')).toEqual([
        {
          targetType: 'community',
          targetSlug: 'book-club',
          role: 'member',
          name: 'Queer Book Club',
          imageUrl: null,
        },
        {
          targetType: 'event',
          targetSlug: 'pride-picnic',
          role: 'attending',
          name: 'Pride Picnic',
          imageUrl: null,
        },
      ]);
      expect(affiliationEligibility.eligibleTargetKeys).toHaveBeenCalledWith(
        ['user-1', 'co-owner-1'],
        [expect.objectContaining({ id: 'event-1' })],
        ['community-1', 'community-2'],
      );
    });

    it('drops the link to an archived community even when the owner is still a member', async () => {
      module
        .get<{
          find: jest.Mock;
        }>(getRepositoryToken(SubprofileAffiliation))
        .find.mockResolvedValue([
          {
            subprofileId: 'sp-1',
            targetType: 'community',
            targetSlug: 'book-club',
            role: 'member',
            position: 0,
          },
          {
            subprofileId: 'sp-1',
            targetType: 'community',
            targetSlug: 'former-club',
            role: 'member',
            position: 1,
          },
        ]);
      module
        .get<{ find: jest.Mock }>(getRepositoryToken(Community))
        .find.mockResolvedValue([
          {
            id: 'community-1',
            slug: 'book-club',
            name: 'Queer Book Club',
            accessTier: AccessTier.Public,
            ownerId: null,
            archivedAt: null,
          },
          {
            id: 'community-2',
            slug: 'former-club',
            name: 'Former Club',
            accessTier: AccessTier.Public,
            ownerId: null,
            archivedAt: new Date('2026-09-01T00:00:00Z'),
          },
        ]);
      // The creator still belongs to both communities.
      affiliationEligibility.eligibleTargetKeys.mockResolvedValue(
        new Set([
          eligibilityKey('community', 'community-1', 'user-1'),
          eligibilityKey('community', 'community-2', 'user-1'),
        ]),
      );

      const result = await service.resolveAffiliationsFor('viewer-1', ['sp-1']);

      expect(result.get('sp-1')).toEqual([
        {
          targetType: 'community',
          targetSlug: 'book-club',
          role: 'member',
          name: 'Queer Book Club',
          imageUrl: null,
        },
      ]);
      expect(affiliationEligibility.eligibleTargetKeys).toHaveBeenCalledWith(
        ['user-1', 'co-owner-1'],
        [],
        ['community-1'],
      );
    });

    it('drops every link when no owner qualifies for any target', async () => {
      const result = await service.resolveAffiliationsFor('viewer-1', ['sp-1']);

      expect(result.get('sp-1')).toBeUndefined();
    });
  });
});
