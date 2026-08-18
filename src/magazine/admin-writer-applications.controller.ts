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
import { AdminWriterApplicationsService } from './admin-writer-applications.service';
import { ListAdminWriterApplicationsQuery } from './dto/list-admin-writer-applications.query';
import { TriageWriterApplicationDto } from './dto/triage-writer-application.dto';

/**
 * Admin triage of magazine writer applications. Guarded exactly like
 * `AdminStorySubmissionsController` — `ActiveMemberGuard` + `RolesGuard`
 * with `@Roles(Admin)`.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin — Magazine writer applications')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/magazine-writer-applications')
export class AdminWriterApplicationsController {
  constructor(
    private readonly adminWriterApplications: AdminWriterApplicationsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List magazine writer applications (paginated).' })
  @ApiOkResponse({ description: 'One page of writer applications.' })
  @ApiBadRequestResponse({ description: 'Malformed query parameters.' })
  list(@Query() query: ListAdminWriterApplicationsQuery) {
    return this.adminWriterApplications.list(query);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Approve or decline a writer application.' })
  @ApiOkResponse({ description: 'The triaged application.' })
  @ApiNotFoundResponse({ description: 'Application not found.' })
  @ApiConflictResponse({ description: 'Application already resolved.' })
  triage(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TriageWriterApplicationDto,
  ) {
    return this.adminWriterApplications.triage(user.userId, id, dto);
  }
}
