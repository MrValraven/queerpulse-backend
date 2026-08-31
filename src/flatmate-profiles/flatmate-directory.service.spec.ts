import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import { FlatmateDirectoryService } from './flatmate-directory.service';
import { FlatmateLikesService } from './flatmate-likes.service';
import {
  FlatmateProfile,
  FlatmateProfileType,
  IdentityVisibility,
} from './entities/flatmate-profile.entity';

type RepoMock = Record<string, jest.Mock>;
type QueryBuilderStub = Record<string, jest.Mock>;

function makeBuilder(terminals: {
  getManyAndCount?: [unknown[], number];
  getMany?: unknown[];
  getCount?: number;
}): QueryBuilderStub {
  const builder: QueryBuilderStub = {};
  for (const method of ['where', 'andWhere', 'orderBy', 'skip', 'take']) {
    builder[method] = jest.fn().mockReturnValue(builder);
  }
  builder.getManyAndCount = jest
    .fn()
    .mockResolvedValue(terminals.getManyAndCount ?? [[], 0]);
  builder.getMany = jest.fn().mockResolvedValue(terminals.getMany ?? []);
  builder.getCount = jest.fn().mockResolvedValue(terminals.getCount ?? 0);
  return builder;
}

function makeFlatmate(
  overrides: Partial<FlatmateProfile> = {},
): FlatmateProfile {
  return {
    id: 'fm-1',
    ownerId: 'owner-x',
    slug: 'sam-flatmate',
    type: FlatmateProfileType.Offering,
    pronouns: 'they/them',
    neighbourhood: 'Arroios',
    budgetEuros: 600,
    moveInFrom: null,
    flexibleTiming: true,
    about: '',
    lifestyleTags: ['nonsmoker'],
    genderIdentity: null,
    safeSpaceNeeds: null,
    householdNorms: null,
    identityHousehold: null,
    identityVisibility: IdentityVisibility.Matches,
    specialCategoryConsentAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('FlatmateDirectoryService', () => {
  let service: FlatmateDirectoryService;
  // Declared with the exact method shape (rather than the bare `RepoMock`
  // index-signature alias) so `flatmates.findOne.mockResolvedValue(...)`-style
  // chained access doesn't see `noUncheckedIndexedAccess`'s `| undefined`.
  let flatmates: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let profiles: RepoMock;
  let blockFilter: { isBlockedEitherWay: jest.Mock; excludeHidden: jest.Mock };
  let verification: { levelForUser: jest.Mock; levelsForUsers: jest.Mock };
  let contentModeration: { stateFor: jest.Mock };
  let likes: { mutuallyMatchedProfileIds: jest.Mock };

  beforeEach(async () => {
    flatmates = {
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(() => makeBuilder({})),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    blockFilter = {
      isBlockedEitherWay: jest.fn().mockResolvedValue(false),
      // In-query severance is a no-op in unit tests (just mutates the builder).
      excludeHidden: jest.fn(),
    };
    verification = {
      levelForUser: jest.fn().mockResolvedValue(VerificationLevel.Email),
      levelsForUsers: jest.fn().mockResolvedValue(new Map()),
    };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };
    // Nobody is matched by default, which is the fail-closed direction for the
    // Art.9 gate: a test that wants a reveal has to say so explicitly.
    likes = {
      mutuallyMatchedProfileIds: jest.fn().mockResolvedValue(new Set<string>()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlatmateDirectoryService,
        { provide: getRepositoryToken(FlatmateProfile), useValue: flatmates },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: VerificationService, useValue: verification },
        { provide: ContentModerationService, useValue: contentModeration },
        { provide: FlatmateLikesService, useValue: likes },
      ],
    }).compile();

    service = module.get(FlatmateDirectoryService);
  });

  describe('browse', () => {
    it('serves a newest-first, unscored page when the viewer has no profile', async () => {
      flatmates.findOne.mockResolvedValue(null); // viewer has no profile
      flatmates.createQueryBuilder.mockReturnValue(
        makeBuilder({ getManyAndCount: [[makeFlatmate()], 1] }),
      );

      const result = await service.browse('viewer-1', {});

      expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20 });
      expect(result.items[0]?.matchScore).toBeNull();
    });

    it('drops moderator-taken-down profiles in-query, so the page and total agree', async () => {
      flatmates.findOne.mockResolvedValue(null); // viewer has no profile
      const builder = makeBuilder({ getManyAndCount: [[makeFlatmate()], 1] });
      flatmates.createQueryBuilder.mockReturnValue(builder);

      await service.browse('viewer-1', {});

      // The takedown predicate is a NOT EXISTS subquery (no join, so the
      // skip/take pagination stays correct) bound to the `flatmate` subject
      // type and matching a hidden OR removed row.
      // A NOT EXISTS subquery, so no join is added and the offset pagination
      // above stays correct. Both `hidden_at` and `removed_at` withhold.
      const takedownParams = { flatmateSubjectType: 'flatmate' };
      expect(builder.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('NOT EXISTS'),
        takedownParams,
      );
      expect(builder.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('"content_moderation"'),
        takedownParams,
      );
      expect(builder.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('"cm"."hidden_at" IS NOT NULL'),
        takedownParams,
      );
      expect(builder.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('"cm"."removed_at" IS NOT NULL'),
        takedownParams,
      );
    });

    it('ranks opposite-type candidates ahead of same-type ones for a viewer with a profile', async () => {
      const viewer = makeFlatmate({
        ownerId: 'viewer-1',
        type: FlatmateProfileType.Seeking,
        budgetEuros: 700,
        neighbourhood: 'Arroios',
        lifestyleTags: ['nonsmoker'],
      });
      // Opposite type (Offering) -> scored; same type (Seeking) -> null score, sorts last.
      // DISTINCT ids matter: the ranked path re-reads the page's rows and keys
      // them by `id`, so two fixtures sharing the default id collapse into one
      // and the page serves the same profile twice.
      const opposite = makeFlatmate({
        id: 'fm-opposite',
        ownerId: 'owner-opposite',
        slug: 'opposite',
        type: FlatmateProfileType.Offering,
        budgetEuros: 600,
        neighbourhood: 'Arroios',
        lifestyleTags: ['nonsmoker'],
      });
      const sameType = makeFlatmate({
        id: 'fm-same',
        ownerId: 'owner-same',
        slug: 'same-type',
        type: FlatmateProfileType.Seeking,
      });

      // First findOne loads the viewer's own profile.
      flatmates.findOne.mockResolvedValue(viewer);
      // The same builder serves the candidate getMany and the count getCount.
      flatmates.createQueryBuilder.mockReturnValue(
        makeBuilder({ getMany: [sameType, opposite], getCount: 2 }),
      );

      const result = await service.browse('viewer-1', {});

      expect(result.total).toBe(2);
      // Scored opposite-type candidate comes first; unscored same-type follows.
      expect(result.items[0]?.slug).toBe('opposite');
      expect(result.items[0]?.matchScore).toBeGreaterThan(0);
      expect(result.items[1]?.slug).toBe('same-type');
      expect(result.items[1]?.matchScore).toBeNull();
    });
  });

  // ENG-51. `identity_visibility = 'matches'` used to mean "the viewer holds a
  // profile whose `type` differs from this one", which is not a gate: `type` is
  // a field the viewer sets on their OWN profile, so anyone could flip it and
  // read the consenting half of the other side of the board. It now means an
  // actual mutual match, and the Art.9 fields never ride on a list payload.
  describe('Art.9 identity gating', () => {
    /** A consenting profile with real special-category data in every gated
     *  field, so a leak through any one of them shows up as a failure. */
    function makeConsentingProfile(
      overrides: Partial<FlatmateProfile> = {},
    ): FlatmateProfile {
      return makeFlatmate({
        genderIdentity: 'trans woman',
        safeSpaceNeeds: ['no-alcohol'],
        identityHousehold: {
          pronounsAtHome: 'always',
        } as FlatmateProfile['identityHousehold'],
        identityVisibility: IdentityVisibility.Matches,
        specialCategoryConsentAt: new Date('2026-01-01T00:00:00.000Z'),
        ...overrides,
      });
    }

    it('withholds the identity fields from a viewer who is not matched, even though their type is opposite', async () => {
      const profile = makeConsentingProfile({
        type: FlatmateProfileType.Offering,
      });
      flatmates.findOne.mockImplementation((options: { where: unknown }) => {
        const where = options.where as { slug?: string; ownerId?: string };
        if (where.slug) return Promise.resolve(profile);
        // The viewer holds the OPPOSITE type, which used to be the whole gate.
        return Promise.resolve(
          makeFlatmate({
            id: 'fm-viewer',
            ownerId: 'viewer-1',
            type: FlatmateProfileType.Seeking,
          }),
        );
      });
      likes.mutuallyMatchedProfileIds.mockResolvedValue(new Set<string>());

      const dto = await service.detail('viewer-1', 'sam-flatmate');

      expect(dto.genderIdentity).toBeNull();
      expect(dto.safeSpaceNeeds).toEqual([]);
      expect(dto.identityHousehold).toBeNull();
      expect(dto.pronouns).toBe('');
    });

    it('reveals the identity fields to a mutually matched viewer', async () => {
      const profile = makeConsentingProfile({
        type: FlatmateProfileType.Offering,
      });
      flatmates.findOne.mockImplementation((options: { where: unknown }) => {
        const where = options.where as { slug?: string };
        if (where.slug) return Promise.resolve(profile);
        return Promise.resolve(
          makeFlatmate({
            id: 'fm-viewer',
            ownerId: 'viewer-1',
            type: FlatmateProfileType.Seeking,
          }),
        );
      });
      likes.mutuallyMatchedProfileIds.mockResolvedValue(new Set(['fm-1']));

      const dto = await service.detail('viewer-1', 'sam-flatmate');

      expect(dto.genderIdentity).toBe('trans woman');
      expect(dto.safeSpaceNeeds).toEqual(['no-alcohol']);
      expect(dto.identityHousehold).not.toBeNull();
      expect(dto.pronouns).toBe('they/them');
    });

    it("withholds a `matches` profile's identity fields from the browse list, so the board cannot be walked for them", async () => {
      // The bulk read the finding was about. Every row on this page is a
      // consenting `matches` profile, and the list must hand over none of it
      // however many pages an attacker walks.
      const profile = makeConsentingProfile({
        identityVisibility: IdentityVisibility.Matches,
      });
      flatmates.findOne.mockResolvedValue(null); // viewer has no profile
      flatmates.createQueryBuilder.mockReturnValue(
        makeBuilder({ getManyAndCount: [[profile], 1] }),
      );

      const result = await service.browse('viewer-1', {});

      expect(result.items).toHaveLength(1);
      const [item] = result.items;
      expect(item?.genderIdentity).toBeNull();
      expect(item?.safeSpaceNeeds).toEqual([]);
      expect(item?.identityHousehold).toBeNull();
      expect(item?.pronouns).toBe('');
    });

    it("keeps a `members`-visible profile's identity fields on the browse list, because the owner chose that", async () => {
      // `public`/`members` is an explicit decision by the owner to be visible to
      // any member, and the cards and discovery deck are where that decision
      // does its work. The list honours it; only `matches` is withheld here.
      const profile = makeConsentingProfile({
        identityVisibility: IdentityVisibility.Members,
      });
      flatmates.findOne.mockResolvedValue(null); // viewer has no profile
      flatmates.createQueryBuilder.mockReturnValue(
        makeBuilder({ getManyAndCount: [[profile], 1] }),
      );

      const result = await service.browse('viewer-1', {});

      const [item] = result.items;
      expect(item?.genderIdentity).toBe('trans woman');
      expect(item?.safeSpaceNeeds).toEqual(['no-alcohol']);
      expect(item?.pronouns).toBe('they/them');
    });

    it('asks for mutual matches in ONE batched call per ranked page, never per candidate', async () => {
      const viewer = makeFlatmate({
        id: 'fm-viewer',
        ownerId: 'viewer-1',
        type: FlatmateProfileType.Seeking,
      });
      const candidates = [
        makeConsentingProfile({ id: 'fm-1', ownerId: 'owner-1' }),
        makeConsentingProfile({ id: 'fm-2', ownerId: 'owner-2' }),
        makeConsentingProfile({ id: 'fm-3', ownerId: 'owner-3' }),
      ];
      flatmates.findOne.mockResolvedValue(viewer);
      flatmates.createQueryBuilder.mockReturnValue(
        makeBuilder({ getMany: candidates, getCount: candidates.length }),
      );

      await service.browse('viewer-1', {});

      expect(likes.mutuallyMatchedProfileIds).toHaveBeenCalledTimes(1);
      expect(likes.mutuallyMatchedProfileIds).toHaveBeenCalledWith('viewer-1', [
        { id: 'fm-1', ownerId: 'owner-1' },
        { id: 'fm-2', ownerId: 'owner-2' },
        { id: 'fm-3', ownerId: 'owner-3' },
      ]);
    });
  });

  describe('detail', () => {
    it('404s an unknown slug', async () => {
      flatmates.findOne.mockResolvedValue(null);

      await expect(service.detail('viewer-1', 'ghost')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404s (does not confirm existence) when the pair is blocked either way', async () => {
      flatmates.findOne.mockResolvedValue(makeFlatmate({ ownerId: 'owner-x' }));
      blockFilter.isBlockedEitherWay.mockResolvedValue(true);

      await expect(service.detail('viewer-1', 'sam-flatmate')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404s a profile a moderator hid (never confirms it exists)', async () => {
      flatmates.findOne.mockResolvedValue(makeFlatmate({ ownerId: 'owner-x' }));
      blockFilter.isBlockedEitherWay.mockResolvedValue(false);
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });

      await expect(service.detail('viewer-1', 'sam-flatmate')).rejects.toThrow(
        NotFoundException,
      );
      expect(contentModeration.stateFor).toHaveBeenCalledWith(
        'flatmate',
        'sam-flatmate',
      );
    });

    it('404s a profile a moderator removed, including for its own owner', async () => {
      flatmates.findOne.mockResolvedValue(
        makeFlatmate({ ownerId: 'viewer-1' }),
      );
      blockFilter.isBlockedEitherWay.mockResolvedValue(false);
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: true,
      });

      await expect(service.detail('viewer-1', 'sam-flatmate')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('computes a match score against an opposite-type viewer', async () => {
      const target = makeFlatmate({
        ownerId: 'owner-x',
        type: FlatmateProfileType.Offering,
        budgetEuros: 600,
        neighbourhood: 'Arroios',
      });
      const viewer = makeFlatmate({
        ownerId: 'viewer-1',
        type: FlatmateProfileType.Seeking,
        budgetEuros: 700,
        neighbourhood: 'Arroios',
      });
      flatmates.findOne
        .mockResolvedValueOnce(target) // by slug
        .mockResolvedValueOnce(viewer); // viewer's own profile
      blockFilter.isBlockedEitherWay.mockResolvedValue(false);

      const result = await service.detail('viewer-1', 'sam-flatmate');

      expect(result.matchScore).toBeGreaterThan(0);
    });

    it('leaves matchScore null when the viewer looks at their own profile', async () => {
      flatmates.findOne.mockResolvedValue(
        makeFlatmate({ ownerId: 'viewer-1' }),
      );
      blockFilter.isBlockedEitherWay.mockResolvedValue(false);

      const result = await service.detail('viewer-1', 'sam-flatmate');

      expect(result.matchScore).toBeNull();
    });
  });
});
