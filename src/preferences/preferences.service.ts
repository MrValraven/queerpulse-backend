import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { PublicEligibilityService } from '../public-eligibility/public-eligibility.service';
import { UpdatePublicProfileDto } from './dto/update-public-profile.dto';
import { UpdateWorkPreferencesDto } from './dto/update-work-preferences.dto';
import { UpdateLoginAlertsDto } from './dto/update-login-alerts.dto';
import { UpdatePushPreviewsDto } from './dto/update-push-previews.dto';
import { UpdateContentSensitivityDto } from './dto/update-content-sensitivity.dto';
import { UpdateSuggestionVisibilityDto } from './dto/update-suggestion-visibility.dto';
import {
  DEFAULT_HIDE_DATING_CONTENT,
  DEFAULT_HIDE_FROM_SUGGESTIONS,
  DEFAULT_HIDE_MENTAL_HEALTH_CONTENT,
  DEFAULT_HIDE_PUSH_PREVIEWS,
  DEFAULT_HIDE_SEXUALITY_IDENTITY_CONTENT,
  DEFAULT_LOGIN_ALERTS_ENABLED,
  DEFAULT_OUT_AT_WORK,
  DEFAULT_PUBLIC_PROFILE_ENABLED,
  DEFAULT_SAFE_ONLY,
  MemberPreferences,
} from './entities/member-preferences.entity';
import {
  ContentSensitivityDTO,
  LoginAlertsDTO,
  PublicProfileDTO,
  PushPreviewsDTO,
  WorkPreferencesDTO,
  SuggestionVisibilityDTO,
  toContentSensitivityDTO,
  toLoginAlertsDTO,
  toPublicProfileDTO,
  toPushPreviewsDTO,
  toSuggestionVisibilityDTO,
  toWorkPreferencesDTO,
} from './preferences-response';
import { normalizeTransSupport } from './trans-support';
import { normalizeWorkSkills } from './work-skills';
import { normalizeFocusAreas } from './focus-areas';

@Injectable()
export class PreferencesService {
  constructor(
    @InjectRepository(MemberPreferences)
    private readonly preferences: Repository<MemberPreferences>,
    private readonly publicEligibility: PublicEligibilityService,
  ) {}

  // The unsaved shape a member who has never opened either settings page gets.
  // Reads NEVER persist this — a GET must not create rows, or every member who
  // merely loads the app acquires a preferences row. Defaults are duplicated in
  // the column definitions so a row inserted by the other endpoint gets the
  // same values.
  private defaults(userId: string): MemberPreferences {
    const row = new MemberPreferences();
    row.userId = userId;
    row.outAtWork = DEFAULT_OUT_AT_WORK;
    row.transSupport = [];
    row.safeOnly = DEFAULT_SAFE_ONLY;
    row.skills = [];
    row.focusAreas = [];
    row.publicProfileEnabled = DEFAULT_PUBLIC_PROFILE_ENABLED;
    row.loginAlertsEnabled = DEFAULT_LOGIN_ALERTS_ENABLED;
    row.hidePushPreviews = DEFAULT_HIDE_PUSH_PREVIEWS;
    row.hideDatingContent = DEFAULT_HIDE_DATING_CONTENT;
    row.hideMentalHealthContent = DEFAULT_HIDE_MENTAL_HEALTH_CONTENT;
    row.hideSexualityIdentityContent = DEFAULT_HIDE_SEXUALITY_IDENTITY_CONTENT;
    row.hideFromSuggestions = DEFAULT_HIDE_FROM_SUGGESTIONS;
    return row;
  }

  // Returns the stored row, or a synthesised default one. Deliberately not a
  // 404: "I have never touched this setting" is a coherent state with a correct
  // answer, and a safety form that errors on first open teaches members that
  // the feature is broken.
  private async loadOrDefault(userId: string): Promise<MemberPreferences> {
    const existing = await this.preferences.findOne({ where: { userId } });
    return existing ?? this.defaults(userId);
  }

  async getWorkPreferences(userId: string): Promise<WorkPreferencesDTO> {
    return toWorkPreferencesDTO(await this.loadOrDefault(userId));
  }

