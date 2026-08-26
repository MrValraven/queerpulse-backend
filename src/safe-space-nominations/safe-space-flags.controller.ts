import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
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
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { isPlatformStaffTier } from '../auth/platform-staff-tier';
import { UserRole } from '../users/entities/user.entity';
import {
  AdminFlagsQuery,
  CreateSafeSpaceFlagDto,
  ResolveSafeSpaceFlagDto,
  RestoreSafeSpaceBadgeDto,
  SuspendSafeSpaceBadgeDto,
} from './dto/safe-space-flag.dto';
import { SafeSpaceAuditService } from './safe-space-audit.service';
import { toSafeSpaceAuditResponse } from './safe-space-badge-response';
import { SafeSpaceBadgeService } from './safe-space-badge.service';
import { SafeSpaceFlagsService } from './safe-space-flags.service';

/**
 * The member's half of the flag mechanism, addressed by listing SLUG to match
 * the public read path (`GET /directory/safe-spaces/:slug`) and the vouch
 * routes it sits next to.
 */
@ApiTags('Safe-space badge')
@ApiCookieAuth('access_token')
@Controller('safe-spaces')
@UseGuards(ActiveMemberGuard)
export class SafeSpaceFlagsController {
  constructor(
    private readonly flags: SafeSpaceFlagsService,
    private readonly badges: SafeSpaceBadgeService,
  ) {}

  @Get(':slug/badge-state')
  @ApiOperation({
    summary: 'The honest state of the safe-space badge on one space',
  })
  @ApiOkResponse({
    description:
      'Badge state, tier, when it was awarded, whether the annual re-review is due, whether it is currently suspended, and the independent visit tally. Carries no flag count and no flagger identity.',
  })
  @ApiNotFoundResponse({ description: 'No safe space with that slug.' })
  badgeState(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.badges.getBadgeState(slug, user.userId);
  }

  // Flagging is a safety action and it must stay cheap to reach, so the limit
  // is generous enough for a member acting in good faith across several spaces
  // and tight enough that nobody can script a badge into suspension. Raising
  // the same flag twice is idempotent, so a nervous double tap costs nothing.
  @Throttle({ default: { limit: 5, ttl: seconds(300) } })
  @Post(':slug/flag')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Flag a badged safe space' })
  @ApiCreatedResponse({
    description:
      'Your flag. `wasAlreadyFlagged` is true when you already had one open on this space.',
  })
  @ApiBadRequestResponse({
    description: 'This space carries no badge, or it is your own space.',
  })
  @ApiNotFoundResponse({ description: 'No safe space with that slug.' })
  flag(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateSafeSpaceFlagDto,
  ) {
    return this.flags.flag(user.userId, slug, dto);
  }

  @Get(':slug/flag')
  @ApiOperation({
    summary: 'Your own open flag on this space, if you have one',
  })
  @ApiOkResponse({ description: 'Your flag, or null.' })
  myFlag(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.flags.myFlag(user.userId, slug);
  }

  @Delete(':slug/flag')
  @ApiOperation({ summary: 'Withdraw your flag' })
  @ApiOkResponse({ description: 'Flag withdrawn.' })
  @ApiNotFoundResponse({ description: 'No open flag to withdraw.' })
  withdraw(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.flags.withdraw(user.userId, slug);
  }
}

/**
 * The moderator queue for flags. This is the ONLY place a flagger's identity or
 * their free-text detail is ever served.
 */
@ApiTags('Safe-space badge')
@ApiCookieAuth('access_token')
@Controller('admin/safe-space-flags')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
export class AdminSafeSpaceFlagsController {
  constructor(private readonly flags: SafeSpaceFlagsService) {}

  @Get()
  @ApiOperation({
    summary: 'The safe-space flag queue (filterable, paginated)',
  })
  @ApiOkResponse({ description: 'A page of flags, newest first.' })
  list(@Query() query: AdminFlagsQuery) {
    return this.flags.listForAdmin(query);
  }

  @Post(':id/resolve')
  @ApiOperation({ summary: 'Uphold or dismiss one flag' })
  @ApiOkResponse({ description: 'The resolved flag.' })
  @ApiBadRequestResponse({ description: 'This flag is already resolved.' })
  @ApiNotFoundResponse({ description: 'No flag with that id.' })
  resolve(
    @CurrentUser() user: CurrentUserData,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ResolveSafeSpaceFlagDto,
  ) {
    return this.flags.resolveFlag(id, user.userId, dto);
  }
}

