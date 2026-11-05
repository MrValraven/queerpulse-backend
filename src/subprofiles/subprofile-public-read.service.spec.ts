import { ForbiddenException, NotFoundException } from '@nestjs/common';
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
import { Handle, HandleOwnerKind } from '../handles/entities/handle.entity';
import { HandlesService } from '../handles/handles.service';
import { notAdultListingSql } from '../listings/listing-team-visibility';
import { MediaCropService } from '../media-crops/media-crops.service';
import { BlockFilterService } from '../social/block-filter.service';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { foldedHaystack, foldedSearchTerm } from '../search/search-text';
import { DIRECTORY_MAX_LIMIT } from './dto/list-directory.query';
import { SubprofileCreditGraphService } from './subprofile-credit-graph.service';
import type { CardCreditsView } from './subprofile-credits-response';
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
import {
  SubprofileItem,
  SubprofileSection,
} from './entities/subprofile-item.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import { SubprofileSocialLink } from './entities/subprofile-social-link.entity';
import { SubprofileEndorsementsService } from './subprofile-endorsements.service';
import { SubprofileFollowersService } from './subprofile-followers.service';
import { SubprofileMembershipService } from './subprofile-membership.service';
import {
  DIRECTORY_FOLLOWER_COUNT_SQL,
  PERSONA_WALL_DAILY_SHUFFLE_SQL,
  PERSONA_WALL_ENDORSEMENT_COUNT_SQL,
  PERSONA_WALL_HAS_PHOTO_SQL,
  SubprofilePublicReadService,
} from './subprofile-public-read.service';
import type { PersonaWallFillOrder } from './persona-wall.constants';
import { restrictedAccessBody } from './subprofile-response';

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
    availabilityUpdatedAt: null,
    ctaLabel: null,
    ctaUrl: null,
    linkVisibility: SubprofileLinkVisibility.Unlinked,
    visibility: SubprofileVisibility.Open,
    status: SubprofileStatus.Published,
    position: 0,
    skinData: null,
    removedAt: null,
    // Task 6's edit counter on the entity (a required column).
    editVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const FLASH_DAY_EVENT_REF = {
  slug: 'members-night',
  title: 'Members night',
  startsAt: '2026-11-07T18:00:00.000Z',
  endsAt: '2026-11-07T22:00:00.000Z',
  venue: 'The Hall',
  neighbourhood: 'Alfama',
  isOnline: false,
  imageUrl: null,
};

