import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { Community } from '../communities/entities/community.entity';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { Event } from '../events/entities/event.entity';
import { Handle } from '../handles/entities/handle.entity';
import { MediaCropService } from '../media-crops/media-crops.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { DIRECTORY_MAX_LIMIT } from './dto/list-directory.query';
import {
  Subprofile,
  SubprofileKind,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';
import { SubprofileAffiliation } from './entities/subprofile-affiliation.entity';
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

// Stubs the fluent `createQueryBuilder('sp')` chain `directory()` builds:
// every chained method (`select`/`where`/`andWhere`/`orderBy`/`offset`/
// `limit`) returns the builder itself so calls compose exactly like the real
// TypeORM `SelectQueryBuilder` — no real query builder is constructed, but
// EVERY method the real `directory()` calls is implemented here (unlike the
// former stub in `subprofiles.service.spec.ts`, which predated offset
// pagination). Declared with explicit (non-index-signature) fields so each
// one reads back as a plain `jest.Mock`, not `jest.Mock | undefined`, under
// this repo's `noUncheckedIndexedAccess`. `getCount` and `getMany` are
// independently controllable so a test can prove `total` really comes from
// `getCount()`, not from `rows.length`.
interface DirectoryQueryBuilderStub {
  select: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  offset: jest.Mock;
  limit: jest.Mock;
  getMany: jest.Mock;
  getCount: jest.Mock;
}
function makeSubprofilesQueryBuilderStub(
  rows: Subprofile[],
  count: number = rows.length,
): DirectoryQueryBuilderStub {
  const queryBuilder = {} as DirectoryQueryBuilderStub;
  queryBuilder.select = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.where = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.andWhere = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.orderBy = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.offset = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.limit = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.getMany = jest.fn().mockResolvedValue(rows);
  queryBuilder.getCount = jest.fn().mockResolvedValue(count);
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
  let subprofiles: { createQueryBuilder: jest.Mock };
  let socialLinks: { createQueryBuilder: jest.Mock };
  let items: { find: jest.Mock };
  let profiles: { find: jest.Mock };
  let followersService: { loadFollowerCountsFor: jest.Mock };
  let blockFilter: { excludeBlocked: jest.Mock };

  beforeEach(async () => {
    subprofiles = { createQueryBuilder: jest.fn() };
    // Neither `loadSocialCountsFor` nor its `socialLinks` dependency is
    // exercised unless a test's rows have at least one id — default to an
    // empty grouped result so a test that doesn't care about socialCount is
    // unaffected.
    socialLinks = {
      createQueryBuilder: jest
        .fn()
        .mockReturnValue(makeSocialCountsQueryBuilderStub([])),
    };
    items = { find: jest.fn().mockResolvedValue([]) };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    followersService = {
      loadFollowerCountsFor: jest
        .fn()
        .mockResolvedValue(new Map<string, number>()),
    };
    blockFilter = { excludeBlocked: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
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
          provide: getRepositoryToken(Handle),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: BlockFilterService, useValue: blockFilter },
        {
          provide: ContentModerationService,
          useValue: {
            stateFor: jest
              .fn()
              .mockResolvedValue({ hidden: false, removed: false }),
            statesFor: jest.fn().mockResolvedValue(new Map()),
          },
        },
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
        {
          provide: SubprofileMembershipService,
          useValue: { isMember: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
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
      expect(qb.andWhere).toHaveBeenCalledWith(
        '(sp.displayName ILIKE :term OR sp.tagline ILIKE :term)',
        { term: '%50\\% off\\_grid%' },
      );
    });

    it('withholds a moderated/taken-down persona via an in-query NOT EXISTS clause', async () => {
      const rows = [makeSubprofile({ id: 'sp-a' })];
      const qb = makeSubprofilesQueryBuilderStub(rows);
      subprofiles.createQueryBuilder.mockReturnValue(qb);

      await service.directory({}, 'viewer-1');

      const moderatedCall = qb.andWhere.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === 'string' && call[0].includes('NOT EXISTS'),
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

    it('feeds each card the REAL batched follower/social/tags/ownerSlug reads, never a per-card query', async () => {
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
        { userId: 'owner-2', slug: 'starlet-owner' },
      ]);

      const result = await service.directory({}, 'viewer-1');

      // ONE grouped call per batch, over every row id on the page — never a
      // per-card call.
      expect(followersService.loadFollowerCountsFor).toHaveBeenCalledTimes(1);
      expect(followersService.loadFollowerCountsFor).toHaveBeenCalledWith([
        'sp-a',
        'sp-b',
      ]);
      // Owner-slug resolution is batched over ONLY the linked rows' userIds.
      expect(profiles.find).toHaveBeenCalledWith({
        where: { userId: In(['owner-2']) },
        select: ['userId', 'slug'],
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

      const starletCard = result.items.find(
        (card) => card.displayName === 'Starlet',
      );
      expect(starletCard?.followerCount).toBe(0);
      expect(starletCard?.socialCount).toBe(0); // missing from the batched map
      expect(starletCard?.tags).toEqual([]);
      expect(starletCard?.ownerSlug).toBe('starlet-owner');
    });
  });
});
