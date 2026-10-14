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
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { Feature } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AdminStudioCurationService } from './admin-studio-curation.service';
import {
  AdminStudioCuration,
  AdminStudioPick,
  AdminStudioReleaseCard,
} from './admin-studio-response';
import {
  AdminStudioSearchQuery,
  AdminStudioShelfParams,
  CreateAdminStudioPickDto,
  ReorderAdminStudioPicksDto,
  UpdateAdminStudioPickDto,
} from './dto/admin-studio-curation.dto';

/**
 * Studio discovery: the staff shelves, in the `AdminTopicsController`
 * convention. Moderator and Admin only; the staff-role registry holds no
 * grant that covers Studio, so no `@StaffRoles` widens it. No Studio grant
 * needed: staff curate whether or not they listen.
 *
 *   GET    /admin/studio/curation                         -> AdminStudioCuration
 *   GET    /admin/studio/curation/release-search?q=       -> { items }
 *   POST   /admin/studio/curation/picks                   -> AdminStudioPick (201)
 *   PATCH  /admin/studio/curation/picks/:id               -> AdminStudioPick
 *   DELETE /admin/studio/curation/picks/:id               -> 204
 *   POST   /admin/studio/curation/shelves/:shelf/reorder  -> AdminStudioPick[]
 */
@Feature('studio')
@ApiTags('Admin: Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
@Controller('admin/studio/curation')
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminStudioCurationController {
  constructor(private readonly curation: AdminStudioCurationService) {}

  @Get()
  @ApiOperation({ summary: 'Every pick of the three shelves.' })
  @ApiOkResponse({ description: '`AdminStudioCuration`.' })
  getCuration(): Promise<AdminStudioCuration> {
    return this.curation.getCuration();
  }

  @Get('release-search')
  @ApiOperation({ summary: 'Published releases by title or artist name.' })
  @ApiOkResponse({ description: '`{ items: AdminStudioReleaseCard[] }`.' })
  searchReleases(
    @Query() query: AdminStudioSearchQuery,
  ): Promise<{ items: AdminStudioReleaseCard[] }> {
    return this.curation.searchReleases(query.q);
  }

  @Post('picks')
  @ApiOperation({ summary: 'Add a release to a shelf.' })
  @ApiCreatedResponse({ description: '`AdminStudioPick`.' })
  @ApiNotFoundResponse({ description: 'Release not found.' })
  @ApiConflictResponse({
    description:
      '`studio_curation_shelf_full` or `studio_curation_already_on_shelf`.',
  })
  @ApiUnprocessableEntityResponse({
    description: '`studio_curation_release_not_published`.',
  })
  addPick(
    @CurrentUser() user: CurrentUserData,
    @Body() body: CreateAdminStudioPickDto,
  ): Promise<AdminStudioPick> {
    return this.curation.addPick(user.userId, body);
  }

  @Patch('picks/:id')
  @ApiOperation({ summary: "Edit a pick's note." })
  @ApiOkResponse({ description: '`AdminStudioPick`.' })
  @ApiNotFoundResponse({ description: 'Pick not found.' })
  updateNote(
    @Param('id', ParseUUIDPipe) pickId: string,
    @Body() body: UpdateAdminStudioPickDto,
  ): Promise<AdminStudioPick> {
    return this.curation.updateNote(pickId, body);
  }

  @Delete('picks/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a pick and close the gap on its shelf.' })
  @ApiNoContentResponse({ description: 'Removed.' })
  @ApiNotFoundResponse({ description: 'Pick not found.' })
  removePick(@Param('id', ParseUUIDPipe) pickId: string): Promise<void> {
    return this.curation.removePick(pickId);
  }

  @Post('shelves/:shelf/reorder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set the order of every pick of a shelf.' })
  @ApiOkResponse({ description: '`AdminStudioPick[]`, the new order.' })
  @ApiConflictResponse({ description: '`studio_curation_order_mismatch`.' })
  reorderShelf(
    @Param() params: AdminStudioShelfParams,
    @Body() body: ReorderAdminStudioPicksDto,
  ): Promise<AdminStudioPick[]> {
    return this.curation.reorderShelf(params.shelf, body.pickIds);
  }
}
