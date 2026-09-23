import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
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
import { AdminCommunitySpaceRequestsService } from './admin-community-space-requests.service';
import { DeclineCommunitySpaceRequestDto } from './dto/decline-community-space-request.dto';
import { ListAdminCommunitySpaceRequestsQuery } from './dto/list-admin-community-space-requests.query';

@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Admin)
@StaffRoles('communities')
@ApiTags('Admin: Community space requests')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Requires the admin role or the `communities` staff role.',
})
@Controller('admin/community-space-requests')
export class AdminCommunitySpaceRequestsController {
  constructor(
    private readonly spaceRequests: AdminCommunitySpaceRequestsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Requests from communities asking to host spaces, newest first.',
  })
  @ApiOkResponse({ description: 'A page of space requests.' })
  list(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListAdminCommunitySpaceRequestsQuery,
  ) {
    return this.spaceRequests.list(query, user.role);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Approve: switches spaces on for the community and notifies the requester.',
  })
  @ApiOkResponse({ description: 'The approved request.' })
  @ApiConflictResponse({ description: 'The request is no longer open.' })
  @ApiNotFoundResponse({ description: 'No such request.' })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.spaceRequests.approve(id, user.userId, user.role);
  }

  @Post(':id/decline')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Decline, with an optional reason the community staff see.',
  })
  @ApiOkResponse({ description: 'The declined request.' })
  @ApiConflictResponse({ description: 'The request is no longer open.' })
  @ApiNotFoundResponse({ description: 'No such request.' })
  decline(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: DeclineCommunitySpaceRequestDto,
  ) {
    return this.spaceRequests.decline(id, user.userId, dto.reason, user.role);
  }
}
