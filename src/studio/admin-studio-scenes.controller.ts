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
import { AdminStudioReleaseCard } from './admin-studio-response';
import {
  AdminStudioEventOption,
  AdminStudioScene,
  AdminStudioSceneEvent,
} from './admin-studio-scene-response';
import { AdminStudioScenesService } from './admin-studio-scenes.service';
import { AdminStudioSearchQuery } from './dto/admin-studio-curation.dto';
import {
  CreateAdminStudioSceneDto,
  PinAdminStudioSceneEventDto,
  ReorderAdminStudioScenesDto,
  UpdateAdminStudioSceneDto,
} from './dto/admin-studio-scenes.dto';
import { StudioCursorQuery } from './dto/studio-cursor.query';
import { StudioPage } from './studio-response';

/**
 * Studio discovery: the staff scenes, in the `AdminTopicsController`
 * convention, Moderator and Admin only with no `@StaffRoles`. `reorder` and
 * `event-search` are declared ahead of the `:id` routes and `:id` uses
 * `ParseUUIDPipe`. `create` and `update` are listed in
 * `SHARED_UPLOAD_HANDLERS` (staff re-save each other's covers), paired with
 * `assertNoForeignUploadIntroduced` in the service.
 */
@Feature('studio')
@ApiTags('Admin: Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
@Controller('admin/studio/scenes')
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminStudioScenesController {
  constructor(private readonly scenes: AdminStudioScenesService) {}

  @Get()
  @ApiOperation({ summary: 'Every scene: active by position, then archived.' })
  @ApiOkResponse({ description: '`AdminStudioScene[]`.' })
  list(): Promise<AdminStudioScene[]> {
    return this.scenes.list();
  }

  @Post()
  @ApiOperation({ summary: 'Create a scene at the end of the home row.' })
  @ApiCreatedResponse({ description: '`AdminStudioScene`.' })
  @ApiConflictResponse({ description: '`studio_scene_slug_taken`.' })
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() body: CreateAdminStudioSceneDto,
  ): Promise<AdminStudioScene> {
    return this.scenes.create(user.userId, body);
  }

  @Post('reorder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set the order of every active scene.' })
  @ApiOkResponse({ description: '`AdminStudioScene[]`, active, new order.' })
  @ApiConflictResponse({ description: '`studio_scene_order_mismatch`.' })
  reorder(
    @Body() body: ReorderAdminStudioScenesDto,
  ): Promise<AdminStudioScene[]> {
    return this.scenes.reorder(body.sceneIds);
  }

  @Get('event-search')
  @ApiOperation({ summary: 'Upcoming open events by title, to pin.' })
  @ApiOkResponse({ description: '`{ items: AdminStudioEventOption[] }`.' })
  eventSearch(
    @Query() query: AdminStudioSearchQuery,
  ): Promise<{ items: AdminStudioEventOption[] }> {
    return this.scenes.searchEvents(query.q);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a scene.' })
  @ApiOkResponse({ description: '`AdminStudioScene`.' })
  @ApiNotFoundResponse({ description: 'Scene not found.' })
  @ApiConflictResponse({ description: '`studio_scene_slug_taken`.' })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) sceneId: string,
    @Body() body: UpdateAdminStudioSceneDto,
  ): Promise<AdminStudioScene> {
    return this.scenes.update(user.userId, sceneId, body);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive a scene; its links and pins stay.' })
  @ApiOkResponse({ description: '`AdminStudioScene`.' })
  @ApiNotFoundResponse({ description: 'Scene not found.' })
  archive(
    @Param('id', ParseUUIDPipe) sceneId: string,
  ): Promise<AdminStudioScene> {
    return this.scenes.archive(sceneId);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore a scene at the last active position.' })
  @ApiOkResponse({ description: '`AdminStudioScene`.' })
  @ApiNotFoundResponse({ description: 'Scene not found.' })
  restore(
    @Param('id', ParseUUIDPipe) sceneId: string,
  ): Promise<AdminStudioScene> {
    return this.scenes.restore(sceneId);
  }

  @Get(':id/events')
  @ApiOperation({ summary: "A scene's pinned events, soonest first." })
  @ApiOkResponse({ description: '`AdminStudioSceneEvent[]`.' })
  @ApiNotFoundResponse({ description: 'Scene not found.' })
  listEvents(
    @Param('id', ParseUUIDPipe) sceneId: string,
  ): Promise<AdminStudioSceneEvent[]> {
    return this.scenes.listPinnedEvents(sceneId);
  }

  @Post(':id/events')
  @ApiOperation({ summary: 'Pin an event to a scene (idempotent).' })
  @ApiCreatedResponse({ description: '`AdminStudioSceneEvent[]`.' })
  @ApiNotFoundResponse({ description: 'Scene or event not found.' })
  @ApiUnprocessableEntityResponse({
    description: '`studio_scene_event_not_pinnable`.',
  })
  pinEvent(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) sceneId: string,
    @Body() body: PinAdminStudioSceneEventDto,
  ): Promise<AdminStudioSceneEvent[]> {
    return this.scenes.pinEvent(user.userId, sceneId, body.eventId);
  }

  @Delete(':id/events/:eventId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unpin an event (idempotent).' })
  @ApiNoContentResponse({ description: 'Unpinned.' })
  @ApiNotFoundResponse({ description: 'Scene not found.' })
  unpinEvent(
    @Param('id', ParseUUIDPipe) sceneId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
  ): Promise<void> {
    return this.scenes.unpinEvent(sceneId, eventId);
  }

  @Get(':id/releases')
  @ApiOperation({ summary: "A scene's releases, any status, newest first." })
  @ApiOkResponse({ description: '`StudioPage<AdminStudioReleaseCard>`.' })
  @ApiNotFoundResponse({ description: 'Scene not found.' })
  listReleases(
    @Param('id', ParseUUIDPipe) sceneId: string,
    @Query() query: StudioCursorQuery,
  ): Promise<StudioPage<AdminStudioReleaseCard>> {
    return this.scenes.listReleases(sceneId, query.cursor);
  }

  @Delete(':id/releases/:releaseId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Take a release out of the scene.' })
  @ApiNoContentResponse({ description: 'Removed from the scene.' })
  @ApiNotFoundResponse({
    description: 'Scene not found, or the release is outside it.',
  })
  removeRelease(
    @Param('id', ParseUUIDPipe) sceneId: string,
    @Param('releaseId', ParseUUIDPipe) releaseId: string,
  ): Promise<void> {
    return this.scenes.removeRelease(sceneId, releaseId);
  }
}
