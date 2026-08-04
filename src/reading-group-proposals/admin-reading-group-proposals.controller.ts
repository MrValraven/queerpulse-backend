import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminReadingGroupProposalsService } from './admin-reading-group-proposals.service';
import { ListAdminReadingGroupProposalsQuery } from './dto/list-admin-reading-group-proposals.query';

/**
 * Admin oversight of reading-group proposals: every "Start your own group" a
 * member has submitted, paginated and optionally filtered by format. Guarded
 * exactly like `AdminInvitesController` — `ActiveMemberGuard` + `RolesGuard`
 * with `@Roles(Admin)` — and read-only (the member-facing write stays on
 * `ReadingGroupProposalsController`).
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin — Reading-group proposals')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/reading-group-proposals')
export class AdminReadingGroupProposalsController {
  constructor(
    private readonly adminReadingGroupProposals: AdminReadingGroupProposalsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List reading-group proposals (paginated).' })
  @ApiOkResponse({ description: 'One page of reading-group proposals.' })
  @ApiBadRequestResponse({ description: 'Malformed query parameters.' })
  list(@Query() query: ListAdminReadingGroupProposalsQuery) {
    return this.adminReadingGroupProposals.list(query);
  }
}
