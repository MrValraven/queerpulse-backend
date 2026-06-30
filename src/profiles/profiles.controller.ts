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
import { ReplaceSocialsDto } from './dto/replace-socials.dto';
import { ReplaceWorkDto } from './dto/replace-work.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
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

  // Active members only (browsing someone else's profile). Declared AFTER the
  // 'me/...' routes so 'me' is never captured by ':slug'.
  @Get(':slug')
  @UseGuards(ActiveMemberGuard)
  getBySlug(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.profilesService.getBySlug(slug, user.userId);
  }
}

@Controller('members')
export class MembersController {
  constructor(private readonly profilesService: ProfilesService) {}

  @Get()
  @UseGuards(ActiveMemberGuard)
  list(@Query() query: ListMembersQuery) {
    return this.profilesService.searchMembers(query);
  }
}
