import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { ConnectionsService } from '../connections/connections.service';
import { CloseBoardItemDto } from './dto/close-board-item.dto';
import { UpdateActivityVisibilityDto } from './dto/update-activity-visibility.dto';
import { ListMembersQuery } from './dto/list-members.query';
import { ReplaceBoardDto } from './dto/replace-board.dto';
import { ReplaceGroupsDto } from './dto/replace-groups.dto';
import { ReplaceShapingsDto } from './dto/replace-shapings.dto';
import { ReplaceSkillsDto } from './dto/replace-skills.dto';
import { ReplaceSocialsDto } from './dto/replace-socials.dto';
import { ReplaceWorkDto } from './dto/replace-work.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateUsernameDto } from './dto/update-username.dto';
import { LastActiveService } from './last-active.service';
import { ProfilesService } from './profiles.service';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

@ApiTags('Profiles')
@ApiCookieAuth('access_token')
@Controller('profiles')
export class ProfilesController {
  constructor(
    private readonly profilesService: ProfilesService,
    private readonly connectionsService: ConnectionsService,
    private readonly lastActive: LastActiveService,
  ) {}

  // pending-ok: edit your own draft profile.
  @ApiOperation({ summary: "Update the caller's own profile" })
  @ApiOkResponse({ description: "The caller's full profile after the update." })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiNotFoundResponse({ description: 'The caller has no profile.' })
  @ApiBadRequestResponse({
    description:
      'A featured-community slug is duplicated, unknown, or one the member cannot feature.',
  })
  @Patch('me')
  updateMe(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.profilesService.updateMe(user.userId, dto);
  }

