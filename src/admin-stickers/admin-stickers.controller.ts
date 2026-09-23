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
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { StickerResponse } from '../stickers/sticker-response';
import {
  AdminStickersService,
  AdminStickerPackResponse,
} from './admin-stickers.service';
import { CreateStickerDto } from './dto/create-sticker.dto';
import { CreateStickerPackDto } from './dto/create-sticker-pack.dto';
import { ReorderStickersDto } from './dto/reorder-stickers.dto';
import { UpdateStickerPackDto } from './dto/update-sticker-pack.dto';

/**
 * Guarded CRUD for the sticker catalogue, in this codebase's convention of a
 * dedicated `Admin*Controller` in its own `admin-*` module for an authoring
 * surface. This is what the Sticker Pack Builder page calls; the member-facing
 * picker reads through `StickersController` instead.
 *
 * Admin-only. There is no Editor role, and curating platform artwork every
 * member sees in every conversation is not something to delegate more widely.
 *
 *   GET    /admin/sticker-packs                              -> AdminStickerPackResponse[]  (every status)
 *   POST   /admin/sticker-packs                               -> AdminStickerPackResponse
 *   PATCH  /admin/sticker-packs/:packId                       -> AdminStickerPackResponse
 *   POST   /admin/sticker-packs/:packId/stickers               -> StickerResponse
 *   DELETE /admin/sticker-packs/:packId/stickers/:stickerId    -> 204
 *   POST   /admin/sticker-packs/:packId/stickers/reorder        -> AdminStickerPackResponse
 */
@ApiTags('Admin Stickers')
@ApiCookieAuth('access_token')
@Controller('admin/sticker-packs')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
export class AdminStickersController {
  constructor(private readonly adminStickers: AdminStickersService) {}

  @Get()
  @ApiOperation({
    summary: 'List every sticker pack, every status included.',
  })
  @ApiOkResponse({ description: 'The full sticker pack catalogue.' })
  list(): Promise<AdminStickerPackResponse[]> {
    return this.adminStickers.listPacks();
  }

  @Post()
  @ApiOperation({ summary: 'Create a sticker pack.' })
  @ApiCreatedResponse({ description: 'The created pack, starting as draft.' })
  @ApiBadRequestResponse({
    description: 'Malformed slug, name or description.',
  })
  @ApiConflictResponse({ description: 'That pack slug is taken.' })
  createPack(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateStickerPackDto,
  ): Promise<AdminStickerPackResponse> {
    return this.adminStickers.createPack(dto, user.userId);
  }

  @Patch(':packId')
  @ApiOperation({
    summary: "Edit a pack's name, description, status, order or cover.",
  })
  @ApiOkResponse({ description: 'The updated pack.' })
  @ApiBadRequestResponse({
    description:
      'Malformed body, an empty pack being published, or a cover that is not a sticker in this pack.',
  })
  @ApiNotFoundResponse({ description: 'No pack with that id.' })
  updatePack(
    @Param('packId', ParseUUIDPipe) packId: string,
    @Body() dto: UpdateStickerPackDto,
  ): Promise<AdminStickerPackResponse> {
    return this.adminStickers.updatePack(packId, dto);
  }

  @Post(':packId/stickers')
  @ApiOperation({ summary: 'Add a sticker to a pack.' })
  @ApiCreatedResponse({ description: 'The created sticker.' })
  @ApiBadRequestResponse({
    description:
      'Malformed body, or a storage key that is not this admin’s own sticker upload.',
  })
  @ApiConflictResponse({
    description: 'That sticker slug is taken in this pack.',
  })
  @ApiNotFoundResponse({ description: 'No pack with that id.' })
  addSticker(
    @CurrentUser() user: CurrentUserData,
    @Param('packId', ParseUUIDPipe) packId: string,
    @Body() dto: CreateStickerDto,
  ): Promise<StickerResponse> {
    return this.adminStickers.addSticker(packId, dto, user.userId);
  }

  @Delete(':packId/stickers/:stickerId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a sticker from a pack.' })
  @ApiNoContentResponse({ description: 'The sticker is gone.' })
  @ApiNotFoundResponse({ description: 'No sticker with that id in that pack.' })
  removeSticker(
    @Param('packId', ParseUUIDPipe) packId: string,
    @Param('stickerId', ParseUUIDPipe) stickerId: string,
  ): Promise<void> {
    return this.adminStickers.removeSticker(packId, stickerId);
  }

  @Post(':packId/stickers/reorder')
  @ApiOperation({
    summary: 'Set the display order of every sticker in a pack.',
  })
  @ApiOkResponse({ description: 'The pack with its stickers reordered.' })
  @ApiBadRequestResponse({
    description: 'The payload does not list every sticker in the pack.',
  })
  @ApiNotFoundResponse({ description: 'No pack with that id.' })
  reorderStickers(
    @Param('packId', ParseUUIDPipe) packId: string,
    @Body() dto: ReorderStickersDto,
  ): Promise<AdminStickerPackResponse> {
    return this.adminStickers.reorderStickers(packId, dto);
  }
}
