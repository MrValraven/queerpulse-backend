import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  MemberPreferences,
  OutAtWork,
} from './entities/member-preferences.entity';
import { PreferencesService } from './preferences.service';
import { PublicEligibilityService } from '../public-eligibility/public-eligibility.service';
import { UserStatus } from '../users/entities/user.entity';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';

/** The caller `PUT /me/public-profile` receives from `@CurrentUser()`. */
const CALLER: CurrentUserData = {
  userId: 'u1',
  email: 'a@b.c',
  status: UserStatus.Active,
  role: 'member',
};

describe('PreferencesService', () => {
  let service: PreferencesService;
  let repo: {
    findOne: jest.Mock;
    save: jest.Mock;
  };
  // The server-side publication gate. Resolves (eligible) by default; the
  // ineligible cases make it throw, exactly as `assertMayGoPublic` does.
  let eligibility: { assertMayGoPublic: jest.Mock };

  const now = new Date('2026-07-18T12:00:00.000Z');

  const row = (overrides: Partial<MemberPreferences> = {}): MemberPreferences =>
    Object.assign(new MemberPreferences(), {
      userId: 'u1',
      outAtWork: OutAtWork.Out,
      transSupport: ['chosen-name'],
      safeOnly: false,
      skills: ['branding'],
      focusAreas: ['coming-out'],
      publicProfileEnabled: true,
      updatedAt: now,
      ...overrides,
    });

  beforeEach(async () => {
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((v: MemberPreferences) => Promise.resolve(v)),
    };
    eligibility = { assertMayGoPublic: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PreferencesService,
        { provide: getRepositoryToken(MemberPreferences), useValue: repo },
        { provide: PublicEligibilityService, useValue: eligibility },
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
        skills: [],
        focusAreas: [],
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
        skills: ['branding'],
        focusAreas: ['coming-out'],
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
        skills: ['product'],
        focusAreas: ['mental-health'],
      });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          outAtWork: OutAtWork.Private,
          transSupport: ['hide-legal'],
          safeOnly: true,
          skills: ['product'],
          focusAreas: ['mental-health'],
        }),
      );
      expect(result).toEqual({
        outAtWork: OutAtWork.Private,
        transSupport: ['hide-legal'],
        safeOnly: true,
        skills: ['product'],
        focusAreas: ['mental-health'],
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
        skills: [],
        focusAreas: [],
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
        skills: [],
        focusAreas: [],
      });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ publicProfileEnabled: true }),
      );
    });

    it('replaces the whole selection rather than merging it', async () => {
      repo.findOne.mockResolvedValue(
        row({
          transSupport: ['chosen-name', 'hide-legal'],
          skills: ['branding', 'backend'],
          focusAreas: ['coming-out', 'mental-health'],
        }),
      );

      const result = await service.updateWorkPreferences('u1', {
        outAtWork: OutAtWork.Out,
        transSupport: ['transition-friendly'],
        safeOnly: true,
        skills: ['product'],
        focusAreas: ['career-direction'],
      });

      expect(result.transSupport).toEqual(['transition-friendly']);
      expect(result.skills).toEqual(['product']);
      expect(result.focusAreas).toEqual(['career-direction']);
    });

    it('clears the selection when given an empty list', async () => {
      repo.findOne.mockResolvedValue(row());

      const result = await service.updateWorkPreferences('u1', {
        outAtWork: OutAtWork.Out,
        transSupport: [],
        safeOnly: true,
        skills: [],
        focusAreas: [],
      });

      expect(result.transSupport).toEqual([]);
      expect(result.skills).toEqual([]);
      expect(result.focusAreas).toEqual([]);
    });

    it('de-duplicates the selection, keeping the member’s order', async () => {
      repo.findOne.mockResolvedValue(null);

      const result = await service.updateWorkPreferences('u1', {
        outAtWork: OutAtWork.Out,
        transSupport: ['hide-legal', 'chosen-name', 'hide-legal'],
        safeOnly: true,
        skills: ['product', 'branding', 'product'],
        focusAreas: ['mental-health', 'coming-out', 'mental-health'],
      });

      expect(result.transSupport).toEqual(['hide-legal', 'chosen-name']);
      expect(result.skills).toEqual(['product', 'branding']);
      expect(result.focusAreas).toEqual(['mental-health', 'coming-out']);
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

      const result = await service.updatePublicProfile(CALLER, {
        enabled: true,
      });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', publicProfileEnabled: true }),
      );
      expect(result).toEqual({ enabled: true });
    });

    // A member turning publication OFF is the safety-critical direction; it
    // must round-trip as reliably as turning it on.
    it('persists disabling an already-enabled profile', async () => {
      repo.findOne.mockResolvedValue(row({ publicProfileEnabled: true }));

      const result = await service.updatePublicProfile(CALLER, {
        enabled: false,
      });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ publicProfileEnabled: false }),
      );
      expect(result).toEqual({ enabled: false });
    });

    it('leaves the work-safety settings untouched', async () => {
      repo.findOne.mockResolvedValue(row());

      await service.updatePublicProfile(CALLER, { enabled: false });

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

      await service.updatePublicProfile(CALLER, { enabled: true });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          outAtWork: OutAtWork.Verified,
          transSupport: [],
          safeOnly: true,
        }),
      );
    });

    // ---- The server-side publication gate (SOC-11) ------------------------
    //
    // The whole point: this switch reaches the open web, so the rule has to be
    // enforced where the write happens. It used to be assigned straight from
    // the DTO with the entire 90-day / 100-point rule living in frontend JS.

    it('runs the eligibility gate before enabling, passing the whole caller', async () => {
      repo.findOne.mockResolvedValue(null);

      await service.updatePublicProfile(CALLER, { enabled: true });

      expect(eligibility.assertMayGoPublic).toHaveBeenCalledWith(CALLER);
    });

    it('refuses to enable for an ineligible member and writes nothing', async () => {
      repo.findOne.mockResolvedValue(row({ publicProfileEnabled: false }));
      eligibility.assertMayGoPublic.mockRejectedValue(
        new ForbiddenException({ reasonCode: 'tenure_too_short' }),
      );

      await expect(
        service.updatePublicProfile(CALLER, { enabled: true }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(repo.save).not.toHaveBeenCalled();
    });

    // The asymmetry is the safety property. A member who has become
    // ineligible, been suspended, or deactivated must still be able to pull
    // their profile back off the open web.
    it('never gates disabling, even when the member is ineligible', async () => {
      repo.findOne.mockResolvedValue(row({ publicProfileEnabled: true }));
      eligibility.assertMayGoPublic.mockRejectedValue(
        new ForbiddenException({ reasonCode: 'not_eligible' }),
      );

      const result = await service.updatePublicProfile(
        { ...CALLER, status: UserStatus.Suspended },
        { enabled: false },
      );

      expect(eligibility.assertMayGoPublic).not.toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ publicProfileEnabled: false }),
      );
      expect(result).toEqual({ enabled: false });
    });

    // Re-asserting `true` on an already-published profile is still a publish
    // request, so it is checked again: standing can change under a member.
    it('re-checks eligibility when enabling an already-enabled profile', async () => {
      repo.findOne.mockResolvedValue(row({ publicProfileEnabled: true }));
      eligibility.assertMayGoPublic.mockRejectedValue(
        new ForbiddenException({ reasonCode: 'not_eligible' }),
      );

      await expect(
        service.updatePublicProfile(CALLER, { enabled: true }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(repo.save).not.toHaveBeenCalled();
    });
  });
});
