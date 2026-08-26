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
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminStorySubmissionsService } from './admin-story-submissions.service';
import { DecideStorySubmissionDto } from './dto/decide-story-submission.dto';
import { ListAdminStorySubmissionsQuery } from './dto/list-admin-story-submissions.query';

/**
 * Admin oversight of magazine story submissions: every reader story, paginated
 * and optionally filtered by status, plus the editorial decision on one.
 * Guarded exactly like `AdminWriterApplicationsController` — `ActiveMemberGuard`
 * + `RolesGuard` with `@Roles(Admin)`, the same bar as the sibling
 * writer-application triage. There is no Editor role in this product.
 * The member-facing write (submitting a story) stays on `MagazineController`.
 */
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Admin)
@StaffRoles('editorial')
@ApiTags('Admin — Magazine submissions')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Requires the admin role, or the `editorial` staff role.',
})
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

  @Patch(':id')
  @ApiOperation({
    summary: 'Accept, decline, or commission a reader story submission.',
  })
  @ApiOkResponse({ description: 'The decided submission.' })
  @ApiNotFoundResponse({ description: 'Submission not found.' })
  @ApiConflictResponse({ description: 'Submission already decided.' })
  decide(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideStorySubmissionDto,
  ) {
    return this.adminStorySubmissions.decide(user.userId, id, dto);
  }
}
