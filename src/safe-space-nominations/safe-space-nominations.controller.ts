import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
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
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { CreateSafeSpaceNominationDto } from './dto/create-safe-space-nomination.dto';
import { PaginationQuery } from './dto/pagination.query';
import { SafeSpaceNominationsService } from './safe-space-nominations.service';

@ApiTags('Safe-space nominations')
@ApiCookieAuth('access_token')
@Controller('safe-space-nominations')
@UseGuards(ActiveMemberGuard)
export class SafeSpaceNominationsController {
  constructor(private readonly nominations: SafeSpaceNominationsService) {}

  // Nominating is a low-stakes intake action; a tight rate limit is enough to
  // stop a member from flooding the moderation queue.
  @Throttle({ default: { limit: 8, ttl: seconds(60) } })
  @Post()
  @ApiOperation({ summary: 'Nominate a place for a safe-space review' })
  @ApiCreatedResponse({ description: 'The recorded nomination.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateSafeSpaceNominationDto,
  ) {
    return this.nominations.create(user.userId, dto);
  }
}

@ApiTags('Safe-space nominations')
@ApiCookieAuth('access_token')
@Controller('admin/safe-space-nominations')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
export class AdminSafeSpaceNominationsController {
  constructor(private readonly nominations: SafeSpaceNominationsService) {}

  @Get()
  @ApiOperation({ summary: 'List submitted safe-space nominations (paginated)' })
  @ApiOkResponse({ description: 'A page of nominations, newest first.' })
  list(@Query() page: PaginationQuery) {
    return this.nominations.listForAdmin(page);
  }
}
