import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
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
import { Feature } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AdminStudioAccessRequestsQuery } from './dto/studio-access-request.dto';
import { StudioAccessGrantResponse } from './studio-access.service';
import { StudioAccessRequestsService } from './studio-access-requests.service';
import { AdminStudioAccessRequestPage } from './studio-landing-response';

/**
 * Waiting for Studio: members who asked for Studio access, for staff. The
 * access guard block of `AdminStudioAccessController`: Moderator and Admin.
 *
 *   GET    /admin/studio/access-requests?cursor=          -> AdminStudioAccessRequestPage
 *   POST   /admin/studio/access-requests/:requestId/grant -> StudioAccessGrantResponse (200)
 *   DELETE /admin/studio/access-requests/:requestId       -> 204
 */
@Feature('studio')
@ApiTags('Admin: Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
@Controller('admin/studio/access-requests')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminStudioAccessRequestsController {
  constructor(private readonly requests: StudioAccessRequestsService) {}

  @Get()
  @ApiOperation({
    summary: 'Members waiting for Studio, artists first, then oldest.',
  })
  @ApiOkResponse({ description: '`AdminStudioAccessRequestPage`.' })
  listWaiting(
    @Query() query: AdminStudioAccessRequestsQuery,
  ): Promise<AdminStudioAccessRequestPage> {
    return this.requests.listWaiting(query.cursor);
  }

  @Post(':requestId/grant')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Grant the requesting member Studio access.' })
  @ApiOkResponse({ description: 'The grant.' })
  @ApiNotFoundResponse({ description: '`studio_access_request_not_found`.' })
  grantRequest(
    @CurrentUser() user: CurrentUserData,
    @Param('requestId') requestId: string,
  ): Promise<StudioAccessGrantResponse> {
    return this.requests.grantRequest(user.userId, requestId);
  }

  @Delete(':requestId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Dismiss a request quietly (idempotent).' })
  @ApiNoContentResponse({ description: 'Dismissed; the member hears nothing.' })
  dismissRequest(@Param('requestId') requestId: string): Promise<void> {
    return this.requests.dismissRequest(requestId);
  }
}
