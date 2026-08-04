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
import { AdminChangemakerNominationsService } from './admin-changemaker-nominations.service';
import { ListAdminChangemakerNominationsQuery } from './dto/list-admin-changemaker-nominations.query';

/**
 * Admin oversight of changemaker nominations: every "Nominate them" a member
 * has submitted, paginated. Guarded exactly like `AdminChangemakersController`
 * — `ActiveMemberGuard` + `RolesGuard` with `@Roles(Admin)` — and read-only
 * (the member-facing write stays on `ChangemakerNominationsController`).
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
}
