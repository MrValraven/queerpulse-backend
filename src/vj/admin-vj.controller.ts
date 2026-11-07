import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
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
import {
  AddVjPackClipDto,
  CreateVjClipDto,
  CreateVjPackDto,
  CreateVjSceneDto,
  CreateVjSetlistDto,
  RenameVjPackDto,
  RenameVjSetlistDto,
  ReorderVjPackClipsDto,
  ReorderVjPacksDto,
  ReorderVjScenesDto,
  ReorderVjSetlistsDto,
  SetVjClipPreviewDto,
  SetVjPackEventDto,
  SetVjSetlistItemsDto,
  UpdateVjClipDto,
  UpdateVjSceneDto,
  VjClipsMediaQuery,
  VjPackMediaQuery,
} from './dto/vj.dto';
import { VjEventLinkService } from './vj-event-link.service';
import { VjLibraryService } from './vj-library.service';
import { VjSceneService } from './vj-scene.service';
import { VjSetlistService } from './vj-setlist.service';

/**
 * The admin routes of the VJ library: ordered packs of clips, the clips
 * themselves (MP4, WebM and GIF) with their previews and playback defaults,
 * the event a pack links to, saved scenes and set lists of scenes.
 *
 * Admin only. The class carries `@Roles(UserRole.Admin)` and an EMPTY
 * `@StaffRoles()`: the empty list switches the grant axis off, so a Moderator
 * and a holder of a staff grant are both refused, as on the persona wall.
 * There is no `@Feature(...)` and no cache interceptor. Every GET answers
 * `Cache-Control: no-store`, the media URLs above all.
 *
 * Route table (every refusal carries a `code`; the service checks the uuid
 * shape of `:id` and `:clipId` and answers the route's not-found code, so no
 * route binds a `ParseUUIDPipe`):
 *
 *   GET    admin/vj/packs                        list packs
 *   POST   admin/vj/packs                        create a pack
 *   PATCH  admin/vj/packs/reorder                set the order of every pack
 *   GET    admin/vj/packs/:id/clips              clips of a pack, pack order
 *   GET    admin/vj/packs/:id/media              presigned URLs for a screen
 *   GET    admin/vj/packs/:id/event              the pack's event card
 *   POST   admin/vj/packs/:id/clips              add a clip to a pack
 *   PATCH  admin/vj/packs/:id/clips/reorder      set the order of a pack
 *   PATCH  admin/vj/packs/:id/event              link or unlink an event
 *   DELETE admin/vj/packs/:id/clips/:clipId      remove a clip from a pack
 *   PATCH  admin/vj/packs/:id                    rename a pack
 *   DELETE admin/vj/packs/:id                    delete a pack
 *   GET    admin/vj/clips                        list clips
 *   GET    admin/vj/clips/media                  presigned URLs for any clips
 *   POST   admin/vj/clips                        create a clip from two uploads
 *   PUT    admin/vj/clips/:id/preview            store a clip's preview
 *   PATCH  admin/vj/clips/:id                    change a clip's settings
 *   DELETE admin/vj/clips/:id                    delete a clip
 *   GET    admin/vj/events/upcoming              events a pack may link to
 *   GET    admin/vj/scenes                       list scenes
 *   POST   admin/vj/scenes                       save a scene
 *   PATCH  admin/vj/scenes/reorder               set the order of every scene
 *   PATCH  admin/vj/scenes/:id                   change a scene
 *   DELETE admin/vj/scenes/:id                   delete a scene
 *   GET    admin/vj/setlists                     list set lists
 *   POST   admin/vj/setlists                     create a set list
 *   PATCH  admin/vj/setlists/reorder             set the order of every set list
 *   PUT    admin/vj/setlists/:id/items           replace a set list's scenes
 *   PATCH  admin/vj/setlists/:id                 rename a set list
 *   DELETE admin/vj/setlists/:id                 delete a set list
 *
 * The literal routes (`packs/reorder`, `clips/media`, `scenes/reorder`,
 * `setlists/reorder`) are declared before the parameter routes of the same
 * prefix so Nest matches the literal.
 */
@ApiTags('Admin - VJ')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/vj')
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Admin)
@StaffRoles()
export class AdminVjController {
  constructor(
    private readonly library: VjLibraryService,
    private readonly eventLinks: VjEventLinkService,
    private readonly scenes: VjSceneService,
    private readonly setlists: VjSetlistService,
  ) {}

