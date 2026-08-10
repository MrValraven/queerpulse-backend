import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MessagingService } from '../messaging/messaging.service';
import { Profile } from '../users/entities/profile.entity';
import {
  FlatmateProfile,
  FlatmateProfileType,
} from './entities/flatmate-profile.entity';
import { FlatmateProfilesService } from './flatmate-profiles.service';

type RepoMock = Record<string, jest.Mock>;

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
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const UPSERT_DTO = {
  type: FlatmateProfileType.Seeking,
  budgetEuros: 600,
} as never;

describe('FlatmateProfilesService', () => {
  let service: FlatmateProfilesService;
  let flatmates: RepoMock;
  let profiles: RepoMock;
  let messaging: { deliverEnquiry: jest.Mock };

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlatmateProfilesService,
        { provide: getRepositoryToken(FlatmateProfile), useValue: flatmates },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: MessagingService, useValue: messaging },
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
      } as never);

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
      expect(result).toEqual({ conversationId: 'conv-1' });
    });
  });
});
