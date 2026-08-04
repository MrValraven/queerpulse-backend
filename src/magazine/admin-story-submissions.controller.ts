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
import { AdminStorySubmissionsService } from './admin-story-submissions.service';
import { ListAdminStorySubmissionsQuery } from './dto/list-admin-story-submissions.query';

/**
 * Admin oversight of magazine story submissions: every reader pitch, paginated
 * and optionally filtered by status. Guarded exactly like
 * `AdminInvitesController` — `ActiveMemberGuard` + `RolesGuard` with
 * `@Roles(Admin)` — and read-only (the member-facing write stays on
 * `MagazineController`).
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin — Magazine submissions')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/magazine-submissions')
export class AdminStorySubmissionsController {
  constructor(
    private readonly adminStorySubmissions: AdminStorySubmissionsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List magazine story submissions (paginated).' })
  @ApiOkResponse({ description: 'One page of story submissions.' })
  @ApiBadRequestResponse({ description: 'Malformed query parameters.' })
  list(@Query() query: ListAdminStorySubmissionsQuery) {
    return this.adminStorySubmissions.list(query);
  }
}