function makeTattooItem(
  overrides: Partial<SubprofileItem> = {},
): SubprofileItem {
  return {
    id: 'item-1',
    subprofileId: 'sp-linked',
    section: SubprofileSection.FlashDays,
    title: 'Friday flash',
    subtitle: null,
    description: null,
    url: null,
    imageUrl: null,
    date: null,
    meta: null,
    tags: [],
    isFeatured: false,
    collaborators: [],
    structured: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  } as SubprofileItem;
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

// The `find({ where })` counterpart of `findOneFrom`: every matching row, in
// list order. `order`/`select` are ignored, so a test lists its rows in the
// order the real query would return them.
function findFrom<Row extends object>(rows: Row[]) {
  return ({ where }: { where: Record<string, unknown> }): Promise<Row[]> =>
    Promise.resolve(
      rows.filter((row) =>
        Object.entries(where).every(
          ([key, value]) => (row as Record<string, unknown>)[key] === value,
        ),
      ),
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
  // The page-1 facet counts (`countSubprofileDirectoryFacets`) run grouped and
  // aggregate reads over fresh builders from the same factory, and bind the
  // refinement's shared parameters on every builder.
  addSelect: jest.Mock<DirectoryQueryBuilderStub, [string, string?]>;
  groupBy: jest.Mock<DirectoryQueryBuilderStub, [string]>;
  setParameter: jest.Mock<DirectoryQueryBuilderStub, [string, unknown]>;
  getRawMany: jest.Mock<Promise<unknown[]>, []>;
  getRawOne: jest.Mock<Promise<unknown>, []>;
  getQueryAndParameters: jest.Mock<[string, unknown[]], []>;
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
  queryBuilder.addSelect = jest
    .fn<DirectoryQueryBuilderStub, [string, string?]>()
    .mockReturnValue(queryBuilder);
  queryBuilder.groupBy = jest
    .fn<DirectoryQueryBuilderStub, [string]>()
    .mockReturnValue(queryBuilder);
  queryBuilder.setParameter = jest
    .fn<DirectoryQueryBuilderStub, [string, unknown]>()
    .mockReturnValue(queryBuilder);
  queryBuilder.getRawMany = jest
    .fn<Promise<unknown[]>, []>()
    .mockResolvedValue([]);
  queryBuilder.getRawOne = jest
    .fn<Promise<unknown>, []>()
    .mockResolvedValue(undefined);
  queryBuilder.getQueryAndParameters = jest
    .fn<[string, unknown[]], []>()
    .mockReturnValue(['SELECT "sp"."id" FROM "subprofiles" "sp"', []]);
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

// The persona half of the directory search: display name and tagline as one
// accent-folded haystack (mirrors `PERSONA_SEARCH_HAYSTACK` in the service).
const PERSONA_SEARCH_PREDICATE = `${foldedHaystack('sp', ['display_name', 'tagline'])} LIKE ${foldedSearchTerm('term')}`;

describe('SubprofilePublicReadService', () => {
  let service: SubprofilePublicReadService;
  let subprofiles: {
    createQueryBuilder: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    // The works at read (`loadWorksAt`) runs on this manager.
    manager: { query: jest.Mock; find: jest.Mock };
  };
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
  // The `subprofile_members` repository: the directory's viewerIsMember read.
  let members: { find: jest.Mock };
  // The directory's card credits. Defaults to "nobody credited".
  let creditGraph: { loadCardCreditsFor: jest.Mock };
  // "Part of" eligibility. Defaults to "no owners, nothing eligible", which
  // only matters to a test that resolves affiliation rows.
  let affiliationEligibility: {
    ownerIdsFor: jest.Mock;
    eligibleTargetKeys: jest.Mock;
    resolveFlashDayEvents: jest.Mock;
  };
  let module: TestingModule;

  beforeEach(async () => {
    subprofiles = {
      createQueryBuilder: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      manager: {
        query: jest.fn().mockResolvedValue([]),
        find: jest.fn().mockResolvedValue([]),
      },
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
    members = { find: jest.fn().mockResolvedValue([]) };
    creditGraph = {
      loadCardCreditsFor: jest
        .fn()
        .mockResolvedValue(new Map<string, CardCreditsView>()),
    };
    affiliationEligibility = {
      ownerIdsFor: jest.fn().mockResolvedValue(new Map<string, string[]>()),
      eligibleTargetKeys: jest.fn().mockResolvedValue(new Set<string>()),
      resolveFlashDayEvents: jest.fn().mockResolvedValue(new Map()),
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
        { provide: getRepositoryToken(SubprofileMember), useValue: members },
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
        { provide: SubprofileCreditGraphService, useValue: creditGraph },
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
        call[0].includes(PERSONA_SEARCH_PREDICATE),
      );
      expect(searchCall).toBeDefined();
      expect(searchCall?.[0]).toContain(`${PERSONA_SEARCH_PREDICATE} ESCAPE`);
      expect(searchCall?.[1]).toMatchObject({ term: '%50\\% off\\_grid%' });
    });

    it('matches a profession alias against sp.kind, so "dm" finds every game master', async () => {
      const rows = [makeSubprofile({ id: 'sp-a' })];
      const qb = makeSubprofilesQueryBuilderStub(rows);
      subprofiles.createQueryBuilder.mockReturnValue(qb);

      await service.directory({ query: 'dm' }, 'viewer-1');

      const searchCall = qb.andWhere.mock.calls.find((call) =>
        call[0].includes(PERSONA_SEARCH_PREDICATE),
      );
      expect(searchCall).toBeDefined();
      expect(searchCall?.[0]).toContain('sp.kind IN (:...searchKinds)');
      expect(searchCall?.[1]?.searchKinds).toEqual(
        expect.arrayContaining([SubprofileKind.GameMaster]),
      );
    });

    it('keeps a plain word like "de" to name/tagline matches only, no kind branch', async () => {
      const rows = [makeSubprofile({ id: 'sp-a' })];
      const qb = makeSubprofilesQueryBuilderStub(rows);
      subprofiles.createQueryBuilder.mockReturnValue(qb);

      await service.directory({ query: 'de' }, 'viewer-1');

      const searchCall = qb.andWhere.mock.calls.find((call) =>
        call[0].includes(PERSONA_SEARCH_PREDICATE),
      );
      expect(searchCall).toBeDefined();
      expect(searchCall?.[0]).not.toContain('sp.kind IN (:...searchKinds)');
      expect(searchCall?.[1]?.searchKinds).toEqual([]);
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
        call[0].includes(PERSONA_SEARCH_PREDICATE),
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
      // Keyed on the persona uuid, which the report pipeline stores.
      expect(moderatedCall![0]).toEqual(
        expect.stringContaining('"cm"."subject_id" = "sp"."id"::text'),
      );
      expect(moderatedCall![0]).not.toContain('sp.slug');
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

    it('orders by display name then id when no sort is asked for', async () => {
      const qb = makeSubprofilesQueryBuilderStub([
        makeSubprofile({ id: 'sp-a' }),
      ]);
      subprofiles.createQueryBuilder.mockReturnValue(qb);

      await service.directory({}, 'viewer-1');

      expect(qb.orderBy).toHaveBeenCalledWith('sp.displayName', 'ASC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('sp.id', 'ASC');
    });

    it('orders sort=recent by updatedAt DESC with the id tiebreak', async () => {
      const qb = makeSubprofilesQueryBuilderStub([
        makeSubprofile({ id: 'sp-a' }),
      ]);
      subprofiles.createQueryBuilder.mockReturnValue(qb);

      await service.directory({ sort: 'recent' }, 'viewer-1');

      expect(qb.orderBy).toHaveBeenCalledWith('sp.updatedAt', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('sp.id', 'ASC');
      expect(qb.orderBy).not.toHaveBeenCalledWith('sp.displayName', 'ASC');
    });

    it('orders sort=followed by a follower-count alias, then name, then id', async () => {
      const qb = makeSubprofilesQueryBuilderStub([
        makeSubprofile({ id: 'sp-a' }),
      ]);
      subprofiles.createQueryBuilder.mockReturnValue(qb);

      await service.directory({ sort: 'followed' }, 'viewer-1');

      const rankSelect = qb.addSelect.mock.calls.find(
        (call) => call[1] === 'follower_rank',
      );
      expect(rankSelect).toBeDefined();
      expect(rankSelect![0]).toContain('"subprofile_followers"');
      expect(rankSelect![0]).toContain(
        '"follower"."subprofile_id" = "sp"."id"',
      );
      expect(qb.orderBy).toHaveBeenCalledWith('follower_rank', 'DESC');
      expect(qb.addOrderBy.mock.calls).toEqual([
        ['sp.displayName', 'ASC'],
        ['sp.id', 'ASC'],
      ]);
      // The rank is added after the count, so `total` never pays for it.
      expect(qb.getCount.mock.invocationCallOrder[0]!).toBeLessThan(
        qb.orderBy.mock.invocationCallOrder[0]!,
      );
    });

    it('carries id, viewerFollowing, viewerIsMember and credits on each card from batched reads', async () => {
      const followedRow = makeSubprofile({ id: 'sp-a', handle: 'nightform' });
      const ownedRow = makeSubprofile({
        id: 'sp-b',
        handle: 'starlet',
        displayName: 'Starlet',
      });
      const qb = makeSubprofilesQueryBuilderStub([followedRow, ownedRow]);
      subprofiles.createQueryBuilder.mockReturnValue(qb);
      followersService.viewerFollowingFor.mockResolvedValue(new Set(['sp-a']));
      members.find.mockResolvedValue([{ subprofileId: 'sp-b' }]);
      const nightformCredits: CardCreditsView = {
        count: 2,
        faces: [
          {
            kind: 'persona',
            name: 'Ember',
            avatarUrl: null,
            accent: 'coral',
          },
        ],
      };
      creditGraph.loadCardCreditsFor.mockResolvedValue(
        new Map([['sp-a', nightformCredits]]),
      );

      const result = await service.directory({}, 'viewer-1');

      expect(followersService.viewerFollowingFor).toHaveBeenCalledTimes(1);
      expect(followersService.viewerFollowingFor).toHaveBeenCalledWith(
        'viewer-1',
        ['sp-a', 'sp-b'],
      );
      expect(members.find).toHaveBeenCalledWith({
        where: { subprofileId: In(['sp-a', 'sp-b']), userId: 'viewer-1' },
        select: { subprofileId: true },
      });
      expect(creditGraph.loadCardCreditsFor).toHaveBeenCalledTimes(1);
      expect(creditGraph.loadCardCreditsFor).toHaveBeenCalledWith(
        [followedRow, ownedRow],
        'viewer-1',
      );

      const [nightformCard, starletCard] = result.items;
      expect(nightformCard).toMatchObject({
        id: 'sp-a',
        viewerFollowing: true,
        viewerIsMember: false,
        credits: nightformCredits,
      });
      // A row the credit graph left out falls back to "nobody credited".
      expect(starletCard).toMatchObject({
        id: 'sp-b',
        viewerFollowing: false,
        viewerIsMember: true,
        credits: { count: 0, faces: [] },
      });
    });

    it('still serves the page with empty credits when the credit graph fails', async () => {
      const qb = makeSubprofilesQueryBuilderStub([
        makeSubprofile({ id: 'sp-a' }),
      ]);
      subprofiles.createQueryBuilder.mockReturnValue(qb);
      creditGraph.loadCardCreditsFor.mockRejectedValue(
        new Error('credit graph unavailable'),
      );

      const result = await service.directory({}, 'viewer-1');

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.credits).toEqual({ count: 0, faces: [] });
    });
  });

  // --- persona wall --------------------------------------------------------

  describe('directory follower count', () => {
    it('sorts sort=followed by the shared follower count SQL', async () => {
      const queryBuilder = makeSubprofilesQueryBuilderStub([
        makeSubprofile({ id: 'sp-a' }),
      ]);
      subprofiles.createQueryBuilder.mockReturnValue(queryBuilder);

      await service.directory({ sort: 'followed' }, 'viewer-1');

      const rankSelect = queryBuilder.addSelect.mock.calls.find(
        (call) => call[1] === 'follower_rank',
      );
      expect(rankSelect).toBeDefined();
      expect(rankSelect![0]).toBe(DIRECTORY_FOLLOWER_COUNT_SQL);
    });
  });

  describe('listWallCards', () => {
    const baseRequest = {
      fillOrder: 'endorsed',
      viewerId: 'viewer-1',
      wallDay: '2026-11-05',
    } as const;

    // The wall runs the pick query first and the fill query second, each on a
    // fresh builder from the repository.
    function stubPickAndFillQueries(
      pickRows: Subprofile[],
      fillRows: Subprofile[],
    ): {
      pickQueryBuilder: DirectoryQueryBuilderStub;
      fillQueryBuilder: DirectoryQueryBuilderStub;
    } {
      const pickQueryBuilder = makeSubprofilesQueryBuilderStub(pickRows);
      const fillQueryBuilder = makeSubprofilesQueryBuilderStub(fillRows);
      subprofiles.createQueryBuilder
        .mockReturnValueOnce(pickQueryBuilder)
        .mockReturnValueOnce(fillQueryBuilder);
      return { pickQueryBuilder, fillQueryBuilder };
    }

    // An empty pick list runs the fill query alone.
    function stubFillQueryOnly(
      fillRows: Subprofile[],
    ): DirectoryQueryBuilderStub {
      const fillQueryBuilder = makeSubprofilesQueryBuilderStub(fillRows);
      subprofiles.createQueryBuilder.mockReturnValueOnce(fillQueryBuilder);
      return fillQueryBuilder;
    }

    it('filters the picks through the directory base query with the viewer and keeps their order', async () => {
      const { pickQueryBuilder } = stubPickAndFillQueries(
        [makeSubprofile({ id: 'sp-a' }), makeSubprofile({ id: 'sp-b' })],
        [makeSubprofile({ id: 'sp-f1' })],
      );

      const cards = await service.listWallCards({
        ...baseRequest,
        pickedSubprofileIds: ['sp-b', 'sp-a'],
      });

      expect(cards.map(({ card }) => card.id)).toEqual([
        'sp-b',
        'sp-a',
        'sp-f1',
      ]);
      expect(
        cards.slice(0, 2).every(({ wallSource }) => wallSource === 'picked'),
      ).toBe(true);
      expect(cards[2]!.wallSource).toBe('filled');
      expect(pickQueryBuilder.where).toHaveBeenCalledWith(
        'sp.status = :published',
        { published: SubprofileStatus.Published },
      );
      expect(pickQueryBuilder.select).toHaveBeenCalledWith(
        expect.arrayContaining([
          'sp.id',
          'sp.avatarUrl',
          'sp.coverUrl',
          'sp.userId',
        ]),
      );
      expect(pickQueryBuilder.andWhere).toHaveBeenCalledWith(
        'sp.id IN (:...wallPickIds)',
        { wallPickIds: ['sp-b', 'sp-a'] },
      );
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        pickQueryBuilder,
        'viewer-1',
        '"sp"."user_id"',
      );
    });

    it('skips a pick the base query drops and tops the wall up from the fill, excluding every pick', async () => {
      const { fillQueryBuilder } = stubPickAndFillQueries(
        [makeSubprofile({ id: 'sp-a' }), makeSubprofile({ id: 'sp-c' })],
        [makeSubprofile({ id: 'sp-f1' })],
      );

      const cards = await service.listWallCards({
        ...baseRequest,
        pickedSubprofileIds: ['sp-a', 'sp-b', 'sp-c'],
      });

      expect(cards.map(({ card }) => card.id)).toEqual([
        'sp-a',
        'sp-c',
        'sp-f1',
      ]);
      expect(fillQueryBuilder.andWhere).toHaveBeenCalledWith(
        'sp.id NOT IN (:...wallExcludedIds)',
        { wallExcludedIds: ['sp-a', 'sp-b', 'sp-c'] },
      );
      expect(fillQueryBuilder.limit).toHaveBeenCalledWith(7);
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        fillQueryBuilder,
        'viewer-1',
        '"sp"."user_id"',
      );
    });

    it('runs no fill query when nine picks show', async () => {
      const pickIds = Array.from(
        { length: 9 },
        (_unused, index) => `sp-${index + 1}`,
      );
      const pickQueryBuilder = makeSubprofilesQueryBuilderStub(
        pickIds.map((pickId) => makeSubprofile({ id: pickId })),
      );
      subprofiles.createQueryBuilder.mockReturnValueOnce(pickQueryBuilder);

      const cards = await service.listWallCards({
        ...baseRequest,
        pickedSubprofileIds: pickIds,
      });

      expect(subprofiles.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(pickQueryBuilder.limit).not.toHaveBeenCalled();
      expect(cards.map(({ card }) => card.id)).toEqual(pickIds);
      expect(cards.every(({ wallSource }) => wallSource === 'picked')).toBe(
        true,
      );
    });

    it('runs no pick query and fills nine when nothing is picked', async () => {
      const fillQueryBuilder = stubFillQueryOnly([
        makeSubprofile({ id: 'sp-f1' }),
        makeSubprofile({ id: 'sp-f2' }),
      ]);

      const cards = await service.listWallCards({
        ...baseRequest,
        pickedSubprofileIds: [],
      });

      expect(subprofiles.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(fillQueryBuilder.limit).toHaveBeenCalledWith(9);
      const filterClauses = fillQueryBuilder.andWhere.mock.calls.map(
        (call) => call[0],
      );
      expect(filterClauses.some((clause) => clause.includes('NOT IN'))).toBe(
        false,
      );
      expect(
        filterClauses.some((clause) => clause.includes('wallPickIds')),
      ).toBe(false);
      expect(cards.every(({ wallSource }) => wallSource === 'filled')).toBe(
        true,
      );
    });

    it.each([
      ['endorsed', PERSONA_WALL_ENDORSEMENT_COUNT_SQL, 'DESC'],
      ['followed', DIRECTORY_FOLLOWER_COUNT_SQL, 'DESC'],
      ['daily_shuffle', PERSONA_WALL_DAILY_SHUFFLE_SQL, 'ASC'],
    ] as const)(
      'orders a %s fill by photo, then its rank, then name and id',
      async (fillOrder, rankSql, direction) => {
        const fillQueryBuilder = stubFillQueryOnly([]);

        await service.listWallCards({
          ...baseRequest,
          fillOrder,
          pickedSubprofileIds: [],
        });

        expect(fillQueryBuilder.addSelect).toHaveBeenCalledWith(
          PERSONA_WALL_HAS_PHOTO_SQL,
          'wall_photo_rank',
        );
        expect(fillQueryBuilder.addSelect).toHaveBeenCalledWith(
          rankSql,
          'wall_fill_rank',
        );
        expect(fillQueryBuilder.orderBy).toHaveBeenCalledWith(
          'wall_photo_rank',
          'DESC',
        );
        expect(fillQueryBuilder.addOrderBy.mock.calls).toEqual([
          ['wall_fill_rank', direction],
          ['sp.displayName', 'ASC'],
          ['sp.id', 'ASC'],
        ]);
      },
    );

    it('orders a newest fill by photo, then creation time, then name and id', async () => {
      const fillQueryBuilder = stubFillQueryOnly([]);

      await service.listWallCards({
        ...baseRequest,
        fillOrder: 'newest',
        pickedSubprofileIds: [],
      });

      expect(fillQueryBuilder.orderBy).toHaveBeenCalledWith(
        'wall_photo_rank',
        'DESC',
      );
      expect(fillQueryBuilder.addOrderBy.mock.calls).toEqual([
        ['sp.createdAt', 'DESC'],
        ['sp.displayName', 'ASC'],
        ['sp.id', 'ASC'],
      ]);
      expect(
        fillQueryBuilder.addSelect.mock.calls.some(
          (call) => call[1] === 'wall_fill_rank',
        ),
      ).toBe(false);
    });

    it('binds the Lisbon day for the daily shuffle', async () => {
      const fillQueryBuilder = stubFillQueryOnly([]);

      await service.listWallCards({
        ...baseRequest,
        fillOrder: 'daily_shuffle',
        pickedSubprofileIds: [],
      });

      expect(fillQueryBuilder.setParameter).toHaveBeenCalledWith(
        'wallDay',
        '2026-11-05',
      );
    });

    it('treats an empty image column as no photo', () => {
      expect(PERSONA_WALL_HAS_PHOTO_SQL).toContain(
        `NULLIF("sp"."avatar_url", '')`,
      );
      expect(PERSONA_WALL_HAS_PHOTO_SQL).toContain(
        `NULLIF("sp"."cover_url", '')`,
      );
    });

    it('counts only active endorsements', () => {
      expect(PERSONA_WALL_ENDORSEMENT_COUNT_SQL).toContain(
        '"endorsement"."withdrawn_at" IS NULL',
      );
    });

    it('ranks by persona columns and persona counts only', async () => {
      const fillOrders: PersonaWallFillOrder[] = [
        'endorsed',
        'followed',
        'newest',
        'daily_shuffle',
      ];
      const sqlFragments: string[] = [];
      for (const fillOrder of fillOrders) {
        const fillQueryBuilder = stubFillQueryOnly([]);
        await service.listWallCards({
          ...baseRequest,
          fillOrder,
          pickedSubprofileIds: [],
        });
        sqlFragments.push(
          ...fillQueryBuilder.addSelect.mock.calls.map((call) => call[0]),
          ...fillQueryBuilder.orderBy.mock.calls.map((call) => call[0]),
          ...fillQueryBuilder.addOrderBy.mock.calls.map((call) => call[0]),
        );
      }
      const everySqlFragment = sqlFragments.join(' ');

      expect(everySqlFragment).not.toMatch(/vouch|"profiles"|"users"|owner/i);
    });

    it('draws picks and fill as one batch of directory cards', async () => {
      stubPickAndFillQueries(
        [makeSubprofile({ id: 'sp-a' }), makeSubprofile({ id: 'sp-b' })],
        [makeSubprofile({ id: 'sp-f1' })],
      );

      await service.listWallCards({
        ...baseRequest,
        pickedSubprofileIds: ['sp-b', 'sp-a'],
      });

      expect(followersService.loadFollowerCountsFor).toHaveBeenCalledTimes(1);
      expect(followersService.loadFollowerCountsFor).toHaveBeenCalledWith([
        'sp-b',
        'sp-a',
        'sp-f1',
      ]);
    });

    it('applies no block filter and reads cards as nobody when no viewer is given', async () => {
      const { pickQueryBuilder } = stubPickAndFillQueries(
        [makeSubprofile({ id: 'sp-a' })],
        [makeSubprofile({ id: 'sp-f1' })],
      );

      await service.listWallCards({
        ...baseRequest,
        viewerId: null,
        pickedSubprofileIds: ['sp-a'],
      });

      expect(blockFilter.excludeBlocked).not.toHaveBeenCalled();
      expect(followersService.viewerFollowingFor).toHaveBeenCalledWith(
        '00000000-0000-0000-0000-000000000000',
        expect.any(Array),
      );
      expect(pickQueryBuilder.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('"content_moderation"'),
        expect.anything(),
      );
    });
  });

  describe('searchWallPersonas', () => {
    it('searches the directory haystack over the base set with no block filter and persona columns only', async () => {
      const personaRows = [makeSubprofile({ id: 'sp-a', displayName: 'Ana' })];
      const queryBuilder = makeSubprofilesQueryBuilderStub(personaRows);
      subprofiles.createQueryBuilder.mockReturnValue(queryBuilder);

      const result = await service.searchWallPersonas('ana', 20);

      expect(result).toEqual(personaRows);
      expect(queryBuilder.leftJoin).toHaveBeenCalledWith(
        Profile,
        'owner',
        'owner.userId = sp.userId',
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('sp.linkVisibility = :linkedForSearch'),
        expect.objectContaining({ term: '%ana%' }),
      );
      expect(queryBuilder.select).toHaveBeenCalledWith([
        'sp.id',
        'sp.handle',
        'sp.displayName',
        'sp.kind',
        'sp.avatarUrl',
        'sp.coverUrl',
        'sp.accent',
      ]);
      expect(blockFilter.excludeBlocked).not.toHaveBeenCalled();
      expect(queryBuilder.orderBy).toHaveBeenCalledWith(
        'sp.displayName',
        'ASC',
      );
      expect(queryBuilder.addOrderBy).toHaveBeenCalledWith('sp.id', 'ASC');
      expect(queryBuilder.limit).toHaveBeenCalledWith(20);
    });
  });

  // --- `/p/<handle>` reads for both link kinds -------------------------------

  describe('getByHandle for linked and unlinked personas', () => {
    const activeViewer: CurrentUserData = {
      userId: 'viewer-1',
      email: 'viewer@example.com',
      status: UserStatus.Active,
      role: 'member',
    };

    let personaRows: Subprofile[];

    beforeEach(() => {
      personaRows = [];
      profiles.findOne.mockImplementation(
        findOneFrom([
          {
            userId: 'creator-1',
            slug: 'ana',
            firstName: 'Ana',
            lastName: 'Reis',
          },
        ]),
      );
      subprofiles.findOne.mockImplementation(findOneFrom(personaRows));
      subprofiles.find.mockImplementation(findFrom(personaRows));
    });

    function linkedPersona(overrides: Partial<Subprofile> = {}): Subprofile {
      return makeSubprofile({
        id: 'sp-linked',
        userId: 'creator-1',
        slug: 'dj-set',
        handle: 'ana-dj-set',
        linkVisibility: SubprofileLinkVisibility.Linked,
        visibility: SubprofileVisibility.Open,
        status: SubprofileStatus.Published,
        ...overrides,
      });
    }

    function forbiddenBodyOf(error: unknown): unknown {
      expect(error).toBeInstanceOf(ForbiddenException);
      return (error as ForbiddenException).getResponse();
    }

    it('serves a linked published open persona to an active member with its creator named', async () => {
      personaRows.push(linkedPersona());

      const view = await service.getByHandle('ana-dj-set', activeViewer);

      expect(view.id).toBe('sp-linked');
      expect(view.handle).toBe('ana-dj-set');
      expect(view.ownerSlug).toBe('ana');
      expect(view.ownerName).toBe('Ana Reis');
      expect(profiles.findOne).toHaveBeenCalledWith({
        where: { userId: 'creator-1' },
      });
    });

    it('answers members_only to a signed-out caller on a linked open persona', async () => {
      personaRows.push(linkedPersona());

      const error = await rejectionOf(
        service.getByHandle('ana-dj-set', undefined),
      );

      expect(forbiddenBodyOf(error)).toEqual(
        restrictedAccessBody('members_only'),
      );
    });

    it('answers members_only on the nested route too for a signed-out caller', async () => {
      personaRows.push(linkedPersona());

      const error = await rejectionOf(
        service.getBySlugForProfile('ana', 'dj-set', undefined),
      );

      expect(forbiddenBodyOf(error)).toEqual(
        restrictedAccessBody('members_only'),
      );
    });

    it('keeps an unlinked persona owner-stripped and never reads its owner profile', async () => {
      personaRows.push(
        makeSubprofile({
          id: 'sp-unlinked',
          userId: 'creator-1',
          handle: 'nightform',
          linkVisibility: SubprofileLinkVisibility.Unlinked,
        }),
      );

      const view = await service.getByHandle('nightform', activeViewer);

      expect(view.id).toBe('sp-unlinked');
      expect(view.ownerSlug).toBeUndefined();
      expect(view.ownerName).toBeUndefined();
      expect(profiles.findOne).not.toHaveBeenCalled();
    });

    it('serves the published persona to a stranger when a draft holds the same handle', async () => {
      // The draft is listed first, so a lookup by handle alone would return it
      // and the stranger would get a 404 for a live persona.
      personaRows.push(
        makeSubprofile({
          id: 'sp-draft',
          userId: 'someone-else',
          handle: 'nightform',
          status: SubprofileStatus.Draft,
        }),
        makeSubprofile({
          id: 'sp-published',
          userId: 'creator-1',
          handle: 'nightform',
          status: SubprofileStatus.Published,
        }),
      );

      const view = await service.getByHandle('nightform', activeViewer);

      expect(view.id).toBe('sp-published');
      expect(subprofiles.findOne).toHaveBeenNthCalledWith(1, {
        where: { handle: 'nightform', status: SubprofileStatus.Published },
      });
    });

    it('still serves a draft to its owner when no published persona holds the handle', async () => {
      personaRows.push(
        makeSubprofile({
          id: 'sp-draft',
          userId: 'creator-1',
          handle: 'nightform',
          status: SubprofileStatus.Draft,
        }),
      );
      membership.isMember.mockResolvedValue(true);

      const view = await service.getByHandle('nightform', activeViewer);

      expect(view.id).toBe('sp-draft');
      expect(view.status).toBe(SubprofileStatus.Draft);
    });

    describe('when two drafts share the handle and none is published', () => {
      let members: { find: jest.Mock };

      beforeEach(() => {
        // Oldest first, as the real query orders them. The viewer co-owns only
        // the newer one.
        personaRows.push(
          makeSubprofile({
            id: 'sp-draft-other',
            userId: 'someone-else',
            handle: 'nightform',
            status: SubprofileStatus.Draft,
          }),
          makeSubprofile({
            id: 'sp-draft-mine',
            userId: 'creator-1',
            handle: 'nightform',
            status: SubprofileStatus.Draft,
          }),
        );
        members = module.get<{ find: jest.Mock }>(
          getRepositoryToken(SubprofileMember),
        );
        members.find.mockResolvedValue([{ subprofileId: 'sp-draft-mine' }]);
        membership.isMember.mockImplementation(
          (userId: string, subprofileId: string) =>
            Promise.resolve(
              userId === 'viewer-1' && subprofileId === 'sp-draft-mine',
            ),
        );
      });

      it("serves the viewer's own draft over an older draft they do not co-own", async () => {
        const view = await service.getByHandle('nightform', activeViewer);

        expect(view.id).toBe('sp-draft-mine');
        expect(view.status).toBe(SubprofileStatus.Draft);
        expect(members.find).toHaveBeenCalledWith({
          where: {
            subprofileId: In(['sp-draft-other', 'sp-draft-mine']),
            userId: 'viewer-1',
          },
          select: { subprofileId: true },
        });
      });

      it('falls back to the oldest draft for a signed-out caller without a roster lookup', async () => {
        const error = await rejectionOf(
          service.getByHandle('nightform', undefined),
        );

        expect(error).toBeInstanceOf(NotFoundException);
        expect(members.find).not.toHaveBeenCalled();
      });
    });

    describe('after a linked persona renamed its handle', () => {
      beforeEach(() => {
        personaRows.push(linkedPersona({ handle: 'ana-beats' }));
        handles.previousSubprofileOwnerOf.mockImplementation((handle: string) =>
          Promise.resolve(handle === 'ana-dj-set' ? 'sp-linked' : null),
        );
      });

      it('forwards an active member to the new handle', async () => {
        const error = await rejectionOf(
          service.getByHandle('ana-dj-set', activeViewer),
        );

        expect(error).toBeInstanceOf(NotFoundException);
        expect((error as NotFoundException).getResponse()).toEqual({
          code: 'PERSONA_MOVED',
          message: 'That handle has moved',
          handle: 'ana-beats',
        });
      });

      it('gives a signed-out caller the plain 404', async () => {
        const error = await rejectionOf(
          service.getByHandle('ana-dj-set', undefined),
        );

        expect(error).toBeInstanceOf(NotFoundException);
        const body = (error as NotFoundException).getResponse() as Record<
          string,
          unknown
        >;
        expect(body.message).toBe('Subprofile not found');
        expect(body.code).toBeUndefined();
        expect(body.handle).toBeUndefined();
      });
    });

    // ENG-454: the handle namespace is case-folded, so the route param is too.
    it('resolves a handle typed with capital letters', async () => {
      personaRows.push(
        makeSubprofile({ id: 'sp-unlinked', handle: 'nightform' }),
      );

      const view = await service.getByHandle('NightForm', activeViewer);

      expect(view.id).toBe('sp-unlinked');
      expect(subprofiles.findOne).toHaveBeenNthCalledWith(1, {
        where: { handle: 'nightform', status: SubprofileStatus.Published },
      });
    });

    it('folds the handle before the PERSONA_MOVED lookup too', async () => {
      personaRows.push(linkedPersona({ handle: 'ana-beats' }));
      handles.previousSubprofileOwnerOf.mockImplementation((handle: string) =>
        Promise.resolve(handle === 'ana-dj-set' ? 'sp-linked' : null),
      );

      const error = await rejectionOf(
        service.getByHandle('Ana-DJ-Set', activeViewer),
      );

      expect(handles.previousSubprofileOwnerOf).toHaveBeenCalledWith(
        'ana-dj-set',
      );
      expect((error as NotFoundException).getResponse()).toEqual({
        code: 'PERSONA_MOVED',
        message: 'That handle has moved',
        handle: 'ana-beats',
      });
    });

    // ENG-446: a persona takedown is keyed on the persona uuid.
    describe('moderator takedowns', () => {
      beforeEach(() => {
        personaRows.push(
          makeSubprofile({
            id: 'sp-unlinked',
            userId: 'creator-1',
            slug: 'nightform',
            handle: 'nightform',
          }),
        );
      });

      it('hides a persona whose uuid carries a takedown', async () => {
        contentModeration.stateFor.mockImplementation(
          (subjectType: string, subjectId: string) =>
            Promise.resolve({
              hidden:
                subjectType === 'subprofile' && subjectId === 'sp-unlinked',
              removed: false,
            }),
        );

        const error = await rejectionOf(
          service.getByHandle('nightform', activeViewer),
        );

        expect(error).toBeInstanceOf(NotFoundException);
        expect(contentModeration.stateFor).toHaveBeenCalledWith(
          'subprofile',
          'sp-unlinked',
        );
      });

      it("serves a persona when only a slug-keyed row shares its slug, which may name another member's persona", async () => {
        contentModeration.stateFor.mockImplementation(
          (subjectType: string, subjectId: string) =>
            Promise.resolve({
              hidden: subjectType === 'subprofile' && subjectId === 'nightform',
              removed:
                subjectType === 'subprofile' && subjectId === 'nightform',
            }),
        );

        const view = await service.getByHandle('nightform', activeViewer);

        expect(view.id).toBe('sp-unlinked');
        expect(contentModeration.stateFor).not.toHaveBeenCalledWith(
          'subprofile',
          'nightform',
        );
      });
    });

    // "Meet the team": the listings a persona works at.
    describe('works at', () => {
      function worksAtSqlCalls(): string[] {
        return (subprofiles.manager.query.mock.calls as [string, unknown[]][])
          .map(([sql]) => sql)
          .filter((sql) => sql.includes('listing_team_members'));
      }

      function unlinkedOpenPersona(
        overrides: Partial<Subprofile> = {},
      ): Subprofile {
        return makeSubprofile({
          id: 'sp-unlinked',
          userId: 'creator-1',
          slug: 'nightform',
          handle: 'nightform',
          linkVisibility: SubprofileLinkVisibility.Unlinked,
          visibility: SubprofileVisibility.Open,
          status: SubprofileStatus.Published,
          ...overrides,
        });
      }

      it('carries an empty works at list on a persona with no links', async () => {
        personaRows.push(unlinkedOpenPersona());

        const view = await service.getByHandle('nightform', activeViewer);

        expect(view.worksAt).toEqual([]);
        expect(worksAtSqlCalls()).toHaveLength(1);
        expect(subprofiles.manager.find).not.toHaveBeenCalled();
      });

      it('reads works at for an active member with the 18+ listings included', async () => {
        personaRows.push(unlinkedOpenPersona());

        await service.getByHandle('nightform', activeViewer);
        const memberSql = worksAtSqlCalls();
        expect(memberSql).toHaveLength(1);
        expect(memberSql[0]).not.toContain(notAdultListingSql('listing'));
        expect(subprofiles.manager.query).toHaveBeenCalledWith(
          expect.any(String),
          ['sp-unlinked'],
        );

        subprofiles.manager.query.mockClear();
        await service.getByHandle('nightform', undefined);
        const anonymousSql = worksAtSqlCalls();
        expect(anonymousSql).toHaveLength(1);
        expect(anonymousSql[0]).toContain(notAdultListingSql('listing'));
      });

      it('reads no works at before the visibility check passes', async () => {
        personaRows.push(
          unlinkedOpenPersona({ visibility: SubprofileVisibility.Private }),
        );
        membership.isMember.mockResolvedValue(false);

        const error = await rejectionOf(
          service.getByHandle('nightform', activeViewer),
        );

        expect(error).toBeInstanceOf(ForbiddenException);
        expect(worksAtSqlCalls()).toEqual([]);
        expect(subprofiles.manager.find).not.toHaveBeenCalled();
      });
    });

    describe('founding artist badge', () => {
      function foundingSqlCalls(): [string, unknown[]][] {
        return (
          subprofiles.manager.query.mock.calls as [string, unknown[]][]
        ).filter(([sql]) => sql.includes('studio_founding_artists'));
      }

      it('marks a founding artist on the public view and reads false for everyone else', async () => {
        personaRows.push(
          makeSubprofile({
            id: 'sp-founding',
            userId: 'creator-1',
            kind: SubprofileKind.Musician,
            handle: 'founding-one',
            slug: 'founding-one',
          }),
          makeSubprofile({
            id: 'sp-plain',
            userId: 'creator-1',
            kind: SubprofileKind.Musician,
            handle: 'plain-one',
            slug: 'plain-one',
          }),
        );
        subprofiles.manager.query.mockImplementation((sql: string) =>
          Promise.resolve(
            sql.includes('studio_founding_artists')
              ? [{ subprofile_id: 'sp-founding' }]
              : [],
          ),
        );

        const foundingView = await service.getByHandle(
          'founding-one',
          activeViewer,
        );
        const plainView = await service.getByHandle('plain-one', activeViewer);

        expect(foundingView.isFoundingArtist).toBe(true);
        expect(plainView.isFoundingArtist).toBe(false);
        expect(foundingSqlCalls().map(([, params]) => params)).toEqual([
          [['sp-founding']],
          [['sp-plain']],
        ]);
      });
    });

    describe('flash day events', () => {
      function tattooPersona(): Subprofile {
        return linkedPersona({ kind: SubprofileKind.TattooArtist });
      }

      it('gives a visitor a healed item with photo isBlurred only', async () => {
        personaRows.push(tattooPersona());
        items.find.mockResolvedValue([
          makeTattooItem({
            id: 'item-healed',
            section: SubprofileSection.Healed,
            structured: { photo: { hasClientConsent: true, isBlurred: false } },
          }),
        ]);

        const view = await service.getByHandle('ana-dj-set', activeViewer);

        expect(view.items[0]?.structured?.photo).toEqual({ isBlurred: false });
        expect(JSON.stringify(view)).not.toContain('hasClientConsent');
      });

      it('gives a visitor the linked event while it resolves', async () => {
        personaRows.push(tattooPersona());
        items.find.mockResolvedValue([
          makeTattooItem({
            structured: { flashDay: { eventSlug: 'members-night' } },
          }),
        ]);
        affiliationEligibility.resolveFlashDayEvents.mockResolvedValue(
          new Map([['item-1', FLASH_DAY_EVENT_REF]]),
        );

        const view = await service.getByHandle('ana-dj-set', activeViewer);

        expect(view.items[0]?.linkedEvent).toEqual(FLASH_DAY_EVENT_REF);
        expect(
          affiliationEligibility.resolveFlashDayEvents,
        ).toHaveBeenCalledTimes(1);
      });

      it('gives a visitor no trace of a flash day event that stopped resolving', async () => {
        personaRows.push(tattooPersona());
        items.find.mockResolvedValue([
          makeTattooItem({
            structured: { flashDay: { eventSlug: 'members-night' } },
          }),
        ]);
        affiliationEligibility.resolveFlashDayEvents.mockResolvedValue(
          new Map(),
        );

        const view = await service.getByHandle('ana-dj-set', activeViewer);

        expect(view.items[0]?.linkedEvent).toBeNull();
        expect(JSON.stringify(view)).not.toContain('members-night');
      });

      it('passes the signed in viewer id and the persona with its items', async () => {
        personaRows.push(tattooPersona());
        const storedItems = [makeTattooItem()];
        items.find.mockResolvedValue(storedItems);

        await service.getByHandle('ana-dj-set', activeViewer);

        expect(
          affiliationEligibility.resolveFlashDayEvents,
        ).toHaveBeenCalledWith(
          'viewer-1',
          [expect.objectContaining({ id: 'sp-linked' })],
          storedItems,
        );
      });

      it('passes the anonymous viewer id for a signed-out visitor', async () => {
        personaRows.push(tattooPersona());

        await service.getByHandle('ana-dj-set', undefined);

        expect(
          affiliationEligibility.resolveFlashDayEvents,
        ).toHaveBeenCalledWith(
          '00000000-0000-0000-0000-000000000000',
          expect.any(Array),
          expect.any(Array),
        );
      });
    });
  });

  // --- listForProfile applies the single-read visibility rule ---------------

  describe('listForProfile visibility', () => {
    let members: { find: jest.Mock };

    beforeEach(() => {
      profiles.findOne.mockResolvedValue({
        userId: 'creator-1',
        slug: 'ana',
        firstName: 'Ana',
        lastName: 'Reis',
      });
      const linked = (id: string, visibility: SubprofileVisibility) =>
        makeSubprofile({
          id,
          userId: 'creator-1',
          slug: id,
          handle: id,
          linkVisibility: SubprofileLinkVisibility.Linked,
          visibility,
        });
      subprofiles.find.mockResolvedValue([
        linked('sp-open', SubprofileVisibility.Open),
        linked('sp-network', SubprofileVisibility.Network),
        linked('sp-private', SubprofileVisibility.Private),
      ]);
      members = module.get<{ find: jest.Mock }>(
        getRepositoryToken(SubprofileMember),
      );
    });

    // The profile owner's roster lists all three; `co-owner-1` also holds a
    // seat on the private persona, and nobody else holds any.
    function rosterFor(viewerOwnsPrivate: boolean) {
      members.find.mockImplementation(
        ({ where }: { where: { userId: string; subprofileId?: unknown } }) => {
          if (where.subprofileId === undefined) {
            return Promise.resolve(
              ['sp-open', 'sp-network', 'sp-private'].map(
                (subprofileId, position) => ({ subprofileId, position }),
              ),
            );
          }
          return Promise.resolve(
            viewerOwnsPrivate && where.userId === 'co-owner-1'
              ? [{ subprofileId: 'sp-private' }]
              : [],
          );
        },
      );
    }

    it('withholds a private persona from an active member who does not own it', async () => {
      rosterFor(false);

      const views = await service.listForProfile('ana', 'viewer-1');

      expect(views.map((view) => view.id)).toEqual(['sp-open', 'sp-network']);
      expect(views.map((view) => view.visibility)).toEqual([
        SubprofileVisibility.Open,
        SubprofileVisibility.Network,
      ]);
    });

    it('resolves flash day events once per profile page with the viewer id', async () => {
      rosterFor(false);

      await service.listForProfile('ana', 'viewer-1');

      expect(
        affiliationEligibility.resolveFlashDayEvents,
      ).toHaveBeenCalledTimes(1);
      expect(affiliationEligibility.resolveFlashDayEvents).toHaveBeenCalledWith(
        'viewer-1',
        [
          expect.objectContaining({ id: 'sp-open' }),
          expect.objectContaining({ id: 'sp-network' }),
        ],
        [],
      );
    });

    it('marks a founding artist on the list in one read and reads false for everyone else', async () => {
      rosterFor(false);
      subprofiles.manager.query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes('studio_founding_artists')
            ? [{ subprofile_id: 'sp-network' }]
            : [],
        ),
      );

      const views = await service.listForProfile('ana', 'viewer-1');

      expect(
        views.map((view) => [view.id, view.isFoundingArtist] as const),
      ).toEqual([
        ['sp-open', false],
        ['sp-network', true],
      ]);
      const foundingCalls = (
        subprofiles.manager.query.mock.calls as [string, unknown[]][]
      ).filter(([sql]) => sql.includes('studio_founding_artists'));
      expect(foundingCalls.map(([, params]) => params)).toEqual([
        [['sp-open', 'sp-network']],
      ]);
    });

    it('lists the private persona for its co-owner', async () => {
      rosterFor(true);

      const views = await service.listForProfile('ana', 'co-owner-1');

      expect(views.map((view) => view.id)).toEqual([
        'sp-open',
        'sp-network',
        'sp-private',
      ]);
    });
  });

  // --- sitemap handles keyed on the persona uuid ------------------------------

  describe('listPublicHandles takedown filter', () => {
    it('drops a persona by the uuid its takedown is keyed on', async () => {
      const updatedAt = new Date('2026-09-01T10:00:00.000Z');
      subprofiles.find.mockResolvedValue([
        { id: 'sp-live', handle: 'live-one', updatedAt },
        { id: 'sp-down', handle: 'taken-down', updatedAt },
      ]);
      contentModeration.statesFor.mockResolvedValue(
        new Map([['sp-down', { hidden: true, removed: false }]]),
      );

      const result = await service.listPublicHandles();

      expect(contentModeration.statesFor).toHaveBeenCalledWith('subprofile', [
        'sp-live',
        'sp-down',
      ]);
      expect(result.items).toEqual([
        { handle: 'live-one', updatedAt: updatedAt.toISOString() },
      ]);
    });
  });

  // --- resolveHandles: a collaboration credit honours the persona uuid's
  // takedown state too (Task 1 N3) ------------------------------------------

  describe('resolveHandles takedown filter', () => {
    let handleRegistry: { find: jest.Mock };

    beforeEach(() => {
      handleRegistry = module.get<{ find: jest.Mock }>(
        getRepositoryToken(Handle),
      );
    });

    // A persona that would otherwise be creditable: published, unlinked and
    // not private, so a takedown is the only thing withholding it below.
    function creditablePersona(
      overrides: Partial<Subprofile> = {},
    ): Subprofile {
      return makeSubprofile({
        linkVisibility: SubprofileLinkVisibility.Unlinked,
        visibility: SubprofileVisibility.Open,
        status: SubprofileStatus.Published,
        ...overrides,
      });
    }

    it('drops a persona credit whose uuid carries a takedown and keeps one that does not', async () => {
      handleRegistry.find.mockResolvedValue([
        {
          name: 'taken-down',
          ownerKind: HandleOwnerKind.Subprofile,
          userId: null,
          subprofileId: 'sp-down',
        },
        {
          name: 'live-one',
          ownerKind: HandleOwnerKind.Subprofile,
          userId: null,
          subprofileId: 'sp-live',
        },
      ]);
      subprofiles.find.mockResolvedValue([
        creditablePersona({
          id: 'sp-down',
          handle: 'taken-down',
          displayName: 'Taken Down',
        }),
        creditablePersona({
          id: 'sp-live',
          handle: 'live-one',
          displayName: 'Live One',
        }),
      ]);
      contentModeration.statesFor.mockResolvedValue(
        new Map([['sp-down', { hidden: true, removed: false }]]),
      );

      const result = await service.resolveHandles(
        ['taken-down', 'live-one'],
        'viewer-1',
      );

      expect(contentModeration.statesFor).toHaveBeenCalledWith('subprofile', [
        'sp-down',
        'sp-live',
      ]);
      expect(result.has('taken-down')).toBe(false);
      expect(result.get('live-one')).toEqual({
        handle: 'live-one',
        type: 'persona',
        name: 'Live One',
        avatarUrl: null,
        slug: null,
      });
    });

    it('also drops a persona credit whose uuid carries a removed takedown', async () => {
      handleRegistry.find.mockResolvedValue([
        {
          name: 'removed-one',
          ownerKind: HandleOwnerKind.Subprofile,
          userId: null,
          subprofileId: 'sp-removed',
        },
      ]);
      subprofiles.find.mockResolvedValue([
        creditablePersona({
          id: 'sp-removed',
          handle: 'removed-one',
          displayName: 'Removed One',
        }),
      ]);
      contentModeration.statesFor.mockResolvedValue(
        new Map([['sp-removed', { hidden: false, removed: true }]]),
      );

      const result = await service.resolveHandles(['removed-one'], 'viewer-1');

      expect(result.has('removed-one')).toBe(false);
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

    it('withholds the forward from an anonymous visitor because a linked persona is members-only', async () => {
      // An open linked persona still answers `members_only` to a signed-out
      // caller, and a forward must tell them no more than the new address
      // would, so they get the plain 404.
      const error = await rejectionOf(
        service.getBySlugForProfile('ana', 'nightform', undefined),
      );

      const body = responseBodyOf(error);
      expect(body.message).toBe('Subprofile not found');
      expect(body.code).toBeUndefined();
      expect(body.ownerSlug).toBeUndefined();
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

  describe('staff draft reads', () => {
    const draftRow = (overrides: Partial<Subprofile> = {}): Subprofile => ({
      ...makeSubprofile(),
      id: 'persona-1',
      userId: 'creator-1',
      status: SubprofileStatus.Draft,
      removedAt: null,
      visibility: SubprofileVisibility.Open,
      handle: 'velvet',
      bio: 'short',
      avatarUrl: null,
      linkVisibility: SubprofileLinkVisibility.Unlinked,
      ...overrides,
    });

    beforeEach(() => {
      Object.assign(handles, { isTaken: jest.fn().mockResolvedValue(false) });
    });

    it('assembles the anonymous public view of a draft with no owner flag', async () => {
      subprofiles.findOne.mockResolvedValue(draftRow());
      const view = await service.getDraftPreviewForStaff('persona-1');
      // The public view carries the owner flag as `viewerIsMember`
      // (`toPublicDTO`'s `viewerIsMember` argument is the `isOwner` the read
      // passes).
      expect(view).toEqual(
        expect.objectContaining({ status: 'draft', viewerIsMember: false }),
      );
      expect(membership.isMember).not.toHaveBeenCalled();
      expect(blockFilter.isBlockedEitherWay).not.toHaveBeenCalled();
      expect(followersService.viewerFollowingFor).toHaveBeenCalledWith(
        '00000000-0000-0000-0000-000000000000',
        ['persona-1'],
      );
    });

    it('answers null for a published, removed, private or missing persona', async () => {
      for (const row of [
        draftRow({ status: SubprofileStatus.Published }),
        draftRow({ removedAt: new Date() }),
        draftRow({ visibility: SubprofileVisibility.Private }),
        null,
      ]) {
        subprofiles.findOne.mockResolvedValueOnce(row);
        await expect(
          service.getDraftPreviewForStaff('persona-1'),
        ).resolves.toBeNull();
      }
    });

    it('lists what still blocks publishing for each persona, with the creator slug', async () => {
      profiles.find.mockResolvedValue([
        { userId: 'creator-1', slug: 'ana-silva' },
      ]);
      const gaps = await service.draftPublishGapsForStaff([
        draftRow(),
        draftRow({ id: 'persona-2', handle: 'ana-silva-tarot' }),
      ]);
      expect(gaps.get('persona-1')).toEqual([
        'avatar_missing',
        'bio_too_short',
      ]);
      expect(gaps.get('persona-2')).toEqual([
        'handle_names_owner',
        'avatar_missing',
        'bio_too_short',
      ]);
      expect(profiles.find).toHaveBeenCalledTimes(1);
    });
  });
});
