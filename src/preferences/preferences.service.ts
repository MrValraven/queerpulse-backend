import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { PublicEligibilityService } from '../public-eligibility/public-eligibility.service';
import { UpdatePublicProfileDto } from './dto/update-public-profile.dto';
import { UpdateWorkPreferencesDto } from './dto/update-work-preferences.dto';
import { UpdateLoginAlertsDto } from './dto/update-login-alerts.dto';
import { UpdatePushPreviewsDto } from './dto/update-push-previews.dto';
import { UpdateContentSensitivityDto } from './dto/update-content-sensitivity.dto';
import { UpdateSuggestionVisibilityDto } from './dto/update-suggestion-visibility.dto';
import { UpdateMessagingPrivacyDto } from './dto/update-messaging-privacy.dto';
import { UpdateGroupAddPolicyDto } from './dto/update-group-add-policy.dto';
import {
  DEFAULT_GROUP_ADD_POLICY,
  GroupAddPolicy,
  DEFAULT_HIDE_DATING_CONTENT,
  DEFAULT_HIDE_FROM_SUGGESTIONS,
  DEFAULT_HIDE_MENTAL_HEALTH_CONTENT,
  DEFAULT_HIDE_PUSH_PREVIEWS,
  DEFAULT_HIDE_SEXUALITY_IDENTITY_CONTENT,
  DEFAULT_LOGIN_ALERTS_ENABLED,
  DEFAULT_OUT_AT_WORK,
  DEFAULT_PUBLIC_PROFILE_ENABLED,
  DEFAULT_SAFE_ONLY,
  DEFAULT_SHARE_PRESENCE,
  DEFAULT_SHARE_READ_RECEIPTS,
  DEFAULT_SHARE_TYPING,
  MemberPreferences,
} from './entities/member-preferences.entity';
import { DEFAULT_WHO_CAN_MESSAGE } from './who-can-message';
import {
  MESSAGING_PRIVACY_SHARE_PRESENCE_CHANGED,
  MessagingPrivacySharePresenceChangedEvent,
} from './preferences.events';
import {
  ContentSensitivityDTO,
  GroupAddPolicyDTO,
  LoginAlertsDTO,
  MessagingPrivacyDTO,
  PublicProfileDTO,
  PushPreviewsDTO,
  WorkPreferencesDTO,
  SuggestionVisibilityDTO,
  toContentSensitivityDTO,
  toGroupAddPolicyDTO,
  toLoginAlertsDTO,
  toMessagingPrivacyDTO,
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
    private readonly eventEmitter: EventEmitter2,
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
    row.groupAddPolicy = DEFAULT_GROUP_ADD_POLICY;
    row.shareReadReceipts = DEFAULT_SHARE_READ_RECEIPTS;
    row.shareTyping = DEFAULT_SHARE_TYPING;
    row.sharePresence = DEFAULT_SHARE_PRESENCE;
    row.whoCanMessage = DEFAULT_WHO_CAN_MESSAGE;
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

  // --- Group add consent (PRD-353) -------------------------------------------

  async getGroupAddPolicy(userId: string): Promise<GroupAddPolicyDTO> {
    return toGroupAddPolicyDTO(await this.loadOrDefault(userId));
  }

  /**
   * Choose who may put this member straight into a group (PRD-353).
   *
   * Merged onto `loadOrDefault` like every other writer here. Read by
   * `GroupsService`'s seat-or-invite gate (`addMembers`/`createGroup`), via
   * the batched `getGroupAddPolicyForUsers` below, never one query per
   * candidate. `connections` (the default) keeps today's behaviour; switching
   * to `invite_only` never re-seats an add already committed under
   * `connections`, it only changes what a FUTURE add does.
   */
  async updateGroupAddPolicy(
    userId: string,
    dto: UpdateGroupAddPolicyDto,
  ): Promise<GroupAddPolicyDTO> {
    const row = await this.loadOrDefault(userId);
    row.groupAddPolicy = dto.policy;

    return toGroupAddPolicyDTO(await this.preferences.save(row));
  }

  /**
   * Batched variant of `getGroupAddPolicy`, for `GroupsService`'s
   * `addMembers`/`createGroup` seat-or-invite gate: mirrors
   * `getMessagingPrivacyForUsers`'s shape exactly (one query for the whole
   * candidate batch, a user id absent from the query result reads as the
   * synthesised default, same as `loadOrDefault` would one at a time).
   */
  async getGroupAddPolicyForUsers(
    userIds: string[],
  ): Promise<Map<string, GroupAddPolicy>> {
    const uniqueUserIds = [...new Set(userIds)];
    if (!uniqueUserIds.length) {
      return new Map();
    }
    const rows = await this.preferences.find({
      where: { userId: In(uniqueUserIds) },
      select: { userId: true, groupAddPolicy: true },
    });
    const byUser = new Map(rows.map((row) => [row.userId, row.groupAddPolicy]));
    const result = new Map<string, GroupAddPolicy>();
    for (const userId of uniqueUserIds) {
      result.set(userId, byUser.get(userId) ?? DEFAULT_GROUP_ADD_POLICY);
    }
    return result;
  }

  // --- Messaging privacy (PRD-364/PRD-366) -----------------------------------

  async getMessagingPrivacy(userId: string): Promise<MessagingPrivacyDTO> {
    return toMessagingPrivacyDTO(await this.loadOrDefault(userId));
  }

  /**
   * Batched variant of `getMessagingPrivacy`, for `ChatGateway` (presence/
   * typing/read-relay gating) and `MessagingCoreService.buildMemberSummaries`
   * (group "Seen by" gating), neither of which may cost one query per
   * participant. A `userId` with no row is absent from the query result and
   * gets the synthesised default here, exactly as `loadOrDefault` would one
   * at a time — a member who never opened Settings shares everything, same as
   * every other preference on this entity.
   */
  async getMessagingPrivacyForUsers(
    userIds: string[],
  ): Promise<Map<string, MessagingPrivacyDTO>> {
    const uniqueUserIds = [...new Set(userIds)];
    if (!uniqueUserIds.length) {
      return new Map();
    }
    const rows = await this.preferences.find({
      where: { userId: In(uniqueUserIds) },
    });
    const byUser = new Map(rows.map((row) => [row.userId, row]));
    const result = new Map<string, MessagingPrivacyDTO>();
    for (const userId of uniqueUserIds) {
      const row = byUser.get(userId) ?? this.defaults(userId);
      result.set(userId, toMessagingPrivacyDTO(row));
    }
    return result;
  }

  /**
   * Partial update (unlike every full-replace writer above): the pane fires
   * one PUT per toggle/choice the instant it changes, so a field ABSENT from
   * the body is left untouched rather than reset to its default. Merged onto
   * `loadOrDefault` like every other writer here.
   *
   * Emits `MESSAGING_PRIVACY_SHARE_PRESENCE_CHANGED` only when `sharePresence`
   * is present in the body AND actually differs from the stored value — never
   * on a resend of the same value, and never for the other three fields, which
   * need no live gateway reaction (see the event's own doc).
   */
  async updateMessagingPrivacy(
    userId: string,
    dto: UpdateMessagingPrivacyDto,
  ): Promise<MessagingPrivacyDTO> {
    const row = await this.loadOrDefault(userId);
    const sharePresenceChanged =
      dto.sharePresence !== undefined &&
      dto.sharePresence !== row.sharePresence;
    if (dto.shareReadReceipts !== undefined) {
      row.shareReadReceipts = dto.shareReadReceipts;
    }
    if (dto.shareTyping !== undefined) {
      row.shareTyping = dto.shareTyping;
    }
    if (dto.sharePresence !== undefined) {
      row.sharePresence = dto.sharePresence;
    }
    if (dto.whoCanMessage !== undefined) {
      row.whoCanMessage = dto.whoCanMessage;
    }

    const saved = await this.preferences.save(row);
    if (sharePresenceChanged) {
      this.eventEmitter.emit(MESSAGING_PRIVACY_SHARE_PRESENCE_CHANGED, {
        userId,
        sharePresence: saved.sharePresence,
      } satisfies MessagingPrivacySharePresenceChangedEvent);
    }
    return toMessagingPrivacyDTO(saved);
  }
}
