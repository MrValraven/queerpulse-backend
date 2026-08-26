import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RecognitionService } from './recognition.service';
import { RecognitionAwardingService } from './recognition-awarding.service';
import { SetBadgeVisibilityDto } from './dto/set-badge-visibility.dto';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/**
 * `/me/recognition` — the caller's own level, badges and perks (spec §3 Tier 2
 * "recognition"). Frontend contract:
 * `queerpulse/src/features/members/api/recognition.api.ts`.
 *
 * This controller was GET-only until SUS-04, which is why
 * `recognition_perk_claims` could never be written and the perks page had no
 * honest "claimed" state to show. It now also carries the perk claim and the
 * per-badge visibility switch.
 */
@ApiTags('Recognition')
@ApiCookieAuth('access_token')
@Controller('me/recognition')
@UseGuards(ActiveMemberGuard)
export class MyRecognitionController {
  private readonly logger = new Logger(MyRecognitionController.name);

  constructor(
    private readonly recognitionService: RecognitionService,
    private readonly awarding: RecognitionAwardingService,
  ) {}

  @ApiOperation({ summary: "Get the caller's level, badges, and perks" })
  @ApiOkResponse({
    description: "The caller's recognition, including private perk state.",
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @Get()
  async getMine(
    @CurrentUser() user: CurrentUserData,
    // Bypasses the 5-min recompute throttle. Used sparingly by the frontend
    // (the Getting Started checklist) where several XP-earning actions can
    // land within minutes and a stale read would look like a bug.
    @Query('force') force?: string,
  ) {
    // Recompute (throttled to once / 5 min inside the service, unless
    // `force`) so the read reflects fresh XP/badges and fires level-up /
    // badge notifications. Best-effort: a recompute failure must not blank
    // the recognition page, but the failure is still logged so it isn't
    // invisible in production.
    try {
      await this.awarding.recompute(user, { force: force === 'true' });
    } catch (error) {
      this.logger.warn(
        `recompute failed for user ${user.userId}: ${String(error)}`,
      );
    }
    return this.recognitionService.getForUser(user.userId, true);
  }

  /**
   * Claim a perk the caller's level has unlocked. The level is recomputed
   * server-side from stored XP inside `claimPerk`; nothing the client sends
   * influences it.
   *
   * A best-effort `recompute()` runs first (throttled, exactly like the GET
   * above) so a member who just crossed the threshold can claim without
   * waiting for the next page read to materialize their new XP.
   *
   * Idempotent: claiming twice returns the FIRST claim, with a 200 rather than
   * a 201, because the second call created nothing.
   */
  @ApiOperation({ summary: 'Claim an unlocked perk.' })
  @ApiOkResponse({
    description:
      'The claim (existing one if already claimed) plus the rebuilt perks block.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member, or has not reached the perk level (code PERK_LEVEL_NOT_REACHED).',
  })
  @ApiNotFoundResponse({ description: 'No perk with that key.' })
  @Post('perks/:key/claim')
  @HttpCode(200)
  async claimPerk(
    @CurrentUser() user: CurrentUserData,
    @Param('key') key: string,
  ) {
    try {
      await this.awarding.recompute(user);
    } catch (error) {
      this.logger.warn(
        `recompute before claim failed for user ${user.userId}: ${String(error)}`,
      );
    }
    return this.recognitionService.claimPerk(user.userId, key);
  }

  /**
   * Hide one earned badge from how other members see the caller, or show it
   * again. Honoured on the read path: `GET /profiles/:slug/recognition` omits
   * a hidden badge, while the caller's own `GET /me/recognition` still returns
   * it, flagged `hiddenFromProfile`.
   */
  @ApiOperation({ summary: "Hide or show one of the caller's earned badges." })
  @ApiOkResponse({ description: 'The badge key and its new visibility.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @ApiNotFoundResponse({
    description: 'No badge with that key, or the caller has not earned it.',
  })
  @Patch('badges/:key/visibility')
  setBadgeVisibility(
    @CurrentUser() user: CurrentUserData,
    @Param('key') key: string,
    @Body() dto: SetBadgeVisibilityDto,
  ) {
    return this.recognitionService.setBadgeVisibility(
      user.userId,
      key,
      dto.hiddenFromProfile,
    );
  }
}

/**
 * `GET /profiles/:slug/recognition` — another member's recognition, resolved
 * by slug. Declared as its own controller (rather than editing
 * `src/profiles/profiles.controller.ts`, which this task must not touch) —
 * NestJS merges routes from multiple controllers sharing the `profiles`
 * prefix across modules, the same way `ProfilesController`/`MembersController`
 * already coexist.
 */
@ApiTags('Recognition')
@ApiCookieAuth('access_token')
@Controller('profiles')
@UseGuards(ActiveMemberGuard)
export class MemberRecognitionController {
  constructor(private readonly recognitionService: RecognitionService) {}

  @ApiOperation({ summary: "Get another member's recognition by slug" })
  @ApiOkResponse({
    description:
      "The member's recognition (perk state omitted for non-owners).",
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @ApiNotFoundResponse({ description: 'No profile with that slug.' })
  @Get(':slug/recognition')
  getForMember(
    @Param('slug') slug: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.recognitionService.getBySlug(slug, user.userId, user.role);
  }
}
