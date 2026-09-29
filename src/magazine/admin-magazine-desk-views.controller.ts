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
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
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
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { StaffRolesGuard } from '../auth/guards/staff-roles.guard';
import { Feature } from '../common/feature.decorator';
import { CreateDeskViewDto } from './dto/create-desk-view.dto';
import { UpdateDeskViewDto } from './dto/update-desk-view.dto';
import { MagazineDeskViewsService } from './magazine-desk-views.service';

/**
 * An editor's own saved desk views: named snapshots of the desk's filters.
 * Its own controller per the guarded admin-CRUD convention. ActiveMemberGuard
 * runs first (a suspended editor is locked out), then StaffRolesGuard requires
 * `magazine_editor` (admins are a superset), matching
 * `AdminMagazinePiecesController`. Every route is scoped to the caller: there
 * is no way to read or change another editor's views.
 */
@Feature('magazine')
@ApiTags('Admin — Magazine')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Magazine editor staff role or admin role required.',
})
@Controller('magazine/admin/desk-views')
@UseGuards(ActiveMemberGuard, StaffRolesGuard)
@StaffRoles('magazine_editor')
export class AdminMagazineDeskViewsController {
  constructor(private readonly deskViews: MagazineDeskViewsService) {}

  @Get()
  @ApiOperation({ summary: "List the caller's saved desk views." })
  @ApiOkResponse({ description: 'The views, in the order the editor set.' })
  listViews(@CurrentUser() user: CurrentUserData) {
    return this.deskViews.listViews(user.userId);
  }

  @Post()
  @ApiOperation({ summary: 'Save the current desk filters as a named view.' })
  @ApiCreatedResponse({ description: 'The saved view.' })
  @ApiBadRequestResponse({ description: 'The name or query is invalid.' })
  @ApiConflictResponse({
    description: 'A view with this name exists, or the editor has 20 views.',
  })
  createView(
    @Body() dto: CreateDeskViewDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.deskViews.createView(user.userId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename, move, or update a saved desk view.' })
  @ApiOkResponse({ description: 'The updated view.' })
  @ApiBadRequestResponse({ description: 'The name or query is invalid.' })
  @ApiNotFoundResponse({ description: 'The caller has no view with this id.' })
  @ApiConflictResponse({ description: 'A view with this name exists.' })
  updateView(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDeskViewDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.deskViews.updateView(user.userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a saved desk view.' })
  @ApiNoContentResponse({ description: 'The view is gone.' })
  @ApiNotFoundResponse({ description: 'The caller has no view with this id.' })
  async deleteView(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ): Promise<void> {
    await this.deskViews.deleteView(user.userId, id);
  }
}
