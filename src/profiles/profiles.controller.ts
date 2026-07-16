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
import { ReplaceGroupsDto } from './dto/replace-groups.dto';
import { ReplaceShapingsDto } from './dto/replace-shapings.dto';
import { ReplaceSkillsDto } from './dto/replace-skills.dto';
import { ReplaceSocialsDto } from './dto/replace-socials.dto';
import { ReplaceWorkDto } from './dto/replace-work.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateUsernameDto } from './dto/update-username.dto';
import { ProfilesService } from './profiles.service';

@Controller('profiles')
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  // pending-ok: edit your own draft profile.
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
  @Patch('me/username')
  updateUsername(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: UpdateUsernameDto,
  ) {
    return this.profilesService.updateUsername(user.userId, dto.username);
  }

  @Put('me/socials')
  replaceSocials(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: ReplaceSocialsDto,
  ) {
    return this.profilesService.replaceSocials(user.userId, dto.items);
  }

  @Put('me/work')
  replaceWork(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: ReplaceWorkDto,
  ) {
    return this.profilesService.replaceWork(user.userId, dto.items);
  }

  @Put('me/skills')
  replaceSkills(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: ReplaceSkillsDto,
  ) {
    return this.profilesService.replaceSkills(user.userId, dto.items);
  }

  @Put('me/shapings')
  replaceShapings(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: ReplaceShapingsDto,
  ) {
    return this.profilesService.replaceShapings(user.userId, dto.items);
  }

  @Put('me/groups')
  replaceGroups(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: ReplaceGroupsDto,
  ) {
    return this.profilesService.replaceGroups(user.userId, dto.items);
  }

  // Active members only (browsing someone else's profile). Declared AFTER the
  // 'me/...' routes so 'me' is never captured by ':slug'.
  @Get(':slug')
  @UseGuards(ActiveMemberGuard)
  getBySlug(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.profilesService.getBySlug(slug, user.userId);
  }
}

@Controller('members')
export class MembersController {
  constructor(private readonly profilesService: ProfilesService) {}

  @Get()
  @UseGuards(ActiveMemberGuard)
  list(@CurrentUser() user: CurrentUserData, @Query() query: ListMembersQuery) {
    return this.profilesService.searchMembers(query, user.userId);
  }
}