  // Full replace of the three work settings. Merging onto `loadOrDefault`
  // rather than inserting a bare row keeps `publicProfileEnabled` untouched —
  // the two endpoints share a row and must never clobber each other.
  async updateWorkPreferences(
    userId: string,
    dto: UpdateWorkPreferencesDto,
  ): Promise<WorkPreferencesDTO> {
    const row = await this.loadOrDefault(userId);
    row.outAtWork = dto.outAtWork;
    row.transSupport = normalizeTransSupport(dto.transSupport);
    row.safeOnly = dto.safeOnly;
    row.skills = normalizeWorkSkills(dto.skills);
    row.focusAreas = normalizeFocusAreas(dto.focusAreas);

    return toWorkPreferencesDTO(await this.preferences.save(row));
  }

  async getPublicProfile(userId: string): Promise<PublicProfileDTO> {
    return toPublicProfileDTO(await this.loadOrDefault(userId));
  }

  // ⚠️ THIS PUBLISHES TO THE OPEN WEB. `publicProfileEnabled` stopped being
  // inert when `GET /public/profiles/:slug` landed: it is the gate on that
  // unauthenticated route (`PublicProfilesService.getBySlug`). Setting it true
  // makes the member's name, pronouns, tagline, avatar, bio, links and work
  // readable by anyone with no account — provided their `users.status` is still
  // `active` AND their `profiles.visibility` is `open`, both of which that
  // service also requires.
  //
  // Setting it false un-publishes immediately: the public route holds no cache
  // and sends `Cache-Control: no-store`, so the next request 404s.
  //
  // THE GATE IS ASYMMETRIC, DELIBERATELY.
  //
  // Turning it ON runs `PublicEligibilityService.assertMayGoPublic`, which is
  // the single source of truth for the rule (verified, 90 days of tenure, 100
  // points, standing). It throws 403 with a coarse reason code. Until this
  // landed the switch was assigned straight from the DTO, so a member of one
  // day, or a stolen session, could publish to the open internet with one API
  // call while the whole rule sat in frontend JavaScript.
  //
  // Turning it OFF is ALWAYS allowed, and runs no check at all. A member who
  // has become ineligible, been suspended, or deactivated their account still
  // has to be able to un-publish. Making the safety direction conditional on
  // standing would take the control away at the exact moment it matters most.
  async updatePublicProfile(
    user: CurrentUserData,
    dto: UpdatePublicProfileDto,
  ): Promise<PublicProfileDTO> {
    if (dto.enabled) {
      await this.publicEligibility.assertMayGoPublic(user);
    }

    const row = await this.loadOrDefault(user.userId);
    row.publicProfileEnabled = dto.enabled;

    return toPublicProfileDTO(await this.preferences.save(row));
  }

  // --- Account security -----------------------------------------------------

  async getLoginAlerts(userId: string): Promise<LoginAlertsDTO> {
    return toLoginAlertsDTO(await this.loadOrDefault(userId));
  }

  /**
   * Turn the new-device sign-in alert on or off.
   *
   * Merged onto `loadOrDefault` like every other writer here, so flipping this
   * never clobbers `publicProfileEnabled` or the work settings sharing the row.
   *
   * This switch governs DELIVERY only. `AuthService.issueTokens` reads it
   * before emitting `SECURITY_NEW_SIGN_IN`, so switching it off writes no bell
   * row and sends no push — but the device label and the session itself are
   * still recorded, and `/account/sessions` still lists every device. A member
   * who wants quiet does not thereby lose the record.
   */
  async updateLoginAlerts(
    userId: string,
    dto: UpdateLoginAlertsDto,
  ): Promise<LoginAlertsDTO> {
    const row = await this.loadOrDefault(userId);
    row.loginAlertsEnabled = dto.enabled;

    return toLoginAlertsDTO(await this.preferences.save(row));
  }

  // --- Lock-screen privacy --------------------------------------------------

  async getPushPreviews(userId: string): Promise<PushPreviewsDTO> {
    return toPushPreviewsDTO(await this.loadOrDefault(userId));
  }

