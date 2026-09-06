import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
 * and optionally filtered by status, the editorial decision on one, and the
 * one route back from a decline.
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

  /**
   * Undo a decline. A separate route rather than a fourth `decision` value on
   * `PATCH :id`, because this is the opposite of deciding: it clears the
   * verdict instead of recording one, it takes no reply note, and the body of
   * `decide` is guarded on the row being undecided while this one is guarded on
   * the row being declined. Folding the two together would put both guards in
   * one method where each is the other's exception.
   *
   * `@HttpCode(200)`: it returns the reopened row, and nothing is created.
   */
  @Post(':id/reopen')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reopen a declined story submission, returning it to the queue.',
  })
  @ApiOkResponse({ description: 'The reopened submission, back in the queue.' })
  @ApiNotFoundResponse({ description: 'Submission not found.' })
  @ApiConflictResponse({
    description:
      'Not a declined submission: it is undecided, withdrawn, or was accepted or commissioned and has a desk record behind it.',
  })
  reopen(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.adminStorySubmissions.reopen(user.userId, id);
  }
}
