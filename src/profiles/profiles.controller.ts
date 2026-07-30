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
import { ListMembersQuery } from './dto/list-members.query';
import { ReplaceBoardDto } from './dto/replace-board.dto';
import { ReplaceGroupsDto } from './dto/replace-groups.dto';
import { ReplaceShapingsDto } from './dto/replace-shapings.dto';
import { ReplaceSkillsDto } from './dto/replace-skills.dto';
import { ReplaceSocialsDto } from './dto/replace-socials.dto';
import { ReplaceWorkDto } from './dto/replace-work.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateUsernameDto } from './dto/update-username.dto';
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
  constructor(private readonly profilesService: ProfilesService) {}

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
  @ApiBadRequestResponse({ description: 'A board slug is duplicated in the payload.' })
  @Put('me/board')
  replaceBoard(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: ReplaceBoardDto,
  ) {
    return this.profilesService.replaceBoard(user.userId, dto.items);
  }

  @ApiOperation({ summary: "Replace the caller's shaping entries" })
  @ApiOkResponse({ description: 'The persisted shaping entries, in canonical order.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiBadRequestResponse({ description: 'A shaping kind is duplicated in the payload.' })
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
  @ApiBadRequestResponse({ description: 'A group slug is unknown or duplicated.' })
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
    return this.profilesService.getBySlug(slug, user.userId);
  }
}

@ApiTags('Profiles')
@ApiCookieAuth('access_token')
@Controller('members')
export class MembersController {
  constructor(private readonly profilesService: ProfilesService) {}

  @ApiOperation({ summary: 'Search and page the member directory' })
  @ApiOkResponse({
    description: 'A page of member cards with `total`, `page`, and `pageSize`.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @Get()
  @UseGuards(ActiveMemberGuard)
  list(@CurrentUser() user: CurrentUserData, @Query() query: ListMembersQuery) {
    return this.profilesService.searchMembers(query, user.userId);
  }
}
