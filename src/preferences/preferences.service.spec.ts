import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  MemberPreferences,
  OutAtWork,
} from './entities/member-preferences.entity';
import { PreferencesService } from './preferences.service';

describe('PreferencesService', () => {
  let service: PreferencesService;
  let repo: {
    findOne: jest.Mock;
    save: jest.Mock;
  };

  const now = new Date('2026-07-18T12:00:00.000Z');

  const row = (overrides: Partial<MemberPreferences> = {}): MemberPreferences =>
    Object.assign(new MemberPreferences(), {
      userId: 'u1',
      outAtWork: OutAtWork.Out,
      transSupport: ['chosen-name'],
      safeOnly: false,
      publicProfileEnabled: true,
      updatedAt: now,
      ...overrides,
    });

  beforeEach(async () => {
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((v: MemberPreferences) => Promise.resolve(v)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PreferencesService,
        { provide: getRepositoryToken(MemberPreferences), useValue: repo },
      ],
    }).compile();

    service = module.get(PreferencesService);
  });

  describe('getWorkPreferences', () => {
    // The whole point of the defaults: a member who has never opened the Work
    // Profile page must get a coherent answer, not a 404.
    it('returns the documented defaults when no row exists', async () => {
      repo.findOne.mockResolvedValue(null);

      const result = await service.getWorkPreferences('u1');

      expect(repo.findOne).toHaveBeenCalledWith({ where: { userId: 'u1' } });
      expect(result).toEqual({
        outAtWork: OutAtWork.Verified,
        transSupport: [],
        safeOnly: true,
      });
    });

    it('never persists a row on read', async () => {
      repo.findOne.mockResolvedValue(null);

      await service.getWorkPreferences('u1');

      expect(repo.save).not.toHaveBeenCalled();
    });

    it('returns the stored settings when a row exists', async () => {
      repo.findOne.mockResolvedValue(row());

      const result = await service.getWorkPreferences('u1');

      expect(result).toEqual({
        outAtWork: OutAtWork.Out,
        transSupport: ['chosen-name'],
        safeOnly: false,
      });
    });

    // Disjoint projections — the work endpoint must not leak the visibility
    // switch the two endpoints share a row with.
    it('does not expose the public-profile flag', async () => {
      repo.findOne.mockResolvedValue(row());

      const result = await service.getWorkPreferences('u1');

      expect(result).not.toHaveProperty('enabled');
      expect(result).not.toHaveProperty('publicProfileEnabled');
    });
  });

  describe('updateWorkPreferences', () => {
    it('inserts a row keyed to the caller when none exists', async () => {
      repo.findOne.mockResolvedValue(null);

      const result = await service.updateWorkPreferences('u1', {
        outAtWork: OutAtWork.Private,
        transSupport: ['hide-legal'],
        safeOnly: true,
      });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          outAtWork: OutAtWork.Private,
          transSupport: ['hide-legal'],
          safeOnly: true,
        }),
      );
      expect(result).toEqual({
        outAtWork: OutAtWork.Private,
        transSupport: ['hide-legal'],
        safeOnly: true,
      });
    });

    // A new row must not silently publish the profile: the untouched
    // visibility switch has to land on its default.
    it('leaves the public-profile flag off when inserting a new row', async () => {
      repo.findOne.mockResolvedValue(null);

      await service.updateWorkPreferences('u1', {
        outAtWork: OutAtWork.Out,
        transSupport: [],
        safeOnly: true,
      });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ publicProfileEnabled: false }),
      );
    });

    // The two endpoints share one row; writing one must never clobber the other.
    it('preserves an existing public-profile flag', async () => {
      repo.findOne.mockResolvedValue(row({ publicProfileEnabled: true }));

      await service.updateWorkPreferences('u1', {
        outAtWork: OutAtWork.Private,
        transSupport: [],
        safeOnly: true,
      });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ publicProfileEnabled: true }),
      );
    });

    it('replaces the whole selection rather than merging it', async () => {
      repo.findOne.mockResolvedValue(
        row({ transSupport: ['chosen-name', 'hide-legal'] }),
      );

      const result = await service.updateWorkPreferences('u1', {
        outAtWork: OutAtWork.Out,
        transSupport: ['transition-friendly'],
        safeOnly: true,
      });

      expect(result.transSupport).toEqual(['transition-friendly']);
    });

    it('clears the selection when given an empty list', async () => {
      repo.findOne.mockResolvedValue(row());

      const result = await service.updateWorkPreferences('u1', {
        outAtWork: OutAtWork.Out,
        transSupport: [],
        safeOnly: true,
      });

      expect(result.transSupport).toEqual([]);
    });

    it('de-duplicates the selection, keeping the member’s order', async () => {
      repo.findOne.mockResolvedValue(null);

      const result = await service.updateWorkPreferences('u1', {
        outAtWork: OutAtWork.Out,
        transSupport: ['hide-legal', 'chosen-name', 'hide-legal'],
        safeOnly: true,
      });

      expect(result.transSupport).toEqual(['hide-legal', 'chosen-name']);
    });
  });

  describe('getPublicProfile', () => {
    // Off unless the member has said otherwise — never default a publication
    // switch to on.
    it('defaults to disabled when no row exists', async () => {
      repo.findOne.mockResolvedValue(null);

      expect(await service.getPublicProfile('u1')).toEqual({ enabled: false });
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('returns the stored flag when a row exists', async () => {
      repo.findOne.mockResolvedValue(row({ publicProfileEnabled: true }));

      expect(await service.getPublicProfile('u1')).toEqual({ enabled: true });
    });

    it('does not expose the work-safety settings', async () => {
      repo.findOne.mockResolvedValue(row());

      const result = await service.getPublicProfile('u1');

      expect(result).toEqual({ enabled: true });
    });
  });

  describe('updatePublicProfile', () => {
    it('inserts a row keyed to the caller when none exists', async () => {
      repo.findOne.mockResolvedValue(null);

      const result = await service.updatePublicProfile('u1', { enabled: true });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', publicProfileEnabled: true }),
      );
      expect(result).toEqual({ enabled: true });
    });

    // A member turning publication OFF is the safety-critical direction; it
    // must round-trip as reliably as turning it on.
    it('persists disabling an already-enabled profile', async () => {
      repo.findOne.mockResolvedValue(row({ publicProfileEnabled: true }));

      const result = await service.updatePublicProfile('u1', {
        enabled: false,
      });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ publicProfileEnabled: false }),
      );
      expect(result).toEqual({ enabled: false });
    });

    it('leaves the work-safety settings untouched', async () => {
      repo.findOne.mockResolvedValue(row());

      await service.updatePublicProfile('u1', { enabled: false });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          outAtWork: OutAtWork.Out,
          transSupport: ['chosen-name'],
          safeOnly: false,
        }),
      );
    });

    // Defaults must not leak in as a side effect of touching the other
    // endpoint's row.
    it('uses work-preference defaults when creating the row', async () => {
      repo.findOne.mockResolvedValue(null);

      await service.updatePublicProfile('u1', { enabled: true });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          outAtWork: OutAtWork.Verified,
          transSupport: [],
          safeOnly: true,
        }),
      );
    });
  });
});
