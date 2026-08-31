import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { UpdateLoginAlertsDto } from './dto/update-login-alerts.dto';
import { UpdatePublicProfileDto } from './dto/update-public-profile.dto';
import { UpdatePushPreviewsDto } from './dto/update-push-previews.dto';
import { UpdateContentSensitivityDto } from './dto/update-content-sensitivity.dto';
import { UpdateSuggestionVisibilityDto } from './dto/update-suggestion-visibility.dto';
import { UpdateWorkPreferencesDto } from './dto/update-work-preferences.dto';
import { PreferencesService } from './preferences.service';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiOkResponse,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/**
 * Member safety + visibility switches. Mirrors the frontend contract exactly:
 * `GET|PUT /me/work-preferences`, `GET|PUT /me/public-profile`,
 * `GET|PUT /me/login-alerts`, `GET|PUT /me/push-previews`.
 *
 * ---------------------------------------------------------------------------
 * GUARDS: JWT only — deliberately NO ActiveMemberGuard
 * ---------------------------------------------------------------------------
 * Sibling `/me/*` routes (`src/saved/saved.controller.ts`) do add
 * `ActiveMemberGuard`, but those are member FEATURES: a deactivated account
 * losing its bookmarks list is correct.
 *
 * These are safety controls, and the asymmetry matters. `ActiveMemberGuard`
 * 403s anyone whose `users.status` is not `active`, which since
 * `AddDeactivatedStatus1782800710000` includes every deactivated member. Adding
 * it here would mean a member who deactivates can no longer turn their public
 * profile OFF, nor retract an outness disclosure — the exact moment those
 * controls matter most is the moment the guard would take them away. A setting
 * you can switch on but not off is a trap, and "I am stepping back from this
 * community" is a reason to grant more control over your disclosures, not less.
 *
 * So this follows the precedent `src/account/account.controller.ts` documents
 * for account lifecycle, consent and email preferences: authentication is
 * required (the global `JwtAuthGuard` covers that — these routes are not
 * `@Public()`), membership status is not. Reads and writes are treated the same
 * on purpose; a read-only exception would leave the member staring at a setting
 * they cannot change.
 */
@ApiTags('Preferences')
@ApiCookieAuth()
@Controller('me')
export class PreferencesController {
  constructor(private readonly preferencesService: PreferencesService) {}

  // Returns defaults (`verified` / `[]` / `true`) when no row exists yet rather
  // than 404 — see `PreferencesService.loadOrDefault`.
  @ApiOperation({ summary: "Get the member's work/collaboration preferences." })
  @ApiOkResponse({
    description: 'The work preferences (normalised defaults when none set).',
  })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @Get('work-preferences')
  getWorkPreferences(@CurrentUser() user: CurrentUserData) {
    return this.preferencesService.getWorkPreferences(user.userId);
  }