  /**
   * Hide or show what a push notification says on a lock screen.
   *
   * Merged onto `loadOrDefault` like every other writer here, so flipping this
   * never clobbers `publicProfileEnabled`, `loginAlertsEnabled` or the work
   * settings sharing the row.
   *
   * Unlike `updateLoginAlerts` this suppresses NOTHING. Every notification is
   * still written and still delivered; `PushPreviewPrivacyService` reads this
   * column on the send path and decides whether the payload may name a sender.
   * The app shows everything once it is open and unlocked.
   *
   * It applies to every device the member is signed in on, which is the whole
   * reason it lives here rather than in the browser: the version of this that
   * shipped first was an IndexedDB flag the service worker read, and iOS never
   * runs that code. See `DEFAULT_HIDE_PUSH_PREVIEWS`.
   */
  async updatePushPreviews(
    userId: string,
    dto: UpdatePushPreviewsDto,
  ): Promise<PushPreviewsDTO> {
    const row = await this.loadOrDefault(userId);
    row.hidePushPreviews = dto.hidePreviews;

    return toPushPreviewsDTO(await this.preferences.save(row));
  }

  // --- Content sensitivity --------------------------------------------------

  async getContentSensitivity(userId: string): Promise<ContentSensitivityDTO> {
    return toContentSensitivityDTO(await this.loadOrDefault(userId));
  }

  /**
   * Replace all three content-sensitivity filters (PRD-10).
   *
   * A full replace like `updateWorkPreferences`, for the same reason: the
   * Interests pane holds the whole triple and submits it whole, so a partial
   * body would leave one switch showing a value the member thought they had
   * just changed. Merged onto `loadOrDefault` like every other writer here, so
   * flipping a filter never clobbers `publicProfileEnabled`, the login alert
   * or the work settings sharing the row.
   *
   * These are the only settings on this entity that change what the member
   * SEES rather than what other people or their own lock screen see. They are
   * read on the feed path by `FeedService`, which resolves them into a set of
   * excluded tags through `src/feed/content-sensitivity.ts` and applies that
   * set in the candidate queries, so opted-out content is never fetched rather
   * than fetched and then dropped.
   *
   * The scope is the feed and nothing else. Community browse, search, the
   * member's own rooms and every direct link keep working exactly as before,
   * which is what the pane promises in so many words.
   */
  async updateContentSensitivity(
    userId: string,
    dto: UpdateContentSensitivityDto,
  ): Promise<ContentSensitivityDTO> {
    const row = await this.loadOrDefault(userId);
    row.hideDatingContent = dto.hideDating;
    row.hideMentalHealthContent = dto.hideMentalHealth;
    row.hideSexualityIdentityContent = dto.hideSexualityIdentity;

    return toContentSensitivityDTO(await this.preferences.save(row));
  }

  // --- Suggestion visibility ------------------------------------------------

  async getSuggestionVisibility(
    userId: string,
  ): Promise<SuggestionVisibilityDTO> {
    return toSuggestionVisibilityDTO(await this.loadOrDefault(userId));
  }

  /**
   * Stop, or resume, being recommended to strangers (PRD-16).
   *
   * Merged onto `loadOrDefault` like every other writer here. Read by
   * `MemberSuggestionsService.visibleCandidates` as a correlated `NOT EXISTS`
   * in the candidate query, so an opted-out member is excluded before scoring
   * rather than scored and then filtered: a member who asked not to be
   * recommended should never reach a code path that could leak them.
   *
   * ONE-DIRECTIONAL. Opting out never costs the member their own suggestions.
   * The switch sits on the Visibility pane, which is about what others see of
   * them, and withholding their own discovery in exchange would put a price on
   * a privacy choice. The receiving side has its own controls already:
   * per-person dismissal, and the 24-hour blackout on `profiles.hidden_until`.
   *
   * Both directions are always allowed. There is no eligibility gate here, in
   * contrast with `updatePublicProfile`, because nothing is being published:
   * this only ever narrows who the platform pushes the member at.
   */
  async updateSuggestionVisibility(
    userId: string,
    dto: UpdateSuggestionVisibilityDto,
  ): Promise<SuggestionVisibilityDTO> {
    const row = await this.loadOrDefault(userId);
    row.hideFromSuggestions = dto.hideFromSuggestions;

    return toSuggestionVisibilityDTO(await this.preferences.save(row));
  }
}
