import {
  Body,
  Controller,
  Delete,
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
  ApiCookieAuth,
  ApiCreatedResponse,
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
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminResourceListingsService } from './admin-resource-listings.service';
import { CreateResourceListingDto } from './dto/create-resource-listing.dto';
import { ListResourceListingsQuery } from './dto/list-resource-listings.query';
import { UpdateResourceListingDto } from './dto/update-resource-listing.dto';

/**
 * Admin CRUD over the Legal Aid / Sexual Health Testing resource directory
 * (CNT-14) — the vetted-organisation side, entirely separate from
 * `AdminResourceSuggestionsController`'s member-submission review queue.
 * `@Roles(Admin)` at the class level with no method-level widening: unlike a
 * decision queue, publishing a real organisation's contact details is an
 * admin-only act (mirrors `AdminOrgTiersController`).
 */
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Admin)
@StaffRoles('resource_curator')
@ApiTags('Admin — Resource listings')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Requires the admin role, or the `resource_curator` staff role.',
})
@Controller('admin/resource-listings')
export class AdminResourceListingsController {
  constructor(
    private readonly adminResourceListings: AdminResourceListingsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List every resource listing, active or archived',
  })
  @ApiOkResponse({
    description: 'Every listing, optionally filtered by category.',
  })
  list(@Query() query: ListResourceListingsQuery) {
    return this.adminResourceListings.listAll(query.category);
  }

  @Post()
  @ApiOperation({ summary: 'Create a resource listing' })
  @ApiCreatedResponse({ description: 'The created listing.' })
  create(
    @Body() dto: CreateResourceListingDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.adminResourceListings.create(dto, user.userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a resource listing' })
  @ApiOkResponse({ description: 'The updated listing.' })
  @ApiNotFoundResponse({ description: 'No listing with that id.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateResourceListingDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.adminResourceListings.update(id, dto, user.userId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a resource listing' })
  @ApiNoContentResponse({ description: 'The listing was deleted.' })
  @ApiNotFoundResponse({ description: 'No listing with that id.' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminResourceListings.remove(id);
  }
}