  // Full replace, echoing the persisted state back so the client renders what
  // was actually stored (normalised) rather than what it optimistically sent.
  @ApiOperation({
    summary: "Replace the member's work/collaboration preferences.",
  })
  @ApiOkResponse({ description: 'The persisted, normalised work preferences.' })
  @ApiBadRequestResponse({ description: 'Validation failed.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @Put('work-preferences')
  updateWorkPreferences(
    @CurrentUser() user: CurrentUserData,
    @Body() body: UpdateWorkPreferencesDto,
  ) {
    return this.preferencesService.updateWorkPreferences(user.userId, body);
  }

  // Defaults to `{ enabled: false }` when no row exists — off unless the member
  // has said otherwise.
  @ApiOperation({
    summary: "Get the member's public-profile visibility setting.",
  })
  @ApiOkResponse({
    description: 'The public-profile setting (defaults to off).',
  })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @Get('public-profile')
  getPublicProfile(@CurrentUser() user: CurrentUserData) {
    return this.preferencesService.getPublicProfile(user.userId);
  }

  // Takes the whole `CurrentUserData`, and the extra field earns its place:
  // `status` is what the eligibility gate reads to keep a suspended or
  // deactivated member from publishing to the open web. Passing `userId` alone
  // would leave the service unable to see it.
  //
  // `{ enabled: false }` is never gated. See the service's doc comment.
  @ApiOperation({
    summary: "Replace the member's public-profile visibility setting.",
  })
  @ApiOkResponse({ description: 'The persisted public-profile setting.' })
  @ApiBadRequestResponse({ description: 'Validation failed.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({
    description:
      'The member is not eligible to publish a public profile. Carries a coarse `reasonCode`. Only ever returned for `{ enabled: true }`.',
  })
  @Put('public-profile')
  updatePublicProfile(
    @CurrentUser() user: CurrentUserData,
    @Body() body: UpdatePublicProfileDto,
  ) {
    return this.preferencesService.updatePublicProfile(user, body);
  }

  // Defaults to `{ enabled: true }` when no row exists — a member who has never
  // opened settings is still told when a device they have not used before signs
  // in to their account. See `DEFAULT_LOGIN_ALERTS_ENABLED`.
  //
  // The controller-level note above applies with particular force here: this is
  // the security switch of a member who may have deactivated BECAUSE something
  // was wrong, so the JWT-only guard stance is what keeps it reachable.
  @ApiOperation({
    summary: "Get the member's new-device sign-in alert setting.",
  })
  @ApiOkResponse({ description: 'The sign-in alert setting (defaults to on).' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @Get('login-alerts')
  getLoginAlerts(@CurrentUser() user: CurrentUserData) {
    return this.preferencesService.getLoginAlerts(user.userId);
  }

  @ApiOperation({
    summary: "Replace the member's new-device sign-in alert setting.",
  })
  @ApiOkResponse({ description: 'The persisted sign-in alert setting.' })
  @ApiBadRequestResponse({ description: 'Validation failed.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @Put('login-alerts')
  updateLoginAlerts(
    @CurrentUser() user: CurrentUserData,
    @Body() body: UpdateLoginAlertsDto,
  ) {
    return this.preferencesService.updateLoginAlerts(user.userId, body);
  }

  // Defaults to `{ hidePreviews: true }` when no row exists, so a member who
  // has never opened settings gets a lock screen that says a notification
  // arrived and nothing else. See `DEFAULT_HIDE_PUSH_PREVIEWS` for why hidden
  // is the safe default rather than the cautious one.
  //
  // The app also mirrors this value into IndexedDB so the service worker can
  // degrade a payload on engines that run it, but THIS is the authority: iOS
  // never runs the worker's push handler, so the only place a sender's name can
  // be kept off an iPhone lock screen is the composer, which reads this column.
  @ApiOperation({
    summary: "Get the member's lock-screen notification-preview setting.",
  })
  @ApiOkResponse({
    description: 'The preview setting (defaults to hidden).',
  })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @Get('push-previews')
  getPushPreviews(@CurrentUser() user: CurrentUserData) {
    return this.preferencesService.getPushPreviews(user.userId);
  }

  @ApiOperation({
    summary: "Replace the member's lock-screen notification-preview setting.",
  })
  @ApiOkResponse({ description: 'The persisted preview setting.' })
  @ApiBadRequestResponse({ description: 'Validation failed.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @Put('push-previews')
  updatePushPreviews(
    @CurrentUser() user: CurrentUserData,
    @Body() body: UpdatePushPreviewsDto,
  ) {
    return this.preferencesService.updatePushPreviews(user.userId, body);
  }

  // Defaults to all three `false` when no row exists (PRD-10), so a member who
  // has never opened settings is shown the whole platform. This is the one
  // group here whose safe default is the permissive one: nothing escapes the
  // member's control when a content filter is off, and shipping it on would
  // subtract communities from the feed of everybody who never asked.
  //
  // Read on the feed path only. The pane's helper copy promises that turning
  // one off never affects community access, and `FeedService` is the single
  // place these are enforced, so the promise holds by construction.
  @ApiOperation({
    summary: "Get the member's content-sensitivity feed filters.",
  })
  @ApiOkResponse({
    description: 'The three filters (all off by default).',
  })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @Get('content-sensitivity')
  getContentSensitivity(@CurrentUser() user: CurrentUserData) {
    return this.preferencesService.getContentSensitivity(user.userId);
  }

  // Full replace of all three, echoing the persisted state back: the same
  // shape as `work-preferences`, and for the same reason (the pane submits the
  // whole triple).
  @ApiOperation({
    summary: "Replace the member's content-sensitivity feed filters.",
  })
  @ApiOkResponse({ description: 'The persisted filters.' })
  @ApiBadRequestResponse({ description: 'Validation failed.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @Put('content-sensitivity')
  updateContentSensitivity(
    @CurrentUser() user: CurrentUserData,
    @Body() body: UpdateContentSensitivityDto,
  ) {
    return this.preferencesService.updateContentSensitivity(user.userId, body);
  }

  // Defaults to `{ hideFromSuggestions: false }` when no row exists (PRD-16):
  // members are recommendable unless they say otherwise, since the suggestion
  // strip only ever surfaces people the member directory would already list.
  //
  // The controller-level guard note applies here too, and it matters: a member
  // who has deactivated must still be able to say "stop offering me to
  // strangers", which is exactly the moment `ActiveMemberGuard` would have
  // taken the switch away.
  @ApiOperation({
    summary: 'Get whether the member may be recommended to other members.',
  })
  @ApiOkResponse({
    description:
      'The suggestion-visibility setting (recommendable by default).',
  })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @Get('suggestion-visibility')
  getSuggestionVisibility(@CurrentUser() user: CurrentUserData) {
    return this.preferencesService.getSuggestionVisibility(user.userId);
  }

  @ApiOperation({
    summary: 'Replace whether the member may be recommended to other members.',
  })
  @ApiOkResponse({
    description: 'The persisted suggestion-visibility setting.',
  })
  @ApiBadRequestResponse({ description: 'Validation failed.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @Put('suggestion-visibility')
  updateSuggestionVisibility(
    @CurrentUser() user: CurrentUserData,
    @Body() body: UpdateSuggestionVisibilityDto,
  ) {
    return this.preferencesService.updateSuggestionVisibility(
      user.userId,
      body,
    );
  }
}
