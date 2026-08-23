import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { CommunityPreferencesService } from './community-preferences.service';
import { AcceptCommunityRulesDto } from './dto/accept-community-rules.dto';
import { UpdateCommunityPreferencesDto } from './dto/update-community-preferences.dto';

/**
 * `@Controller('communities/:slug')` holding only the caller's OWN
 * per-community settings. A standalone controller rather than three more
 * methods on `CommunitiesController`, following the precedent
 * `CommunityPulseController` and `CommunityInsightsController` set in this
 * module: Nest lets a controller's path be any literal string regardless of
 * which other controller owns the resource above it in the URL, so a feature
 * can add routes under `communities/:slug` without touching that file at all.
 *
 * Every route here is first-person: the member reads and writes their own
 * notification level, stamps their own welcome, and records their own reading
 * of the house rules. The service takes the acting user from the session on
 * every one of them, so there is no route shape that could address another
 * member's row.
 */
@Feature('communities')
@ApiTags('Communities')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('communities/:slug')
@UseGuards(ActiveMemberGuard)
export class CommunityPreferencesController {
  constructor(
    private readonly communityPreferencesService: CommunityPreferencesService,
  ) {}

  @Get('preferences')
  @ApiOperation({
    summary:
      "The caller's own notification level for this community, plus whether they still need to see its welcome message.",
  })
  @ApiOkResponse({ description: "The caller's own community preferences." })
  @ApiForbiddenResponse({ description: 'Only roster members can do that.' })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or an archived community.',
  })
  getPreferences(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.communityPreferencesService.getPreferences(slug, user.userId);
  }

  @Patch('preferences')
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      "Set the caller's own notification level for this community (all, announcements, mentions or muted).",
  })
  @ApiOkResponse({ description: 'The updated preferences.' })
  @ApiForbiddenResponse({ description: 'Only roster members can do that.' })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or an archived community.',
  })
  updatePreferences(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: UpdateCommunityPreferencesDto,
  ) {
    return this.communityPreferencesService.updatePreferences(
      slug,
      user.userId,
      dto.notificationLevel,
    );
  }

  @Post('welcome-seen')
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      "Record that the caller has seen this community's welcome message, so it stops showing.",
  })
  @ApiOkResponse({
    description: 'The preferences, now with shouldShowWelcome false.',
  })
  @ApiForbiddenResponse({ description: 'Only roster members can do that.' })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or an archived community.',
  })
  markWelcomeSeen(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.communityPreferencesService.markWelcomeSeen(slug, user.userId);
  }

  @Post('rules-acceptance')
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      "Record that the caller has read this community's house rules at the given version.",
    description:
      'For an EXISTING member re-accepting after an owner edited the rules. ' +
      'A joining member accepts through `POST /communities/:slug/join` ' +
      'instead, which stamps the same two columns.',
  })
  @ApiOkResponse({
    description: 'The preferences, now with shouldReacceptRules false.',
  })
  @ApiBadRequestResponse({
    description:
      "The submitted version is behind the community's current one, so the " +
      'rules changed again mid-read. The body carries code ' +
      '`RULES_ACCEPTANCE_REQUIRED` and the current `rulesVersion`.',
  })
  @ApiForbiddenResponse({ description: 'Only roster members can do that.' })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or an archived community.',
  })
  acceptRules(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: AcceptCommunityRulesDto,
  ) {
    return this.communityPreferencesService.acceptRules(
      slug,
      user.userId,
      dto.acceptedRulesVersion,
    );
  }
}
