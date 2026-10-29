import { ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
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

  describe('getContentSensitivity (PRD-10)', () => {
    // The permissive default is the whole product decision here: a member who
    // has never opened the Interests pane is shown the entire platform.
    it('shows everything when no row exists', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.getContentSensitivity('u1')).resolves.toEqual({
        hideDating: false,
        hideMentalHealth: false,
        hideSexualityIdentity: false,
      });
    });

    it('projects the stored flags', async () => {
      repo.findOne.mockResolvedValue(
        row({
          hideDatingContent: false,
          hideMentalHealthContent: true,
          hideSexualityIdentityContent: false,
        }),
      );

      await expect(service.getContentSensitivity('u1')).resolves.toEqual({
        hideDating: false,
        hideMentalHealth: true,
        hideSexualityIdentity: false,
      });
    });
  });

  describe('updateContentSensitivity (PRD-10)', () => {
    it("replaces all three and leaves the row's other settings alone", async () => {
      repo.findOne.mockResolvedValue(
        row({ publicProfileEnabled: true, hideDatingContent: true }),
      );

      const result = await service.updateContentSensitivity('u1', {
        hideDating: false,
        hideMentalHealth: true,
        hideSexualityIdentity: true,
      });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          hideDatingContent: false,
          hideMentalHealthContent: true,
          hideSexualityIdentityContent: true,
          // The endpoints share one row, so a content filter must never
          // clobber the switch that publishes to the open web.
          publicProfileEnabled: true,
        }),
      );
      expect(result).toEqual({
        hideDating: false,
        hideMentalHealth: true,
        hideSexualityIdentity: true,
      });
    });

    // A member who has never opened settings has no row; writing one must not
    // drag every other setting to a value they never chose.
    it('starts from the documented defaults when no row exists', async () => {
      repo.findOne.mockResolvedValue(null);

      await service.updateContentSensitivity('u1', {
        hideDating: true,
        hideMentalHealth: false,
        hideSexualityIdentity: false,
      });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          hideDatingContent: true,
          hideMentalHealthContent: false,
          hideSexualityIdentityContent: false,
          hideFromSuggestions: false,
          loginAlertsEnabled: true,
        }),
      );
    });
  });

  describe('suggestion visibility (PRD-16)', () => {
    // Recommendable unless the member says otherwise: the strip only ever
    // surfaces people the member directory would already list.
    it('defaults to recommendable when no row exists', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.getSuggestionVisibility('u1')).resolves.toEqual({
        hideFromSuggestions: false,
      });
    });

    it('persists the opt-out and echoes the stored value', async () => {
      repo.findOne.mockResolvedValue(row({ hideFromSuggestions: false }));

      const result = await service.updateSuggestionVisibility('u1', {
        hideFromSuggestions: true,
      });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ hideFromSuggestions: true }),
      );
      expect(result).toEqual({ hideFromSuggestions: true });
    });

    // Opting back in is an ordinary write with no gate: nothing is being
    // published, so there is no eligibility question to ask.
    it('lets a member opt back in without any eligibility check', async () => {
      repo.findOne.mockResolvedValue(row({ hideFromSuggestions: true }));

      const result = await service.updateSuggestionVisibility('u1', {
        hideFromSuggestions: false,
      });

      expect(eligibility.assertMayGoPublic).not.toHaveBeenCalled();
      expect(result).toEqual({ hideFromSuggestions: false });
    });
  });

  describe('interface language (PRD-325)', () => {
    // `null` means the member has never told the server, which the app reads
    // as "write this device's language up".
    it('is null when no row exists, and the read writes nothing', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.getLanguagePreference('u1')).resolves.toEqual({
        language: null,
      });
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('is null on an existing row that never stored one', async () => {
      repo.findOne.mockResolvedValue(row({ language: null }));

      await expect(service.getLanguagePreference('u1')).resolves.toEqual({
        language: null,
      });
    });

    it('returns the stored language', async () => {
      repo.findOne.mockResolvedValue(row({ language: 'pt' }));

      await expect(service.getLanguagePreference('u1')).resolves.toEqual({
        language: 'pt',
      });
    });

    it("merges onto the existing row and leaves the row's other settings alone", async () => {
      repo.findOne.mockResolvedValue(
        row({ language: 'en', publicProfileEnabled: true, safeOnly: false }),
      );

      const result = await service.updateLanguagePreference('u1', {
        language: 'pt',
      });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          language: 'pt',
          publicProfileEnabled: true,
          safeOnly: false,
          outAtWork: OutAtWork.Out,
          transSupport: ['chosen-name'],
        }),
      );
      expect(result).toEqual({ language: 'pt' });
    });

    it('starts from the documented defaults when no row exists', async () => {
      repo.findOne.mockResolvedValue(null);

      await service.updateLanguagePreference('u1', { language: 'pt' });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          language: 'pt',
          publicProfileEnabled: false,
          hidePushPreviews: true,
          loginAlertsEnabled: true,
        }),
      );
    });
  });

  describe('Studio playback (open demo pages)', () => {
    it('answers the player defaults without writing a row', async () => {
      repo.findOne.mockResolvedValue(null);

      expect(await service.getStudioPlayback('u1')).toEqual({
        autoplayNext: true,
        hideExplicit: false,
        crossfadeSeconds: 0,
        askBeforeWarnings: true,
        isListeningHistoryOn: true,
        listeningNoticeSeenAt: null,
      });
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('reads history on and no notice for a member who never saved a setting', async () => {
      repo.findOne.mockResolvedValue(null);

      expect(await service.getStudioPlayback('u1')).toEqual(
        expect.objectContaining({
          isListeningHistoryOn: true,
          listeningNoticeSeenAt: null,
        }),
      );
    });

    it('pauses history and keeps the other settings', async () => {
      repo.findOne.mockResolvedValue(
        row({
          studioAutoplayNext: false,
          studioCrossfadeSeconds: 5,
          isListeningHistoryOn: true,
          listeningNoticeSeenAt: null,
        }),
      );

      const result = await service.updateStudioPlayback('u1', {
        isListeningHistoryOn: false,
      });

      expect(result).toEqual(
        expect.objectContaining({
          autoplayNext: false,
          crossfadeSeconds: 5,
          isListeningHistoryOn: false,
          listeningNoticeSeenAt: null,
        }),
      );
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          isListeningHistoryOn: false,
          studioCrossfadeSeconds: 5,
        }),
      );
    });

    it('stamps the notice once and keeps the first stamp', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-27T10:00:00.000Z'));
      try {
        const storedRow = row({
          isListeningHistoryOn: true,
          listeningNoticeSeenAt: null,
        });
        repo.findOne.mockResolvedValue(storedRow);

        const first = await service.updateStudioPlayback('u1', {
          hasSeenListeningNotice: true,
        });
        expect(first.listeningNoticeSeenAt).toBe('2026-10-27T10:00:00.000Z');

        // The saved row now carries the stamp; a later call at 11:00 answers
        // the 10:00 stamp.
        jest.setSystemTime(new Date('2026-10-27T11:00:00.000Z'));
        const second = await service.updateStudioPlayback('u1', {
          hasSeenListeningNotice: true,
        });
        expect(second.listeningNoticeSeenAt).toBe('2026-10-27T10:00:00.000Z');
      } finally {
        jest.useRealTimers();
      }
    });

    it('reads the stored settings', async () => {
      repo.findOne.mockResolvedValue(
        row({
          studioAutoplayNext: false,
          studioHideExplicit: true,
          studioCrossfadeSeconds: 6,
          isListeningHistoryOn: true,
          listeningNoticeSeenAt: null,
        }),
      );

      expect(await service.getStudioPlayback('u1')).toEqual({
        autoplayNext: false,
        hideExplicit: true,
        crossfadeSeconds: 6,
        isListeningHistoryOn: true,
        listeningNoticeSeenAt: null,
      });
    });

    it('changes only the fields the body names and keeps the rest of the row', async () => {
      repo.findOne.mockResolvedValue(
        row({
          studioAutoplayNext: false,
          studioHideExplicit: true,
          studioCrossfadeSeconds: 4,
          isListeningHistoryOn: true,
          listeningNoticeSeenAt: null,
        }),
      );

      const result = await service.updateStudioPlayback('u1', {
        crossfadeSeconds: 8,
      });

      expect(result).toEqual({
        autoplayNext: false,
        hideExplicit: true,
        crossfadeSeconds: 8,
        isListeningHistoryOn: true,
        listeningNoticeSeenAt: null,
      });
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          studioCrossfadeSeconds: 8,
          publicProfileEnabled: true,
          safeOnly: false,
          outAtWork: OutAtWork.Out,
        }),
      );
    });

    it('starts a first save from the defaults', async () => {
      repo.findOne.mockResolvedValue(null);

      await service.updateStudioPlayback('u1', { hideExplicit: true });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          studioAutoplayNext: true,
          studioHideExplicit: true,
          studioCrossfadeSeconds: 0,
          publicProfileEnabled: false,
          hidePushPreviews: true,
        }),
      );
    });

    it('echoes the stored state for an empty body', async () => {
      repo.findOne.mockResolvedValue(
        row({
          studioAutoplayNext: true,
          studioHideExplicit: false,
          studioCrossfadeSeconds: 3,
          isListeningHistoryOn: true,
          listeningNoticeSeenAt: null,
        }),
      );

      expect(await service.updateStudioPlayback('u1', {})).toEqual({
        autoplayNext: true,
        hideExplicit: false,
        crossfadeSeconds: 3,
        isListeningHistoryOn: true,
        listeningNoticeSeenAt: null,
      });
    });

    // Studio safety and moderation.
    it('reads and changes the ask-first switch alone', async () => {
      repo.findOne.mockResolvedValue(
        row({
          studioAutoplayNext: true,
          studioHideExplicit: false,
          studioCrossfadeSeconds: 2,
          studioAskBeforeWarnings: true,
          isListeningHistoryOn: true,
          listeningNoticeSeenAt: null,
        }),
      );

      const result = await service.updateStudioPlayback('u1', {
        askBeforeWarnings: false,
      });

      expect(result).toEqual({
        autoplayNext: true,
        hideExplicit: false,
        crossfadeSeconds: 2,
        askBeforeWarnings: false,
        isListeningHistoryOn: true,
        listeningNoticeSeenAt: null,
      });
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          studioAskBeforeWarnings: false,
          studioCrossfadeSeconds: 2,
        }),
      );
    });

    it('starts a first save with the ask-first switch on', async () => {
      repo.findOne.mockResolvedValue(null);

      await service.updateStudioPlayback('u1', { hideExplicit: true });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ studioAskBeforeWarnings: true }),
      );
    });
  });

  describe('Studio welcome (once per account)', () => {
    it('answers the defaults without writing a row', async () => {
      repo.findOne.mockResolvedValue(null);

      expect(await service.getStudioWelcome('u1')).toEqual({
        hasSeenWelcome: false,
        welcomeSeenAt: null,
        genres: [],
        moods: [],
      });
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('reads the stored stamp and picks', async () => {
      repo.findOne.mockResolvedValue(
        row({
          studioWelcomeSeenAt: new Date('2026-10-27T10:00:00.000Z'),
          studioTasteGenres: ['fado', 'jazz'],
          studioTasteMoods: ['tender'],
        }),
      );

      expect(await service.getStudioWelcome('u1')).toEqual({
        hasSeenWelcome: true,
        welcomeSeenAt: '2026-10-27T10:00:00.000Z',
        genres: ['fado', 'jazz'],
        moods: ['tender'],
      });
    });

    it('replaces only the lists the body names and keeps the rest of the row', async () => {
      repo.findOne.mockResolvedValue(
        row({
          studioWelcomeSeenAt: null,
          studioTasteGenres: ['fado'],
          studioTasteMoods: ['calm'],
        }),
      );

      const result = await service.updateStudioWelcome('u1', {
        genres: ['pop', 'rock'],
      });

      expect(result).toEqual({
        hasSeenWelcome: false,
        welcomeSeenAt: null,
        genres: ['pop', 'rock'],
        moods: ['calm'],
      });
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          studioTasteGenres: ['pop', 'rock'],
          studioTasteMoods: ['calm'],
          publicProfileEnabled: true,
        }),
      );
    });

    it('clears a list when the body sends an empty one', async () => {
      repo.findOne.mockResolvedValue(
        row({ studioTasteGenres: ['fado'], studioTasteMoods: ['calm'] }),
      );

      const result = await service.updateStudioWelcome('u1', { moods: [] });

      expect(result.moods).toEqual([]);
      expect(result.genres).toEqual(['fado']);
    });

    it('stamps the welcome once and keeps the first stamp', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-27T10:00:00.000Z'));
      try {
        repo.findOne.mockResolvedValue(row({ studioWelcomeSeenAt: null }));

        const first = await service.updateStudioWelcome('u1', {
          hasSeenWelcome: true,
        });
        expect(first.welcomeSeenAt).toBe('2026-10-27T10:00:00.000Z');
        expect(first.hasSeenWelcome).toBe(true);

        jest.setSystemTime(new Date('2026-10-27T11:00:00.000Z'));
        const second = await service.updateStudioWelcome('u1', {
          hasSeenWelcome: true,
        });
        expect(second.welcomeSeenAt).toBe('2026-10-27T10:00:00.000Z');
      } finally {
        jest.useRealTimers();
      }
    });

    it('starts a first save from the defaults', async () => {
      repo.findOne.mockResolvedValue(null);

      await service.updateStudioWelcome('u1', { moods: ['calm'] });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          studioWelcomeSeenAt: null,
          studioTasteGenres: [],
          studioTasteMoods: ['calm'],
          publicProfileEnabled: false,
        }),
      );
    });

    it('echoes the stored state for an empty body', async () => {
      repo.findOne.mockResolvedValue(
        row({
          studioWelcomeSeenAt: null,
          studioTasteGenres: ['jazz'],
          studioTasteMoods: [],
        }),
      );

      expect(await service.updateStudioWelcome('u1', {})).toEqual({
        hasSeenWelcome: false,
        welcomeSeenAt: null,
        genres: ['jazz'],
        moods: [],
      });
    });
  });
});
