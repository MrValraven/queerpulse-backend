import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
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
  RenameVjPackDto,
  ReorderVjPackClipsDto,
  ReorderVjPacksDto,
  UpdateVjClipDto,
  VjPackMediaQuery,
} from './dto/vj.dto';
import { VjLibraryService } from './vj-library.service';

/**
 * The admin routes of the VJ library: ordered packs of clips, and the clips
 * themselves (MP4, WebM and GIF).
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
 *   POST   admin/vj/packs/:id/clips              add a clip to a pack
 *   PATCH  admin/vj/packs/:id/clips/reorder      set the order of a pack
 *   DELETE admin/vj/packs/:id/clips/:clipId      remove a clip from a pack
 *   PATCH  admin/vj/packs/:id                    rename a pack
 *   DELETE admin/vj/packs/:id                    delete a pack
 *   GET    admin/vj/clips                        list clips
 *   POST   admin/vj/clips                        create a clip from two uploads
 *   PATCH  admin/vj/clips/:id                    rename a clip or set its fit
 *   DELETE admin/vj/clips/:id                    delete a clip
 *
 * The literal `packs/reorder` route is declared before the `packs/:id` routes
 * so Nest matches the literal.
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
  constructor(private readonly library: VjLibraryService) {}

  @Get('packs')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'List the VJ packs',
    description:
      'Every pack in position order, with its clip count, total size and the thumbnail of its first clip.',
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
      'Every clip, newest first, with the packs that hold it and a thumbnail and preview URL.',
  })
  @ApiOkResponse({ description: 'The clips, newest first.' })
  listClips() {
    return this.library.listClips();
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

  @Patch('clips/:id')
  @ApiOperation({
    summary: 'Rename a VJ clip or change how it fits the screen',
    description:
      'Both `title` and `fitMode` are optional and an absent one is left as it is. An empty body answers the clip unchanged.',
  })
  @ApiOkResponse({ description: 'The clip.' })
  @ApiBadRequestResponse({
    description:
      'Code `VJ_CLIP_TITLE_REQUIRED`, `VJ_CLIP_TITLE_TOO_LONG` or `VJ_CLIP_FIT_MODE_INVALID`.',
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
      'Removes the clip from every pack and deletes both stored files.',
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
}