/** Moderator control of a badge itself: suspend, restore, and the annual
 * re-review queue.
 *
 * Also open to the `directory_moderator` grant, which is why `audit` below
 * filters what it returns: the sibling flag queue above stays Moderator/Admin
 * on purpose, and the badge trail must not route around it. See that method. */
@ApiTags('Safe-space badge')
@ApiCookieAuth('access_token')
@Controller('admin/safe-spaces')
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@StaffRoles('directory_moderator')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description:
    'Requires a moderator or admin role, or the `directory_moderator` staff role.',
})
export class AdminSafeSpaceBadgesController {
  constructor(
    private readonly badges: SafeSpaceBadgeService,
    private readonly audits: SafeSpaceAuditService,
  ) {}

  @Get('re-review-due')
  @ApiOperation({
    summary: 'Badges past their annual re-review, most overdue first',
  })
  @ApiOkResponse({ description: 'Spaces due for re-review.' })
  reReviewDue() {
    return this.badges.listReReviewDue();
  }

  @Post(':ref/badge/suspend')
  @ApiOperation({ summary: 'Suspend a safe-space badge pending review' })
  @ApiOkResponse({ description: 'The open suspension.' })
  @ApiBadRequestResponse({ description: 'This listing carries no badge.' })
  @ApiConflictResponse({ description: 'This badge is already suspended.' })
  suspend(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: SuspendSafeSpaceBadgeDto,
  ) {
    return this.badges.suspendByModerator(ref, user.userId, dto.reason);
  }

  @Post(':ref/badge/restore')
  @ApiOperation({ summary: 'Lift a suspension and let the badge speak again' })
  @ApiOkResponse({ description: 'The lifted suspension.' })
  @ApiNotFoundResponse({ description: 'This badge is not suspended.' })
  restore(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: RestoreSafeSpaceBadgeDto,
  ) {
    return this.badges.restore(ref, user.userId, dto.reason);
  }

  /**
   * The badge's own history. `flag` rows are withheld from a caller who
   * reached this on the `directory_moderator` grant rather than on the
   * Moderator/Admin tier.
   *
   * WHY. A `flag` row is written with `actorId = flaggerId` on flag_raised and
   * flag_withdrawn, and a flag_resolved row carries the reviewing moderator's
   * free-text note in `reason`. `toSafeSpaceAuditResponse` returns both
   * verbatim, so this route was a way around `AdminSafeSpaceFlagsController` —
   * deliberately left on plain `RolesGuard` because it is the ONLY place a
   * flagger's identity or free text is served. `directory_moderator`'s registry
   * entry promises exactly the opposite of what that leak did.
   *
   * WHY FILTER RATHER THAN CLOSE THE ROUTE. An empty `@StaffRoles()` here would
   * work too, and would be the blunter fix: it would take the whole badge
   * history away from the very people the grant exists for. A directory
   * moderator suspends and restores badges and works the nomination queue, and
   * "why is this badge suspended, and what has been done about it?" is the
   * question this trail answers for that work. The `nomination` and `badge`
   * rows carry no flagger: their actor is a reviewer, their `reason` is the
   * reviewer's own note, and the flag-threshold suspension row carries a COUNT
   * (`{ cause: 'flag_threshold', flagCount }`), never who. So the narrow cut is
   * by subject type, and it keeps the route useful.
   */
  @Get(':ref/audit')
  @ApiOperation({
    summary: 'Everything ever done to the safe-space badge on one business',
  })
  @ApiOkResponse({
    description:
      'The audit trail, newest first. Flag rows are included only for a ' +
      'platform moderator or admin.',
  })
  @ApiNotFoundResponse({ description: 'No listing with that ref.' })
  async audit(@CurrentUser() user: CurrentUserData, @Param('ref') ref: string) {
    const listing = await this.badges.resolveByRef(ref);
    const rows = await this.audits.listForListing(listing.id);
    const readableRows = isPlatformStaffTier(user.role)
      ? rows
      : rows.filter((row) => row.subjectType !== 'flag');
    return readableRows.map(toSafeSpaceAuditResponse);
  }
}
