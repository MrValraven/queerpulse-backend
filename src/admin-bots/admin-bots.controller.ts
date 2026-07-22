import { Body, Controller, Get, Param, Patch, Put, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ReplaceGroupsDto } from '../profiles/dto/replace-groups.dto';
import { ReplaceShapingsDto } from '../profiles/dto/replace-shapings.dto';
import { ReplaceSkillsDto } from '../profiles/dto/replace-skills.dto';
import { ReplaceSocialsDto } from '../profiles/dto/replace-socials.dto';
import { ReplaceWorkDto } from '../profiles/dto/replace-work.dto';
import { UpdateProfileDto } from '../profiles/dto/update-profile.dto';
import { UpdateUsernameDto } from '../profiles/dto/update-username.dto';
import { UserRole } from '../users/entities/user.entity';
import { AdminBotsService } from './admin-bots.service';

/**
 * Admin-only surface for editing platform system ("bot") accounts. Reuses the
 * profile DTOs and (via the service) the profile write logic; the only new
 * behaviour is that the target is a `:userId` gated on `isSystem`. Under the
 * global Throttler → CSRF → JWT chain, plus RolesGuard here.
 */
@UseGuards(RolesGuard)
@Roles(UserRole.Admin)
@Controller('admin/bots')
export class AdminBotsController {
  constructor(private readonly adminBots: AdminBotsService) {}

  @Get()
  listBots() {
    return this.adminBots.listBots();
  }

  @Patch(':userId')
  updateBotProfile(
    @Param('userId') userId: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.adminBots.updateBotProfile(userId, dto);
  }

  @Put(':userId/username')
  updateBotUsername(
    @Param('userId') userId: string,
    @Body() dto: UpdateUsernameDto,
  ) {
    return this.adminBots.updateBotUsername(userId, dto);
  }

  @Put(':userId/socials')
  replaceBotSocials(
    @Param('userId') userId: string,
    @Body() dto: ReplaceSocialsDto,
  ) {
    return this.adminBots.replaceBotSocials(userId, dto);
  }

  @Put(':userId/work')
  replaceBotWork(
    @Param('userId') userId: string,
    @Body() dto: ReplaceWorkDto,
  ) {
    return this.adminBots.replaceBotWork(userId, dto);
  }

  @Put(':userId/skills')
  replaceBotSkills(
    @Param('userId') userId: string,
    @Body() dto: ReplaceSkillsDto,
  ) {
    return this.adminBots.replaceBotSkills(userId, dto);
  }

  @Put(':userId/shapings')
  replaceBotShapings(
    @Param('userId') userId: string,
    @Body() dto: ReplaceShapingsDto,
  ) {
    return this.adminBots.replaceBotShapings(userId, dto);
  }

  @Put(':userId/groups')
  replaceBotGroups(
    @Param('userId') userId: string,
    @Body() dto: ReplaceGroupsDto,
  ) {
    return this.adminBots.replaceBotGroups(userId, dto);
  }
}