  @Get('packs')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'List the VJ packs',
    description:
      'Every pack in position order, with its clip count, total size, the thumbnail of its first clip and the summary of its linked event.',
  })
  @ApiOkResponse({ description: 'The packs in position order.' })
  listPacks() {
    return this.library.listPacks();
  }

  @Post('packs')
  @ApiOperation({
    summary: 'Create a VJ pack',
    description:
      'Appends the pack after the last one. Checks run in this order: `VJ_PACK_NAME_REQUIRED`, `VJ_PACK_NAME_TOO_LONG`, `VJ_PACK_LIMIT_REACHED`, `VJ_PACK_NAME_TAKEN`.',
  })
  @ApiCreatedResponse({ description: 'The new pack.' })
  @ApiBadRequestResponse({
    description:
      'Code `VJ_PACK_NAME_REQUIRED` or `VJ_PACK_NAME_TOO_LONG`: the name is missing, blank or too long.',
  })
  @ApiConflictResponse({
    description:
      'Code `VJ_PACK_LIMIT_REACHED` (the library is full) or `VJ_PACK_NAME_TAKEN` (the body names the pack holding the name).',
  })
  createPack(
    @CurrentUser() user: CurrentUserData,
    @Body() body: CreateVjPackDto,
  ) {
    return this.library.createPack(user, body);
  }

  @Patch('packs/reorder')
  @ApiOperation({
    summary: 'Reorder the VJ packs',
    description: 'The body lists every pack id exactly once, in the new order.',
  })
  @ApiOkResponse({ description: 'The packs in the new order.' })
  @ApiBadRequestResponse({
    description:
      'Code `VJ_PACK_REORDER_MISMATCH`: the ids are not exactly the current packs.',
  })
  reorderPacks(@Body() body: ReorderVjPacksDto) {
    return this.library.reorderPacks(body);
  }

  @Get('packs/:id/clips')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'List the clips of a VJ pack',
    description: 'The pack and its clips in pack order.',
  })
  @ApiOkResponse({ description: 'The pack and its clips.' })
  @ApiNotFoundResponse({
    description:
      'Code `VJ_PACK_NOT_FOUND`: no pack has that id, or the id is not a uuid.',
  })
  getPackClips(@Param('id') packId: string) {
    return this.library.getPackClips(packId);
  }

  @Get('packs/:id/media')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Get the presigned clip URLs a screen preloads',
    description:
      'One item per clip in pack order, each with a presigned GET URL that lasts 900 seconds. With `clipIds` (comma-separated uuids) only those that are in the pack are answered, so a screen can re-request URLs that expired.',
  })
  @ApiOkResponse({ description: 'The presigned URLs in pack order.' })
  @ApiBadRequestResponse({
    description:
      'Code `VJ_CLIP_IDS_INVALID`: `clipIds` is empty, too long or holds a value that is not a uuid.',
  })
  @ApiNotFoundResponse({
    description:
      'Code `VJ_PACK_NOT_FOUND`: no pack has that id, or the id is not a uuid.',
  })
  getPackMedia(@Param('id') packId: string, @Query() query: VjPackMediaQuery) {
    return this.library.getPackMedia(packId, query);
  }

  @Get('packs/:id/event')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Get the event card of a VJ pack',
    description:
      'The card the projector shows for the linked event. A pack with no link answers a null card and a null reason; a cancelled event answers `unavailableReason: cancelled`, and a draft or an event outside the public and members listings answers `not_listed`. Checks: `VJ_PACK_NOT_FOUND`.',
  })
  @ApiOkResponse({ description: 'The pack id, its card and the reason.' })
  @ApiNotFoundResponse({
    description:
      'Code `VJ_PACK_NOT_FOUND`: no pack has that id, or the id is not a uuid.',
  })
  getPackEvent(@Param('id') packId: string) {
    return this.eventLinks.getPackEvent(packId);
  }

  @Post('packs/:id/clips')
  @ApiOperation({
    summary: 'Add a clip to a VJ pack',
    description:
      'Appends the clip after the last one. Checks run in this order: `VJ_PACK_NOT_FOUND`, `VJ_CLIP_NOT_FOUND`, `VJ_CLIP_ALREADY_IN_PACK`, `VJ_PACK_FULL`.',
  })
  @ApiCreatedResponse({ description: 'The pack and its clips.' })
  @ApiNotFoundResponse({
    description: 'Code `VJ_PACK_NOT_FOUND` or `VJ_CLIP_NOT_FOUND`.',
  })
  @ApiConflictResponse({
    description: 'Code `VJ_CLIP_ALREADY_IN_PACK` or `VJ_PACK_FULL`.',
  })
  addPackClip(@Param('id') packId: string, @Body() body: AddVjPackClipDto) {
    return this.library.addPackClip(packId, body);
  }

  @Patch('packs/:id/clips/reorder')
  @ApiOperation({
    summary: 'Reorder the clips of a VJ pack',
    description:
      'The body lists every clip id of the pack exactly once, in the new order.',
  })
  @ApiOkResponse({ description: 'The pack and its clips in the new order.' })
  @ApiNotFoundResponse({ description: 'Code `VJ_PACK_NOT_FOUND`.' })
  @ApiBadRequestResponse({
    description:
      'Code `VJ_PACK_CLIPS_REORDER_MISMATCH`: the ids are not exactly the clips of the pack.',
  })
  reorderPackClips(
    @Param('id') packId: string,
    @Body() body: ReorderVjPackClipsDto,
  ) {
    return this.library.reorderPackClips(packId, body);
  }

  @Patch('packs/:id/event')
  @ApiOperation({
    summary: 'Link a VJ pack to an event, or unlink it',
    description:
      '`eventId: null` unlinks. A linked event must be published and listed to the public or to members; it may have ended. Linking the event already linked writes nothing. Checks run in this order: `VJ_PACK_NOT_FOUND` (malformed id), `VJ_EVENT_NOT_FOUND` (`eventId` neither null nor a uuid), `VJ_PACK_NOT_FOUND`, `VJ_EVENT_NOT_FOUND`, `VJ_EVENT_NOT_LINKABLE`.',
  })
  @ApiOkResponse({ description: 'The pack with its event summary.' })
  @ApiNotFoundResponse({
    description: 'Code `VJ_PACK_NOT_FOUND` or `VJ_EVENT_NOT_FOUND`.',
  })
  @ApiConflictResponse({
    description:
      'Code `VJ_EVENT_NOT_LINKABLE`: the event is a draft, cancelled, or listed outside the public and members listings.',
  })
  setPackEvent(@Param('id') packId: string, @Body() body: SetVjPackEventDto) {
    return this.eventLinks.setPackEvent(packId, body);
  }

  @Delete('packs/:id/clips/:clipId')
  @ApiOperation({
    summary: 'Remove a clip from a VJ pack',
    description:
      'The clip stays in the library and the remaining clips keep their order.',
  })
  @ApiOkResponse({ description: 'The pack and its remaining clips.' })
  @ApiNotFoundResponse({
    description:
      'Code `VJ_PACK_NOT_FOUND`, `VJ_CLIP_NOT_FOUND` or `VJ_CLIP_NOT_IN_PACK`.',
  })
  removePackClip(@Param('id') packId: string, @Param('clipId') clipId: string) {
    return this.library.removePackClip(packId, clipId);
  }

  @Patch('packs/:id')
  @ApiOperation({
    summary: 'Rename a VJ pack',
    description:
      'An unchanged name is a no-op. A change of case alone is allowed. Checks run in this order: `VJ_PACK_NOT_FOUND` (malformed id), `VJ_PACK_NAME_REQUIRED`, `VJ_PACK_NAME_TOO_LONG`, `VJ_PACK_NOT_FOUND`, `VJ_PACK_NAME_TAKEN`.',
  })
  @ApiOkResponse({ description: 'The pack.' })
  @ApiBadRequestResponse({
    description: 'Code `VJ_PACK_NAME_REQUIRED` or `VJ_PACK_NAME_TOO_LONG`.',
  })
  @ApiNotFoundResponse({ description: 'Code `VJ_PACK_NOT_FOUND`.' })
  @ApiConflictResponse({ description: 'Code `VJ_PACK_NAME_TAKEN`.' })
  renamePack(@Param('id') packId: string, @Body() body: RenameVjPackDto) {
    return this.library.renamePack(packId, body);
  }

  @Delete('packs/:id')
  @ApiOperation({
    summary: 'Delete a VJ pack',
    description:
      'Every clip of the pack stays in the library. The remaining packs keep their order.',
  })
  @ApiOkResponse({
    description: 'The deleted pack id and how many clips it held.',
  })
  @ApiNotFoundResponse({
    description:
      'Code `VJ_PACK_NOT_FOUND`: no pack has that id, or the id is not a uuid.',
  })
  deletePack(@Param('id') packId: string) {
    return this.library.deletePack(packId);
  }

  @Get('clips')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'List the VJ clips',
    description:
      'Every clip, newest first, with the packs that hold it, its playback defaults and its thumbnail and preview URLs.',
  })
  @ApiOkResponse({ description: 'The clips, newest first.' })
  listClips() {
    return this.library.listClips();
  }

  @Get('clips/media')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Get presigned URLs for listed VJ clips from any pack',
    description:
      'One item per listed clip that exists, in the order of `clipIds` (required, comma-separated uuids, 1 to 200), each with a presigned GET URL that lasts 900 seconds. An unknown id is left out. Checks: `VJ_CLIP_IDS_INVALID`.',
  })
  @ApiOkResponse({ description: 'The presigned URLs in the query order.' })
  @ApiBadRequestResponse({
    description:
      'Code `VJ_CLIP_IDS_INVALID`: `clipIds` is missing, empty, too long or holds a value that is not a uuid.',
  })
  getClipsMedia(@Query() query: VjClipsMediaQuery) {
    return this.library.getClipsMedia(query);
  }

  @Post('clips')
  @ApiOperation({
    summary: 'Create a VJ clip from two finished uploads',
    description:
      'The clip upload and the thumbnail upload come from `POST /uploads/presign` with the kinds `vj_clip` and `vj_thumbnail`. The server reads the type from the clip key, and the size from the stored object. Checks run in the order of the codes below. A refusal with `VJ_UPLOAD_FORMAT_MOV`, `VJ_UPLOAD_CONTENT_MISMATCH` or `VJ_UPLOAD_TOO_LARGE` also deletes both uploads. With `packId` the clip is appended to that pack in the same transaction.',
  })
  @ApiCreatedResponse({ description: 'The new clip.' })
  @ApiBadRequestResponse({
    description:
      'Code `VJ_CLIP_TITLE_REQUIRED`, `VJ_CLIP_TITLE_TOO_LONG`, `VJ_CLIP_KEY_INVALID`, `VJ_CLIP_DIMENSIONS_INVALID`, `VJ_CLIP_DURATION_INVALID`, `VJ_CLIP_FIT_MODE_INVALID`, `VJ_UPLOAD_FORMAT_MOV` or `VJ_UPLOAD_CONTENT_MISMATCH`.',
  })
  @ApiNotFoundResponse({
    description: 'Code `VJ_PACK_NOT_FOUND`: `packId` names no pack.',
  })
  @ApiPayloadTooLargeResponse({
    description: 'Code `VJ_UPLOAD_TOO_LARGE`: an upload is over its limit.',
  })
  @ApiConflictResponse({
    description:
      'Code `VJ_UPLOAD_MISSING`, `VJ_LIBRARY_FULL`, `VJ_CLIP_KEY_IN_USE` or `VJ_PACK_FULL`.',
  })
  createClip(
    @CurrentUser() user: CurrentUserData,
    @Body() body: CreateVjClipDto,
  ) {
    return this.library.createClip(user, body);
  }

  @Put('clips/:id/preview')
  @ApiOperation({
    summary: 'Store the animated preview of a VJ clip',
    description:
      'The preview upload comes from `POST /uploads/presign` with the kind `vj_preview`. Putting the current key again is a no-op, and a replaced older preview is deleted after the write. A refusal on the stored object deletes the upload when no clip holds it. Checks run in this order: `VJ_CLIP_NOT_FOUND` (malformed id), `VJ_CLIP_KEY_INVALID`, `VJ_UPLOAD_MISSING`, `VJ_UPLOAD_CONTENT_MISMATCH` (empty object), `VJ_UPLOAD_TOO_LARGE`, `VJ_UPLOAD_CONTENT_MISMATCH` (first bytes), `VJ_CLIP_NOT_FOUND`, `VJ_CLIP_KEY_IN_USE`.',
  })
  @ApiOkResponse({ description: 'The clip with its preview URL.' })
  @ApiBadRequestResponse({
    description: 'Code `VJ_CLIP_KEY_INVALID` or `VJ_UPLOAD_CONTENT_MISMATCH`.',
  })
  @ApiNotFoundResponse({
    description:
      'Code `VJ_CLIP_NOT_FOUND`: no clip has that id, or the id is not a uuid.',
  })
  @ApiPayloadTooLargeResponse({
    description: 'Code `VJ_UPLOAD_TOO_LARGE`: the preview is over 512 KB.',
  })
  @ApiConflictResponse({
    description: 'Code `VJ_UPLOAD_MISSING` or `VJ_CLIP_KEY_IN_USE`.',
  })
  setClipPreview(
    @Param('id') clipId: string,
    @Body() body: SetVjClipPreviewDto,
  ) {
    return this.library.setClipPreview(clipId, body);
  }

  @Patch('clips/:id')
  @ApiOperation({
    summary: 'Change the settings of a VJ clip',
    description:
      'Title, fit mode, favorite flag, default speed, loop mode and loop points are each optional, and an absent one is left as it is. An empty body answers the clip unchanged. Checks run in this order: `VJ_CLIP_NOT_FOUND` (malformed id), `VJ_CLIP_TITLE_REQUIRED`, `VJ_CLIP_TITLE_TOO_LONG`, `VJ_CLIP_FIT_MODE_INVALID`, `VJ_CLIP_FAVORITE_INVALID`, `VJ_CLIP_SPEED_INVALID`, `VJ_CLIP_LOOP_MODE_INVALID`, `VJ_CLIP_LOOP_INVALID`, `VJ_CLIP_NOT_FOUND`, `VJ_CLIP_LOOP_INVALID` (merged loop points).',
  })
  @ApiOkResponse({ description: 'The clip.' })
  @ApiBadRequestResponse({
    description:
      'Code `VJ_CLIP_TITLE_REQUIRED`, `VJ_CLIP_TITLE_TOO_LONG`, `VJ_CLIP_FIT_MODE_INVALID`, `VJ_CLIP_FAVORITE_INVALID`, `VJ_CLIP_SPEED_INVALID`, `VJ_CLIP_LOOP_MODE_INVALID` or `VJ_CLIP_LOOP_INVALID`.',
  })
  @ApiNotFoundResponse({
    description:
      'Code `VJ_CLIP_NOT_FOUND`: no clip has that id, or the id is not a uuid.',
  })
  updateClip(@Param('id') clipId: string, @Body() body: UpdateVjClipDto) {
    return this.library.updateClip(clipId, body);
  }

  @Delete('clips/:id')
  @ApiOperation({
    summary: 'Delete a VJ clip',
    description:
      'Removes the clip from every pack, clears it from every scene look that names it, and deletes its stored files.',
  })
  @ApiOkResponse({
    description: 'The deleted clip id and how many packs held it.',
  })
  @ApiNotFoundResponse({
    description:
      'Code `VJ_CLIP_NOT_FOUND`: no clip has that id, or the id is not a uuid.',
  })
  deleteClip(@Param('id') clipId: string) {
    return this.library.deleteClip(clipId);
  }

  @Get('events/upcoming')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'List the events a VJ pack may link to',
    description:
      'Published events listed to the public or to members that started at most 12 hours ago and have not ended, soonest first, at most 50.',
  })
  @ApiOkResponse({ description: 'The events, soonest first.' })
  listUpcomingEvents() {
    return this.eventLinks.listUpcomingEvents();
  }

  @Get('scenes')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'List the VJ scenes',
    description: 'Every scene in position order, each with its look.',
  })
  @ApiOkResponse({ description: 'The scenes in position order.' })
  listScenes() {
    return this.scenes.listScenes();
  }

  @Post('scenes')
  @ApiOperation({
    summary: 'Save a VJ scene',
    description:
      'Appends the scene after the last one. Scene names may repeat. Checks run in this order: `VJ_SCENE_NAME_REQUIRED`, `VJ_SCENE_NAME_TOO_LONG`, `VJ_PACK_NOT_FOUND` (malformed `packId`), `VJ_SCENE_LOOK_INVALID`, `VJ_PACK_NOT_FOUND`, `VJ_SCENE_CLIP_NOT_FOUND`, `VJ_SCENE_LIMIT_REACHED`.',
  })
  @ApiCreatedResponse({ description: 'The new scene.' })
  @ApiBadRequestResponse({
    description:
      'Code `VJ_SCENE_NAME_REQUIRED`, `VJ_SCENE_NAME_TOO_LONG` or `VJ_SCENE_LOOK_INVALID` (with the `lookField` that failed).',
  })
  @ApiNotFoundResponse({
    description: 'Code `VJ_PACK_NOT_FOUND` or `VJ_SCENE_CLIP_NOT_FOUND`.',
  })
  @ApiConflictResponse({
    description: 'Code `VJ_SCENE_LIMIT_REACHED`: the library holds 200 scenes.',
  })
  createScene(
    @CurrentUser() user: CurrentUserData,
    @Body() body: CreateVjSceneDto,
  ) {
    return this.scenes.createScene(user, body);
  }

  @Patch('scenes/reorder')
  @ApiOperation({
    summary: 'Reorder the VJ scenes',
    description:
      'The body lists every scene id exactly once, in the new order. Checks: `VJ_SCENE_REORDER_MISMATCH`.',
  })
  @ApiOkResponse({ description: 'The scenes in the new order.' })
  @ApiBadRequestResponse({
    description:
      'Code `VJ_SCENE_REORDER_MISMATCH`: the ids are not exactly the current scenes.',
  })
  reorderScenes(@Body() body: ReorderVjScenesDto) {
    return this.scenes.reorderScenes(body);
  }

  @Patch('scenes/:id')
  @ApiOperation({
    summary: 'Change a VJ scene',
    description:
      'Name, pack and look are each optional; an absent one stays and a present look replaces the stored one whole. An empty body answers the scene unchanged. Checks run in this order: `VJ_SCENE_NOT_FOUND` (malformed id), `VJ_SCENE_NAME_REQUIRED`, `VJ_SCENE_NAME_TOO_LONG`, `VJ_PACK_NOT_FOUND` (malformed `packId`), `VJ_SCENE_LOOK_INVALID`, `VJ_SCENE_NOT_FOUND`, `VJ_PACK_NOT_FOUND`, `VJ_SCENE_CLIP_NOT_FOUND`.',
  })
  @ApiOkResponse({ description: 'The scene.' })
  @ApiBadRequestResponse({
    description:
      'Code `VJ_SCENE_NAME_REQUIRED`, `VJ_SCENE_NAME_TOO_LONG` or `VJ_SCENE_LOOK_INVALID` (with the `lookField` that failed).',
  })
  @ApiNotFoundResponse({
    description:
      'Code `VJ_SCENE_NOT_FOUND`, `VJ_PACK_NOT_FOUND` or `VJ_SCENE_CLIP_NOT_FOUND`.',
  })
  updateScene(@Param('id') sceneId: string, @Body() body: UpdateVjSceneDto) {
    return this.scenes.updateScene(sceneId, body);
  }

  @Delete('scenes/:id')
  @ApiOperation({
    summary: 'Delete a VJ scene',
    description:
      'Removes the scene from every set list that holds it. The remaining scenes and set list items keep their order. Checks: `VJ_SCENE_NOT_FOUND`.',
  })
  @ApiOkResponse({
    description: 'The deleted scene id and how many set list items named it.',
  })
  @ApiNotFoundResponse({
    description:
      'Code `VJ_SCENE_NOT_FOUND`: no scene has that id, or the id is not a uuid.',
  })
  deleteScene(@Param('id') sceneId: string) {
    return this.scenes.deleteScene(sceneId);
  }

  @Get('setlists')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'List the VJ set lists',
    description: 'Every set list in position order, each with its scenes.',
  })
  @ApiOkResponse({ description: 'The set lists in position order.' })
  listSetlists() {
    return this.setlists.listSetlists();
  }

  @Post('setlists')
  @ApiOperation({
    summary: 'Create a VJ set list',
    description:
      'Appends the set list after the last one, with the scenes of `sceneIds` (optional, empty by default; a scene may appear more than once). Checks run in this order: `VJ_SETLIST_NAME_REQUIRED`, `VJ_SETLIST_NAME_TOO_LONG`, `VJ_SETLIST_ITEMS_INVALID`, `VJ_SETLIST_FULL`, `VJ_SETLIST_LIMIT_REACHED`, `VJ_SETLIST_NAME_TAKEN`, `VJ_SCENE_NOT_FOUND`.',
  })
  @ApiCreatedResponse({ description: 'The new set list.' })
  @ApiBadRequestResponse({
    description:
      'Code `VJ_SETLIST_NAME_REQUIRED`, `VJ_SETLIST_NAME_TOO_LONG` or `VJ_SETLIST_ITEMS_INVALID`.',
  })
  @ApiNotFoundResponse({ description: 'Code `VJ_SCENE_NOT_FOUND`.' })
  @ApiConflictResponse({
    description:
      'Code `VJ_SETLIST_FULL`, `VJ_SETLIST_LIMIT_REACHED` or `VJ_SETLIST_NAME_TAKEN` (the body names the set list holding the name).',
  })
  createSetlist(
    @CurrentUser() user: CurrentUserData,
    @Body() body: CreateVjSetlistDto,
  ) {
    return this.setlists.createSetlist(user, body);
  }

  @Patch('setlists/reorder')
  @ApiOperation({
    summary: 'Reorder the VJ set lists',
    description:
      'The body lists every set list id exactly once, in the new order. Checks: `VJ_SETLIST_REORDER_MISMATCH`.',
  })
  @ApiOkResponse({ description: 'The set lists in the new order.' })
  @ApiBadRequestResponse({
    description:
      'Code `VJ_SETLIST_REORDER_MISMATCH`: the ids are not exactly the current set lists.',
  })
  reorderSetlists(@Body() body: ReorderVjSetlistsDto) {
    return this.setlists.reorderSetlists(body);
  }

  @Put('setlists/:id/items')
  @ApiOperation({
    summary: 'Replace the scenes of a VJ set list',
    description:
      'The body lists the scenes in play order; a scene may appear more than once. Checks run in this order: `VJ_SETLIST_NOT_FOUND` (malformed id), `VJ_SETLIST_ITEMS_INVALID`, `VJ_SETLIST_FULL`, `VJ_SETLIST_NOT_FOUND`, `VJ_SCENE_NOT_FOUND`.',
  })
  @ApiOkResponse({ description: 'The set list with its new scenes.' })
  @ApiBadRequestResponse({ description: 'Code `VJ_SETLIST_ITEMS_INVALID`.' })
  @ApiNotFoundResponse({
    description: 'Code `VJ_SETLIST_NOT_FOUND` or `VJ_SCENE_NOT_FOUND`.',
  })
  @ApiConflictResponse({
    description: 'Code `VJ_SETLIST_FULL`: the list is over its scene limit.',
  })
  setSetlistItems(
    @Param('id') setlistId: string,
    @Body() body: SetVjSetlistItemsDto,
  ) {
    return this.setlists.setSetlistItems(setlistId, body);
  }

  @Patch('setlists/:id')
  @ApiOperation({
    summary: 'Rename a VJ set list',
    description:
      'An unchanged name is a no-op. Checks run in this order: `VJ_SETLIST_NOT_FOUND` (malformed id), `VJ_SETLIST_NAME_REQUIRED`, `VJ_SETLIST_NAME_TOO_LONG`, `VJ_SETLIST_NOT_FOUND`, `VJ_SETLIST_NAME_TAKEN`.',
  })
  @ApiOkResponse({ description: 'The set list.' })
  @ApiBadRequestResponse({
    description:
      'Code `VJ_SETLIST_NAME_REQUIRED` or `VJ_SETLIST_NAME_TOO_LONG`.',
  })
  @ApiNotFoundResponse({ description: 'Code `VJ_SETLIST_NOT_FOUND`.' })
  @ApiConflictResponse({ description: 'Code `VJ_SETLIST_NAME_TAKEN`.' })
  renameSetlist(
    @Param('id') setlistId: string,
    @Body() body: RenameVjSetlistDto,
  ) {
    return this.setlists.renameSetlist(setlistId, body);
  }

  @Delete('setlists/:id')
  @ApiOperation({
    summary: 'Delete a VJ set list',
    description:
      'Every scene of the set list stays in the library. The remaining set lists keep their order. Checks: `VJ_SETLIST_NOT_FOUND`.',
  })
  @ApiOkResponse({ description: 'The deleted set list id.' })
  @ApiNotFoundResponse({
    description:
      'Code `VJ_SETLIST_NOT_FOUND`: no set list has that id, or the id is not a uuid.',
  })
  deleteSetlist(@Param('id') setlistId: string) {
    return this.setlists.deleteSetlist(setlistId);
  }
}
