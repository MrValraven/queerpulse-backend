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
import {
  ApiBadRequestResponse,
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
import { AdminResourceSuggestionsService } from './admin-resource-suggestions.service';
import { DecideResourceSuggestionDto } from './dto/decide-resource-suggestion.dto';
import { ListAdminResourceSuggestionsQuery } from './dto/list-admin-resource-suggestions.query';

/**
 * Admin oversight of the "suggest a resource" review queue (CNT-14): every
 * Legal Aid / Sexual Health Testing suggestion a member has submitted,
 * paginated and optionally filtered. Guard pattern mirrors
 * `AdminReadingGroupProposalsController` exactly: class-level `@Roles(Admin)`
 * covers the read-only list, while the approve/decline/archive transitions
 * widen to `@Roles(Moderator, Admin)` at the handler (method-level `@Roles`
 * overrides the class via `Reflector.getAllAndOverride`). The member-facing
 * write stays on `ResourcesController`.
 */
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Admin)
@StaffRoles('resource_curator')
@ApiTags('Admin — Resource suggestions')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Requires the admin role, or the `resource_curator` staff role.',
})
@Controller('admin/resource-suggestions')
export class AdminResourceSuggestionsController {
  constructor(
    private readonly adminResourceSuggestions: AdminResourceSuggestionsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List resource suggestions (paginated).' })
  @ApiOkResponse({ description: 'One page of resource suggestions.' })
  @ApiBadRequestResponse({ description: 'Malformed query parameters.' })
  list(@Query() query: ListAdminResourceSuggestionsQuery) {
    return this.adminResourceSuggestions.list(query);
  }

  @Post(':id/approve')
  @Roles(UserRole.Moderator, UserRole.Admin)
  @ApiOperation({ summary: 'Approve a resource suggestion.' })
  @ApiOkResponse({ description: 'The suggestion, now approved.' })
  @ApiNotFoundResponse({ description: 'No suggestion with that id.' })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: DecideResourceSuggestionDto,
  ) {
    return this.adminResourceSuggestions.approve(id, user.userId, dto.note);
  }

  @Post(':id/decline')
  @Roles(UserRole.Moderator, UserRole.Admin)
  @ApiOperation({ summary: 'Decline a resource suggestion.' })
  @ApiOkResponse({ description: 'The suggestion, now declined.' })
  @ApiNotFoundResponse({ description: 'No suggestion with that id.' })
  decline(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: DecideResourceSuggestionDto,
  ) {
    return this.adminResourceSuggestions.decline(id, user.userId, dto.note);
  }

  @Post(':id/archive')
  @Roles(UserRole.Moderator, UserRole.Admin)
  @ApiOperation({ summary: 'Archive a resource suggestion.' })
  @ApiOkResponse({ description: 'The suggestion, now archived.' })
  @ApiNotFoundResponse({ description: 'No suggestion with that id.' })
  archive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: DecideResourceSuggestionDto,
  ) {
    return this.adminResourceSuggestions.archive(id, user.userId, dto.note);
  }
}
