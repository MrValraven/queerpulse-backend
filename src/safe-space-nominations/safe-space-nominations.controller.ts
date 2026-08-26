import {
  Body,
  Controller,
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
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminNominationsQuery } from './dto/admin-nominations.query';
import { CreateSafeSpaceNominationDto } from './dto/create-safe-space-nomination.dto';
import {
  AcknowledgeNominationDto,
  AssignNominationDto,
  DecideNominationDto,
  ReopenNominationDto,
} from './dto/review-nomination.dto';
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

  @Get('mine')
  @ApiOperation({ summary: 'Your own safe-space nominations and their state' })
  @ApiOkResponse({
    description:
      'Your nominations, newest first, each with when acknowledgement fell due and what was decided.',
  })
  listMine(@CurrentUser() user: CurrentUserData) {
    return this.nominations.listMine(user.userId);
  }
}

/**
 * The review team's console. Every route here can MOVE a nomination, which is
 * what the queue previously could not do at all: rows were written `pending`
 * and no endpoint existed to acknowledge, assign, decide or re-open one.
 */
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
  @ApiOperation({
    summary: 'The safe-space nomination queue (filterable, paginated)',
  })
  @ApiOkResponse({
    description:
      'A page of nominations. Defaults to the open queue, oldest first, each row carrying its age, whether it breached the 48-hour acknowledgement promise, and the independent visit tally.',
  })
  list(@Query() query: AdminNominationsQuery) {
    return this.nominations.listForAdmin(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One nomination, with everything the decision needs',
  })
  @ApiOkResponse({ description: 'The nomination.' })
  @ApiNotFoundResponse({ description: 'No nomination with that id.' })
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.nominations.getForAdmin(id);
  }

  @Get(':id/audit')
  @ApiOperation({ summary: 'The audit trail for one nomination' })
  @ApiOkResponse({ description: 'Every act on this nomination, newest first.' })
  audit(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.nominations.auditForAdmin(id);
  }

  @Post(':id/acknowledge')
  @ApiOperation({
    summary: 'Acknowledge a nomination, keeping the 48-hour promise',
  })
  @ApiOkResponse({ description: 'The acknowledged nomination.' })
  @ApiBadRequestResponse({ description: 'Already acknowledged.' })
  acknowledge(
    @CurrentUser() user: CurrentUserData,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AcknowledgeNominationDto,
  ) {
    return this.nominations.acknowledge(id, user.userId, dto);
  }

  @Post(':id/assign')
  @ApiOperation({
    summary: 'Tie a nomination to a listing and open it for member visits',
  })
  @ApiOkResponse({ description: 'The nomination, now in review.' })
  @ApiNotFoundResponse({
    description: 'No nomination or listing with that id.',
  })
  assign(
    @CurrentUser() user: CurrentUserData,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AssignNominationDto,
  ) {
    return this.nominations.assign(id, user.userId, dto);
  }

  @Post(':id/decide')
  @ApiOperation({ summary: 'Award a badge or decline, with a written reason' })
  @ApiOkResponse({ description: 'The decided nomination.' })
  @ApiBadRequestResponse({
    description:
      'Not in a decidable state, or an award without a listing or a tier.',
  })
  decide(
    @CurrentUser() user: CurrentUserData,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: DecideNominationDto,
  ) {
    return this.nominations.decide(id, user.userId, dto);
  }

  @Post(':id/reopen')
  @ApiOperation({ summary: 'Re-open a decided nomination' })
  @ApiOkResponse({ description: 'The re-opened nomination.' })
  @ApiBadRequestResponse({
    description: 'This nomination has not been decided.',
  })
  reopen(
    @CurrentUser() user: CurrentUserData,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReopenNominationDto,
  ) {
    return this.nominations.reopen(id, user.userId, dto);
  }
}
