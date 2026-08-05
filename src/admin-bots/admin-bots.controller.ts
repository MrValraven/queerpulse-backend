import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
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

/**
 * Admin-only surface for editing platform system ("bot") accounts. Reuses the
 * profile DTOs and (via the service) the profile write logic; the only new
 * behaviour is that the target is a `:userId` gated on `isSystem`. Under the
 * global Throttler → CSRF → JWT chain, plus RolesGuard here.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin — Bots')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/bots')
export class AdminBotsController {
  constructor(private readonly adminBots: AdminBotsService) {}

  @ApiOperation({ summary: 'List the platform system (bot) accounts.' })
  @ApiOkResponse({ description: 'The system accounts.' })
  @Get()
  listBots() {
    return this.adminBots.listBots();
  }

  @ApiOperation({ summary: "Update a system account's profile fields." })
  @ApiOkResponse({ description: 'The updated profile.' })
  @ApiBadRequestResponse({ description: 'Malformed request body.' })
  @ApiNotFoundResponse({ description: 'System account not found.' })
  @Patch(':userId')
  updateBotProfile(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.adminBots.updateBotProfile(userId, dto);
  }

  @ApiOperation({ summary: "Replace a system account's username." })
  @ApiOkResponse({ description: 'The updated username.' })
  @ApiBadRequestResponse({ description: 'Malformed request body.' })
  @ApiNotFoundResponse({ description: 'System account or profile not found.' })
  @ApiConflictResponse({ description: 'That username is already taken.' })
  @ApiUnprocessableEntityResponse({
    description: 'The username is reserved or otherwise not allowed.',
  })
  @Put(':userId/username')
  updateBotUsername(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateUsernameDto,
  ) {
    return this.adminBots.updateBotUsername(userId, dto);
  }

  @ApiOperation({ summary: "Replace a system account's social links." })
  @ApiOkResponse({ description: 'The updated social links.' })
  @ApiBadRequestResponse({ description: 'Malformed request body.' })
  @ApiNotFoundResponse({ description: 'System account not found.' })
  @Put(':userId/socials')
  replaceBotSocials(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ReplaceSocialsDto,
  ) {
    return this.adminBots.replaceBotSocials(userId, dto);
  }

  @ApiOperation({ summary: "Replace a system account's work history." })
  @ApiOkResponse({ description: 'The updated work history.' })
  @ApiBadRequestResponse({ description: 'Malformed request body.' })
  @ApiNotFoundResponse({ description: 'System account not found.' })
  @Put(':userId/work')
  replaceBotWork(@Param('userId', ParseUUIDPipe) userId: string, @Body() dto: ReplaceWorkDto) {
    return this.adminBots.replaceBotWork(userId, dto);
  }

  @ApiOperation({ summary: "Replace a system account's skills." })
  @ApiOkResponse({ description: 'The updated skills.' })
  @ApiBadRequestResponse({ description: 'Malformed request body.' })
  @ApiNotFoundResponse({ description: 'System account not found.' })
  @Put(':userId/skills')
  replaceBotSkills(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ReplaceSkillsDto,
  ) {
    return this.adminBots.replaceBotSkills(userId, dto);
  }

  @ApiOperation({ summary: "Replace a system account's shapings." })
  @ApiOkResponse({ description: 'The updated shapings.' })
  @ApiBadRequestResponse({ description: 'Malformed request body.' })
  @ApiNotFoundResponse({ description: 'System account not found.' })
  @Put(':userId/shapings')
  replaceBotShapings(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ReplaceShapingsDto,
  ) {
    return this.adminBots.replaceBotShapings(userId, dto);
  }

  @ApiOperation({ summary: "Replace a system account's groups." })
  @ApiOkResponse({ description: 'The updated groups.' })
  @ApiBadRequestResponse({ description: 'Malformed request body.' })
  @ApiNotFoundResponse({ description: 'System account not found.' })
  @Put(':userId/groups')
  replaceBotGroups(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ReplaceGroupsDto,
  ) {
    return this.adminBots.replaceBotGroups(userId, dto);
  }
}
