import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import { FlatmateDirectoryService } from './flatmate-directory.service';
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
  let flatmates: RepoMock;
  let profiles: RepoMock;
  let blockFilter: { isBlockedEitherWay: jest.Mock; excludeHidden: jest.Mock };
  let verification: { levelForUser: jest.Mock; levelsForUsers: jest.Mock };

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlatmateDirectoryService,
        { provide: getRepositoryToken(FlatmateProfile), useValue: flatmates },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: VerificationService, useValue: verification },
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

    it('ranks opposite-type candidates ahead of same-type ones for a viewer with a profile', async () => {
      const viewer = makeFlatmate({
        ownerId: 'viewer-1',
        type: FlatmateProfileType.Seeking,
        budgetEuros: 700,
        neighbourhood: 'Arroios',
        lifestyleTags: ['nonsmoker'],
      });
      // Opposite type (Offering) -> scored; same type (Seeking) -> null score, sorts last.
      const opposite = makeFlatmate({
        ownerId: 'owner-opposite',
        slug: 'opposite',
        type: FlatmateProfileType.Offering,
        budgetEuros: 600,
        neighbourhood: 'Arroios',
        lifestyleTags: ['nonsmoker'],
      });
      const sameType = makeFlatmate({
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
