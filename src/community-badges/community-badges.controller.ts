import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { CommunityBadgesService } from './community-badges.service';
import { CommunityGiftsService } from './community-gifts.service';
import {
  CreateCommunityBadgeDto,
  ListMyCommunityGiftsQuery,
  SendCommunityGiftDto,
  SetCommunityFlairDto,
  UpdateCommunityBadgeDto,
  UpdateCommunityGiftDto,
} from './dto/community-badges.dto';

/** The 404 every route shares for an unknown slug or a private outsider. */
const COMMUNITY_NOT_FOUND_DESCRIPTION =
  'Unknown slug, or a private community the caller is outside of (uncoded `Community not found`).';

/** The 404 every write shares: the read cases plus an archived community. */
const COMMUNITY_NOT_FOUND_ON_WRITE_DESCRIPTION =
  'Unknown slug, an archived community, or a private community the caller is outside of (uncoded `Community not found`).';

/** The 400 every route answers inside a space, after the access check passes. */
const SPACE_DESCRIPTION =
  '`SUBCOMMUNITY_FEATURE_UNAVAILABLE` in a space (spaces have no badges, gifts or flair).';

/**
 * `@Controller('communities/:slug')`: the twelve badge, flair and gift
 * routes of one community, served by a standalone controller nested under
 * the community path, the convention `CommunityGivingController` follows.
 *
 * Reads pass the post board gate or the route's role check inside the
 * services. Every write adds `NotRestrictedGuard` and the `20 per 60s`
 * per-route throttle the other community writes use; the global CSRF guard
 * applies as on every state-changing route. Every refusal carries its
 * contract code from `community-badges.constants.ts`.
 *
 * Literal paths (`badges/manage`, `gifts/allowance`, `gifts/mine`) are
 * declared above the parameterised routes of the same method.
 */
@Feature('communities')
@ApiTags('Communities')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('communities/:slug')
@UseGuards(ActiveMemberGuard)
export class CommunityBadgesController {
  constructor(
    private readonly badges: CommunityBadgesService,
    private readonly gifts: CommunityGiftsService,
  ) {}

  /** Route 1: the enabled badges, with progress for a member. */
  @Get('badges')
  @ApiOperation({
    summary:
      "A community's enabled badges; a member also gets progress, earned dates and the badge they wear.",
  })
  @ApiOkResponse({ description: 'The badges in display order.' })
  @ApiBadRequestResponse({ description: SPACE_DESCRIPTION })
  @ApiForbiddenResponse({
    description:
      '`COMMUNITY_MEMBERS_ONLY` for a non-member of a request or invite tier community.',
  })
  @ApiNotFoundResponse({ description: COMMUNITY_NOT_FOUND_DESCRIPTION })
  listBadges(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.badges.listForViewer(slug, user.userId);
  }

  /** Route 2: every badge with holder counts, for staff. */
  @Get('badges/manage')
  @ApiOperation({
    summary:
      'Every badge of the community with its holder count and the badge limit (staff).',
  })
  @ApiOkResponse({ description: 'The badges, enabled and disabled.' })
  @ApiBadRequestResponse({ description: SPACE_DESCRIPTION })
  @ApiForbiddenResponse({
    description:
      '`badge_settings_staff_only` for a plain member or a non-member.',
  })
  @ApiNotFoundResponse({ description: COMMUNITY_NOT_FOUND_DESCRIPTION })
  listBadgesForStaff(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.badges.listForStaff(slug, user.userId);
  }