  // Set/rename the caller's mandatory global @username (design plan PART C /
  // UC4). Declared with the other 'me/...' routes so 'me' is never captured by
  // ':slug'. 409 when taken, 422 when invalid/reserved.
  @ApiOperation({ summary: "Set or rename the caller's global @username" })
  @ApiOkResponse({
    description: "The caller's full profile after the username change.",
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiNotFoundResponse({ description: 'The caller has no profile.' })
  @ApiConflictResponse({ description: 'That username is already taken.' })
  @ApiUnprocessableEntityResponse({
    description: 'The username is invalid or reserved.',
  })
  @Patch('me/username')
  updateUsername(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: UpdateUsernameDto,
  ) {
    return this.profilesService.updateUsername(user.userId, dto.username);
  }

  // The caller's own coarse "recently active" band plus their opt-out, so the
  // privacy switch can show what it is actually hiding. Declared with the other
  // 'me/...' routes so 'me' is never captured by ':slug'.
  @ApiOperation({
    summary: "The caller's own activity band and its opt-out",
  })
  @ApiOkResponse({
    description:
      'The band the caller currently reads as (null when nothing is recorded yet) and whether it is hidden from other members.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @Get('me/activity-visibility')
  async getActivityVisibility(@CurrentUser() user: CurrentUserData) {
    const signal = await this.lastActive.getSignal(user.userId);
    return { band: signal.band, isHidden: signal.isHidden };
  }

  @ApiOperation({
    summary: "Hide or show the caller's activity band to other members",
  })
  @ApiOkResponse({
    description: "The stored preference and the caller's own band after it.",
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @Patch('me/activity-visibility')
  async updateActivityVisibility(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: UpdateActivityVisibilityDto,
  ) {
    const signal = await this.lastActive.setHidden(user.userId, dto.isHidden);
    return { band: signal.band, isHidden: signal.isHidden };
  }

  @ApiOperation({ summary: "Replace the caller's social links" })
  @ApiOkResponse({ description: 'The persisted social links, in order.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @Put('me/socials')
  replaceSocials(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: ReplaceSocialsDto,
  ) {
    return this.profilesService.replaceSocials(user.userId, dto.items);
  }

  @ApiOperation({ summary: "Replace the caller's work/portfolio items" })
  @ApiOkResponse({ description: 'The persisted work items, in order.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @Put('me/work')
  replaceWork(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: ReplaceWorkDto,
  ) {
    return this.profilesService.replaceWork(user.userId, dto.items);
  }

  @ApiOperation({ summary: "Replace the caller's skills" })
  @ApiOkResponse({ description: 'The persisted skills, in order.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @Put('me/skills')
  replaceSkills(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: ReplaceSkillsDto,
  ) {
    return this.profilesService.replaceSkills(user.userId, dto.items);
  }

  @ApiOperation({ summary: "Replace the caller's board posts" })
  @ApiOkResponse({ description: 'The persisted board posts, in order.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiBadRequestResponse({
    description: 'A board slug is duplicated in the payload.',
  })
  @Put('me/board')
  replaceBoard(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: ReplaceBoardDto,
  ) {
    return this.profilesService.replaceBoard(user.userId, dto.items);
  }

  @ApiOperation({
    summary: "Mark one of the caller's board items closed/found",
  })
  @ApiOkResponse({ description: 'The board item, now closed.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiNotFoundResponse({ description: 'No board item with that slug.' })
  @Patch('me/board/:slug/close')
  closeBoardItem(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CloseBoardItemDto,
  ) {
    return this.profilesService.closeBoardItem(user.userId, slug, dto.note);
  }

  @ApiOperation({ summary: "Replace the caller's shaping entries" })
  @ApiOkResponse({
    description: 'The persisted shaping entries, in canonical order.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiBadRequestResponse({
    description: 'A shaping kind is duplicated in the payload.',
  })
  @Put('me/shapings')
  replaceShapings(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: ReplaceShapingsDto,
  ) {
    return this.profilesService.replaceShapings(user.userId, dto.items);
  }

  @ApiOperation({ summary: "Replace the caller's group memberships" })
  @ApiOkResponse({ description: 'The persisted group memberships.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiBadRequestResponse({
    description: 'A group slug is unknown or duplicated.',
  })
  @Put('me/groups')
  replaceGroups(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: ReplaceGroupsDto,
  ) {
    return this.profilesService.replaceGroups(user.userId, dto.items);
  }

  // Active members only (browsing someone else's profile). Declared AFTER the
  // 'me/...' routes so 'me' is never captured by ':slug'.
  @ApiOperation({ summary: 'Get another member’s profile by slug' })
  @ApiOkResponse({
    description:
      'The full profile, or the limited card when visibility restricts the viewer.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @ApiNotFoundResponse({ description: 'No profile with that slug.' })
  @Get(':slug')
  @UseGuards(ActiveMemberGuard)
  getBySlug(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    // `user.role` lets a moderator/admin still view a taken-down member's
    // profile (the takedown 404s it for ordinary members only).
    return this.profilesService.getBySlug(slug, user.userId, user.role);
  }

  // Declared AFTER ':slug' but is not shadowed by it — ':slug/mutuals' is a
  // distinct two-segment path Express/Nest only matches on its own route.
  @ApiOperation({
    summary: 'Mutual accepted connections between the caller and a member',
  })
  @ApiOkResponse({
    description:
      'The shared accepted-connection count and up to 2 of their names.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @ApiNotFoundResponse({ description: 'No profile with that slug.' })
  @Get(':slug/mutuals')
  @UseGuards(ActiveMemberGuard)
  async getMutuals(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    const target = await this.profilesService.findBySlugOrThrow(
      slug,
      user.userId,
      user.role,
    );
    if (target.userId === user.userId) {
      // Viewing your own profile: "mutual connections with yourself" is a
      // meaningless (and pointlessly expensive) query — short-circuit.
      return { count: 0, members: [] };
    }
    return this.connectionsService.mutualMembers(user.userId, target.userId);
  }
}

@ApiTags('Profiles')
@ApiCookieAuth('access_token')
@Controller('members')
export class MembersController {
  constructor(private readonly profilesService: ProfilesService) {}

  @ApiOperation({ summary: 'Search and page the member directory' })
  @ApiOkResponse({
    description:
      'A page of member cards with `total`, `page`, `pageSize`, and `facets` — ' +
      'per-option availability counts for the sidebar filter groups, each ' +
      "counted with its own group's filter left out.",
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @Get()
  @UseGuards(ActiveMemberGuard)
  list(@CurrentUser() user: CurrentUserData, @Query() query: ListMembersQuery) {
    return this.profilesService.searchMembers(query, user.userId);
  }
}
