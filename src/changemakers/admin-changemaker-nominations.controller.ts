import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
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
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminChangemakerNominationsService } from './admin-changemaker-nominations.service';
import { ListAdminChangemakerNominationsQuery } from './dto/list-admin-changemaker-nominations.query';
import { TriageChangemakerNominationDto } from './dto/triage-changemaker-nomination.dto';

/**
 * Admin oversight of changemaker nominations: every "Nominate them" a member
 * has submitted, paginated, plus (COM-17) triage — approve or dismiss a
 * pending nomination, which notifies the nominator. Guarded exactly like
 * `AdminChangemakersController` — `ActiveMemberGuard` + `RolesGuard` with
 * `@Roles(Admin)`. The member-facing write stays on
 * `ChangemakerNominationsController`; this is admin-only from here on.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin — Changemaker nominations')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/changemaker-nominations')
export class AdminChangemakerNominationsController {
  constructor(
    private readonly adminChangemakerNominations: AdminChangemakerNominationsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List changemaker nominations (paginated).' })
  @ApiOkResponse({ description: 'One page of changemaker nominations.' })
  @ApiBadRequestResponse({ description: 'Malformed query parameters.' })
  list(@Query() query: ListAdminChangemakerNominationsQuery) {
    return this.adminChangemakerNominations.list(query);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Approve or dismiss a changemaker nomination.' })
  @ApiOkResponse({ description: 'The triaged nomination.' })
  @ApiNotFoundResponse({ description: 'Nomination not found.' })
  @ApiConflictResponse({ description: 'Nomination already resolved.' })
  triage(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TriageChangemakerNominationDto,
  ) {
    return this.adminChangemakerNominations.triage(user.userId, id, dto);
  }
}