  /** Route 3: create a badge (owner or co-owner). */
  @Post('badges')
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Create a badge (owner or co-owner). Requests a silent backfill and writes one governance log entry.',
  })
  @ApiCreatedResponse({
    description: 'The created badge with its holder count.',
  })
  @ApiBadRequestResponse({
    description: `\`badge_name_required\`, \`badge_name_too_long\`, \`badge_icon_unknown\`, \`badge_tint_unknown\`, \`badge_rule_unknown\`, \`badge_threshold_out_of_range\` or \`badge_enabled_invalid\` (first failure wins); ${SPACE_DESCRIPTION}`,
  })
  @ApiForbiddenResponse({
    description:
      '`badge_manage_owner_only` for a moderator, a plain member or a non-member; `ACCOUNT_RESTRICTED` for a restricted account.',
  })
  @ApiConflictResponse({
    description: '`badge_limit_reached` or `badge_name_taken`.',
  })
  @ApiNotFoundResponse({
    description: COMMUNITY_NOT_FOUND_ON_WRITE_DESCRIPTION,
  })
  createBadge(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() body: CreateCommunityBadgeDto,
  ) {
    return this.badges.create(slug, user.userId, body);
  }

  /** Route 4: edit a badge (owner or co-owner). */
  @Patch('badges/:badgeId')
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Edit a badge (owner or co-owner). Lowering the threshold or enabling requests a silent backfill; an empty body changes nothing.',
  })
  @ApiOkResponse({ description: 'The badge after the edit.' })
  @ApiBadRequestResponse({
    description: `\`badge_name_required\`, \`badge_name_too_long\`, \`badge_icon_unknown\`, \`badge_tint_unknown\`, \`badge_threshold_out_of_range\`, \`badge_enabled_invalid\` or \`badge_rule_locked\`; ${SPACE_DESCRIPTION}`,
  })
  @ApiForbiddenResponse({
    description:
      '`badge_manage_owner_only` for a moderator, a plain member or a non-member; `ACCOUNT_RESTRICTED` for a restricted account.',
  })
  @ApiConflictResponse({ description: '`badge_name_taken`.' })
  @ApiNotFoundResponse({
    description: `\`badge_not_found\` for a malformed id or a badge of another community; ${COMMUNITY_NOT_FOUND_ON_WRITE_DESCRIPTION}`,
  })
  updateBadge(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('badgeId') badgeId: string,
    @Body() body: UpdateCommunityBadgeDto,
  ) {
    return this.badges.update(slug, user.userId, badgeId, body);
  }

  /** Route 5: delete a badge with its awards (owner or co-owner). */
  @Delete('badges/:badgeId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Delete a badge, its awards and any flair wearing it (owner or co-owner).',
  })
  @ApiOkResponse({
    description: 'The deleted badge id and how many members held it.',
  })
  @ApiBadRequestResponse({ description: SPACE_DESCRIPTION })
  @ApiForbiddenResponse({
    description:
      '`badge_manage_owner_only` for a moderator, a plain member or a non-member; `ACCOUNT_RESTRICTED` for a restricted account.',
  })
  @ApiNotFoundResponse({
    description: `\`badge_not_found\` for a malformed id or a badge of another community; ${COMMUNITY_NOT_FOUND_ON_WRITE_DESCRIPTION}`,
  })
  deleteBadge(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('badgeId') badgeId: string,
  ) {
    return this.badges.remove(slug, user.userId, badgeId);
  }

  /** Route 6: wear an earned badge, or stop wearing one. */
  @Put('flair')
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Wear an earned, enabled badge as name flair, or pass `badgeId: null` to stop wearing one (member).',
  })
  @ApiOkResponse({ description: 'The flair the caller now wears.' })
  @ApiBadRequestResponse({
    description: `\`flair_badge_id_invalid\`, \`flair_badge_disabled\` or \`flair_badge_not_earned\`; ${SPACE_DESCRIPTION}`,
  })
  @ApiForbiddenResponse({
    description:
      '`COMMUNITY_MEMBERS_ONLY` for a non-member; `ACCOUNT_RESTRICTED` for a restricted account.',
  })
  @ApiNotFoundResponse({
    description: `\`badge_not_found\` for a badge of another community; ${COMMUNITY_NOT_FOUND_ON_WRITE_DESCRIPTION}`,
  })
  setFlair(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() body: SetCommunityFlairDto,
  ) {
    return this.badges.setFlair(slug, user.userId, body);
  }

  /** Route 7: the caller's weekly gift allowance (staff). */
  @Get('gifts/allowance')
  @ApiOperation({
    summary:
      "The caller's gift allowance in this community: gifts left in the rolling 7 days and when the next one frees up (staff).",
  })
  @ApiOkResponse({
    description: 'The weekly limit, the count used and the reset time.',
  })
  @ApiBadRequestResponse({ description: SPACE_DESCRIPTION })
  @ApiForbiddenResponse({
    description: '`gift_sender_not_staff` for a plain member or a non-member.',
  })
  @ApiNotFoundResponse({ description: COMMUNITY_NOT_FOUND_DESCRIPTION })
  giftAllowance(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.gifts.allowance(slug, user.userId);
  }

  /** Route 9: the caller's own gift shelf, newest first. */
  @Get('gifts/mine')
  @ApiOperation({
    summary:
      "The caller's gift shelf in this community, 20 per page, newest first, hidden gifts included (member).",
  })
  @ApiOkResponse({ description: 'One page of the shelf.' })
  @ApiBadRequestResponse({ description: SPACE_DESCRIPTION })
  @ApiForbiddenResponse({
    description: '`COMMUNITY_MEMBERS_ONLY` for a non-member.',
  })
  @ApiNotFoundResponse({ description: COMMUNITY_NOT_FOUND_DESCRIPTION })
  listMyGifts(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Query() query: ListMyCommunityGiftsQuery,
  ) {
    return this.gifts.listMine(slug, user.userId, query.page);
  }

  /** Route 8: send a gift with an optional note (staff). */
  @Post('gifts')
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Send a gift with an optional note to a member (staff). Notifies the recipient and writes one governance log entry.',
  })
  @ApiCreatedResponse({ description: 'The sent gift.' })
  @ApiBadRequestResponse({
    description: `\`gift_recipient_not_member\`, \`gift_to_self\`, \`gift_unknown\`, \`gift_note_too_long\` or \`gift_note_invalid\`; ${SPACE_DESCRIPTION}`,
  })
  @ApiForbiddenResponse({
    description:
      '`gift_sender_not_staff` for a plain member or a non-member; `gift_recipient_unavailable` when a block stands in either direction; `ACCOUNT_RESTRICTED` for a restricted account.',
  })
  @ApiTooManyRequestsResponse({
    description:
      '`gift_weekly_limit_reached` with the reset time once the weekly gift limit is used.',
  })
  @ApiNotFoundResponse({
    description: COMMUNITY_NOT_FOUND_ON_WRITE_DESCRIPTION,
  })
  sendGift(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() body: SendCommunityGiftDto,
  ) {
    return this.gifts.send(slug, user.userId, body);
  }

  /** Route 10: hide or unhide a gift on the caller's own shelf. */
  @Patch('gifts/:giftId')
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Hide or unhide a gift the caller received; hiding removes its name mark at once (recipient).',
  })
  @ApiOkResponse({ description: 'The gift as the shelf shows it.' })
  @ApiBadRequestResponse({
    description: `\`gift_hidden_invalid\`; ${SPACE_DESCRIPTION}`,
  })
  @ApiForbiddenResponse({
    description: '`ACCOUNT_RESTRICTED` for a restricted account.',
  })
  @ApiNotFoundResponse({
    description: `\`gift_not_found\` for anyone but the recipient or a removed gift; ${COMMUNITY_NOT_FOUND_ON_WRITE_DESCRIPTION}`,
  })
  updateGift(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('giftId') giftId: string,
    @Body() body: UpdateCommunityGiftDto,
  ) {
    return this.gifts.setHidden(slug, user.userId, giftId, body);
  }

  /** Route 11: remove a gift for everyone (its sender or owner-level staff). */
  @Delete('gifts/:giftId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Remove a gift for everyone, shelf included (its sender while still a member, or owner or co-owner).',
  })
  @ApiOkResponse({ description: 'The removed gift id.' })
  @ApiBadRequestResponse({ description: SPACE_DESCRIPTION })
  @ApiForbiddenResponse({
    description:
      '`gift_remove_not_allowed` for anyone else; `ACCOUNT_RESTRICTED` for a restricted account.',
  })
  @ApiNotFoundResponse({
    description: `\`gift_not_found\` for an unknown or already removed gift; ${COMMUNITY_NOT_FOUND_ON_WRITE_DESCRIPTION}`,
  })
  deleteGift(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('giftId') giftId: string,
  ) {
    return this.gifts.remove(slug, user.userId, giftId);
  }

  /** Route 12: a member's visible gift marks, with no sender or note. */
  @Get('members/:memberSlug/gifts')
  @ApiOperation({
    summary:
      "A member's visible gift marks in this community: newest first, at most 50, with no sender or note.",
  })
  @ApiOkResponse({
    description:
      'The visible marks. An empty list answers an unknown member slug, one off the roster, a member the roster hides (paused, suspended or hidden for 24h) and a visitor when the roster is private to members; the member always sees their own marks.',
  })
  @ApiBadRequestResponse({ description: SPACE_DESCRIPTION })
  @ApiForbiddenResponse({
    description:
      '`COMMUNITY_MEMBERS_ONLY` for a non-member of a request or invite tier community.',
  })
  @ApiNotFoundResponse({ description: COMMUNITY_NOT_FOUND_DESCRIPTION })
  listMemberGifts(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('memberSlug') memberSlug: string,
  ) {
    return this.gifts.listMemberMarks(slug, user.userId, memberSlug);
  }
}
