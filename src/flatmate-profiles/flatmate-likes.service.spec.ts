import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { BlockFilterService } from '../social/block-filter.service';
import {
  FlatmateLike,
  FlatmateLikeDecision,
} from './entities/flatmate-like.entity';
import {
  FlatmateProfile,
  FlatmateProfileType,
  IdentityVisibility,
} from './entities/flatmate-profile.entity';
import { FlatmateLikesService } from './flatmate-likes.service';

function makeFlatmate(
  overrides: Partial<FlatmateProfile> = {},
): FlatmateProfile {
  return {
    id: 'fm-1',
    ownerId: 'owner-x',
    slug: 'sam-flatmate',
    type: FlatmateProfileType.Offering,
    pronouns: '',
    neighbourhood: 'Arroios',
    budgetEuros: 600,
    moveInFrom: null,
    flexibleTiming: true,
    about: '',
    lifestyleTags: [],
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

describe('FlatmateLikesService', () => {
  let service: FlatmateLikesService;
  let likes: { upsert: jest.Mock; exists: jest.Mock };
  let flatmates: { findOne: jest.Mock };
  let blockFilter: { isBlockedEitherWay: jest.Mock };
  let contentModeration: { stateFor: jest.Mock };

  beforeEach(async () => {
    likes = {
      upsert: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(false),
    };
    flatmates = { findOne: jest.fn().mockResolvedValue(null) };
    blockFilter = { isBlockedEitherWay: jest.fn().mockResolvedValue(false) };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlatmateLikesService,
        { provide: getRepositoryToken(FlatmateLike), useValue: likes },
        { provide: getRepositoryToken(FlatmateProfile), useValue: flatmates },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: ContentModerationService, useValue: contentModeration },
      ],
    }).compile();

    service = module.get(FlatmateLikesService);
  });

  describe('decide', () => {
    it('404s an unknown slug', async () => {
      flatmates.findOne.mockResolvedValue(null);

      await expect(
        service.decide('viewer-1', 'ghost', FlatmateLikeDecision.Like),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects a decision on your own profile', async () => {
      flatmates.findOne.mockResolvedValue(
        makeFlatmate({ ownerId: 'viewer-1' }),
      );

      await expect(
        service.decide('viewer-1', 'sam-flatmate', FlatmateLikeDecision.Like),
      ).rejects.toThrow(BadRequestException);
    });

    it('404s a profile a moderator hid, and records no decision', async () => {
      flatmates.findOne.mockResolvedValue(makeFlatmate());
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });

      await expect(
        service.decide('viewer-1', 'sam-flatmate', FlatmateLikeDecision.Like),
      ).rejects.toThrow(NotFoundException);
      expect(contentModeration.stateFor).toHaveBeenCalledWith(
        'flatmate',
        'sam-flatmate',
      );
      expect(likes.upsert).not.toHaveBeenCalled();
    });

    it('404s a profile a moderator removed', async () => {
      flatmates.findOne.mockResolvedValue(makeFlatmate());
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: true,
      });

      await expect(
        service.decide('viewer-1', 'sam-flatmate', FlatmateLikeDecision.Pass),
      ).rejects.toThrow(NotFoundException);
      expect(likes.upsert).not.toHaveBeenCalled();
    });

    it('records a like on a visible profile', async () => {
      flatmates.findOne.mockResolvedValue(makeFlatmate());

      const result = await service.decide(
        'viewer-1',
        'sam-flatmate',
        FlatmateLikeDecision.Like,
      );

      expect(likes.upsert).toHaveBeenCalledWith(
        {
          fromUserId: 'viewer-1',
          toProfileId: 'fm-1',
          decision: FlatmateLikeDecision.Like,
        },
        ['fromUserId', 'toProfileId'],
      );
      expect(result.matched).toBe(false);
    });
  });
});
