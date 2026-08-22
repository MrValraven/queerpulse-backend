import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
import { MessagingService } from '../messaging/messaging.service';
import { Profile } from '../users/entities/profile.entity';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import { UpsertFlatmateProfileDto } from './dto/upsert-flatmate-profile.dto';
import {
  FlatmateProfile,
  FlatmateProfileType,
  IdentityVisibility,
} from './entities/flatmate-profile.entity';
import { FlatmateProfilesService } from './flatmate-profiles.service';

function makeFlatmate(
  overrides: Partial<FlatmateProfile> = {},
): FlatmateProfile {
  return {
    id: 'fm-1',
    ownerId: 'owner-1',
    slug: 'sam-flatmate',
    type: FlatmateProfileType.Seeking,
    pronouns: 'they/them',
    neighbourhood: 'Arroios',
    budgetEuros: 600,
    moveInFrom: null,
    flexibleTiming: true,
    about: 'Quiet, tidy.',
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

// Typed as the real DTO (not the previous `as never` cast) so spreading it
// with an override below type-checks: spreading a `never`-typed value is a
// compile error ("Spread types may only be created from object types").
const UPSERT_DTO: UpsertFlatmateProfileDto = {
  type: FlatmateProfileType.Seeking,
  budgetEuros: 600,
};

describe('FlatmateProfilesService', () => {
  let service: FlatmateProfilesService;
  // Declared with the exact method shape (rather than a bare
  // index-signature alias) so `flatmates.findOne.mockResolvedValue(...)`-style
  // chained access doesn't see `noUncheckedIndexedAccess`'s `| undefined`.
  let flatmates: {
    findOne: jest.Mock;
    exists: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
  };
  let profiles: { find: jest.Mock; findOne: jest.Mock };
  let messaging: { deliverEnquiry: jest.Mock };
  let verification: {
    requireLevel: jest.Mock;
    levelForUser: jest.Mock;
    levelsForUsers: jest.Mock;
  };
  let affirmingPledge: { requireAccepted: jest.Mock };

  beforeEach(async () => {
    flatmates = {
      findOne: jest.fn().mockResolvedValue(null),
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((row: unknown) => row),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    profiles = { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() };
    messaging = {
      deliverEnquiry: jest.fn().mockResolvedValue({ conversationId: 'conv-1' }),
    };
    verification = {
      requireLevel: jest.fn().mockResolvedValue(undefined),
      levelForUser: jest.fn().mockResolvedValue(VerificationLevel.Email),
      levelsForUsers: jest.fn().mockResolvedValue(new Map()),
    };
    affirmingPledge = {
      requireAccepted: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlatmateProfilesService,
        { provide: getRepositoryToken(FlatmateProfile), useValue: flatmates },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: MessagingService, useValue: messaging },
        { provide: VerificationService, useValue: verification },
        { provide: AffirmingPledgeService, useValue: affirmingPledge },
      ],
    }).compile();

    service = module.get(FlatmateProfilesService);
  });

  describe('upsertMine', () => {
    it('updates the existing profile in place when one already exists', async () => {
      const existing = makeFlatmate({ about: 'old bio' });
      flatmates.findOne.mockResolvedValue(existing);
      flatmates.save.mockImplementation((row: unknown) => Promise.resolve(row));

      const result = await service.upsertMine('owner-1', {
        ...UPSERT_DTO,
        about: 'new bio',
      });

      // PUT semantics: the write goes to the loaded row (no create/slug work).
      expect(flatmates.create).not.toHaveBeenCalled();
      expect(flatmates.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'fm-1', about: 'new bio' }),
      );
      expect(result.slug).toBe('sam-flatmate');
    });

    it('creates a new profile (name-seeded slug) when the member has none', async () => {
      flatmates.findOne.mockResolvedValue(null); // no existing profile
      profiles.findOne.mockResolvedValue({ firstName: 'Sam', lastName: 'Lee' });
      flatmates.exists.mockResolvedValue(false); // slug is free
      flatmates.save.mockImplementation((row: unknown) =>
        Promise.resolve(makeFlatmate({ ...(row as object), slug: 'sam-lee' })),
      );

      const result = await service.upsertMine('owner-1', UPSERT_DTO);

      expect(flatmates.create).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'owner-1', slug: 'sam-lee' }),
      );
      expect(result.slug).toBe('sam-lee');
    });
  });

  describe('getMine', () => {
    it('returns null when the member has no flatmate profile', async () => {
      flatmates.findOne.mockResolvedValue(null);

      await expect(service.getMine('owner-1')).resolves.toBeNull();
    });

    it('returns the DTO (owner view has a null matchScore)', async () => {
      flatmates.findOne.mockResolvedValue(makeFlatmate());

      const result = await service.getMine('owner-1');

      expect(result?.slug).toBe('sam-flatmate');
      expect(result?.matchScore).toBeNull();
    });
  });

  describe('deleteMine', () => {
    it('is a no-op when there is nothing to delete', async () => {
      flatmates.findOne.mockResolvedValue(null);

      await service.deleteMine('owner-1');

      expect(flatmates.remove).not.toHaveBeenCalled();
    });

    it('removes the profile when it exists', async () => {
      const profile = makeFlatmate();
      flatmates.findOne.mockResolvedValue(profile);

      await service.deleteMine('owner-1');

      expect(flatmates.remove).toHaveBeenCalledWith(profile);
    });
  });

  describe('sayHello', () => {
    it('404s when the target flatmate profile is unknown', async () => {
      flatmates.findOne.mockResolvedValue(null);

      await expect(
        service.sayHello('ghost', 'sender', { body: 'hi' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects saying hello to your own profile', async () => {
      flatmates.findOne.mockResolvedValue(makeFlatmate({ ownerId: 'owner-1' }));

      await expect(
        service.sayHello('sam-flatmate', 'owner-1', { body: 'hi' }),
      ).rejects.toThrow(BadRequestException);
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('falls back to the default greeting when the body is blank', async () => {
      flatmates.findOne.mockResolvedValue(makeFlatmate({ ownerId: 'owner-1' }));

      await service.sayHello('sam-flatmate', 'sender', {
        body: '   ',
      });

      expect(messaging.deliverEnquiry).toHaveBeenCalledWith(
        'sender',
        'owner-1',
        expect.stringContaining('QueerPulse'),
      );
    });

    it('delivers a supplied greeting to the profile owner', async () => {
      flatmates.findOne.mockResolvedValue(makeFlatmate({ ownerId: 'owner-1' }));

      const result = await service.sayHello('sam-flatmate', 'sender', {
        body: 'Hey, still looking?',
      });

      expect(messaging.deliverEnquiry).toHaveBeenCalledWith(
        'sender',
        'owner-1',
        'Hey, still looking?',
      );
      expect(result).toEqual({
        conversationId: 'conv-1',
        pronounsShared: false,
      });
    });

    it('appends the sender pronouns when they opt in AND have consent', async () => {
      // First lookup resolves the target (by slug); the pronoun pre-share then
      // loads the SENDER's own profile (by ownerId).
      flatmates.findOne.mockImplementation(
        ({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(
            where.slug === 'sam-flatmate'
              ? makeFlatmate({ ownerId: 'owner-1', slug: 'sam-flatmate' })
              : makeFlatmate({
                  ownerId: 'sender',
                  slug: 'sender-flatmate',
                  pronouns: 'she/her',
                  specialCategoryConsentAt: new Date(),
                }),
          ),
      );

      const result = await service.sayHello('sam-flatmate', 'sender', {
        body: 'Hi there',
        sharePronouns: true,
      });

      expect(messaging.deliverEnquiry).toHaveBeenCalledWith(
        'sender',
        'owner-1',
        expect.stringContaining('she/her'),
      );
      expect(result.pronounsShared).toBe(true);
    });

    it('never shares pronouns without stored consent, even when opted in', async () => {
      flatmates.findOne.mockImplementation(
        ({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(
            where.slug === 'sam-flatmate'
              ? makeFlatmate({ ownerId: 'owner-1', slug: 'sam-flatmate' })
              : makeFlatmate({
                  ownerId: 'sender',
                  slug: 'sender-flatmate',
                  pronouns: 'she/her',
                  // No consent on record → the gate withholds the pronoun.
                  specialCategoryConsentAt: null,
                }),
          ),
      );

      const result = await service.sayHello('sam-flatmate', 'sender', {
        body: 'Hi there',
        sharePronouns: true,
      });

      expect(messaging.deliverEnquiry).toHaveBeenCalledWith(
        'sender',
        'owner-1',
        'Hi there',
      );
      expect(result.pronounsShared).toBe(false);
    });
  });
});
