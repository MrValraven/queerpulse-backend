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
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { isPlatformStaffTier } from '../auth/platform-staff-tier';
import { UserRole } from '../users/entities/user.entity';
import { AdminNominationsQuery } from './dto/admin-nominations.query';
import { CreateSafeSpaceNominationDto } from './dto/create-safe-space-nomination.dto';
import {
  AcknowledgeNominationDto,
  AssignNominationDto,
  DecideNominationDto,
  ReopenNominationDto,
} from './dto/review-nomination.dto';
import { toDirectoryModerationNominationResponse } from './safe-space-nomination-response';
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
 *
 * Also open to the `directory_moderator` grant, so a caller here may be a plain
 * member rather than platform staff. Every response carrying a nomination row
 * therefore goes through `toDirectoryModerationNominationResponse`, which
 * withholds `nominatorId` from a caller who is not Moderator/Admin by ACCOUNT
 * TIER. The sibling flag queue reserves a flagger's identity for exactly the
 * same reason; see that function for why the nominator is the same question.
 * The gate is unchanged: only the size of the answer moves.
 */
@ApiTags('Safe-space nominations')
@ApiCookieAuth('access_token')
@Controller('admin/safe-space-nominations')
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@StaffRoles('directory_moderator')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description:
    'Requires a moderator or admin role, or the `directory_moderator` staff role.',
})
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
  async list(
    @CurrentUser() user: CurrentUserData,
    @Query() query: AdminNominationsQuery,
  ) {
    const isReaderPlatformStaff = isPlatformStaffTier(user.role);
    const page = await this.nominations.listForAdmin(query);
    return {
      ...page,
      items: page.items.map((nomination) =>
        toDirectoryModerationNominationResponse(
          nomination,
          isReaderPlatformStaff,
        ),
      ),
    };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One nomination, with everything the decision needs',
  })
  @ApiOkResponse({ description: 'The nomination.' })
  @ApiNotFoundResponse({ description: 'No nomination with that id.' })
  async get(
    @CurrentUser() user: CurrentUserData,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return toDirectoryModerationNominationResponse(
      await this.nominations.getForAdmin(id),
      isPlatformStaffTier(user.role),
    );
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
  async acknowledge(
    @CurrentUser() user: CurrentUserData,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AcknowledgeNominationDto,
  ) {
    return toDirectoryModerationNominationResponse(
      await this.nominations.acknowledge(id, user.userId, dto),
      isPlatformStaffTier(user.role),
    );
  }

  @Post(':id/assign')
  @ApiOperation({
    summary: 'Tie a nomination to a listing and open it for member visits',
  })
  @ApiOkResponse({ description: 'The nomination, now in review.' })
  @ApiNotFoundResponse({
    description: 'No nomination or listing with that id.',
  })
  async assign(
    @CurrentUser() user: CurrentUserData,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AssignNominationDto,
  ) {
    return toDirectoryModerationNominationResponse(
      await this.nominations.assign(id, user.userId, dto),
      isPlatformStaffTier(user.role),
    );
  }

  @Post(':id/decide')
  @ApiOperation({ summary: 'Award a badge or decline, with a written reason' })
  @ApiOkResponse({ description: 'The decided nomination.' })
  @ApiBadRequestResponse({
    description:
      'Not in a decidable state, or an award without a listing or a tier.',
  })
  async decide(
    @CurrentUser() user: CurrentUserData,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: DecideNominationDto,
  ) {
    return toDirectoryModerationNominationResponse(
      await this.nominations.decide(id, user.userId, dto),
      isPlatformStaffTier(user.role),
    );
  }

  @Post(':id/reopen')
  @ApiOperation({ summary: 'Re-open a decided nomination' })
  @ApiOkResponse({ description: 'The re-opened nomination.' })
  @ApiBadRequestResponse({
    description: 'This nomination has not been decided.',
  })
  async reopen(
    @CurrentUser() user: CurrentUserData,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReopenNominationDto,
  ) {
    return toDirectoryModerationNominationResponse(
      await this.nominations.reopen(id, user.userId, dto),
      isPlatformStaffTier(user.role),
    );
  }
}
