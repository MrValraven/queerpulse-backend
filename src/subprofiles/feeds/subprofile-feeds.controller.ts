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
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../../auth/guards/not-restricted.guard';
import { Feature } from '../../common/feature.decorator';
import { ConnectFeedDTO } from './dto/connect-feed.dto';
import {
  FeedEntryIdsDTO,
  PublishFeedEntriesDTO,
} from './dto/feed-entry-ids.dto';
import { ListFeedEntriesQuery } from './dto/list-feed-entries.query';
import { PreviewFeedDTO } from './dto/preview-feed.dto';
import { UpdateFeedDTO } from './dto/update-feed.dto';
import { FeedImportThrottlerGuard } from './feed-import-throttler.guard';
import {
  FeedEntryDTO,
  FeedPreviewDTO,
  PublishFeedEntriesResponse,
  SubprofileFeedDTO,
} from './feed-response';
import { SubprofileFeedsService } from './subprofile-feeds.service';

const FEED_ERROR_DESCRIPTION =
  '`{ code }` where code is one of `unreachable`, `timeout`, `http_error`, `too_large`, `not_a_feed`: the feed could not be read.';
const MEMBER_ONLY = 'Not a member (creator or co-owner) of this persona.';

/**
 * Persona podcast-feed import (shared API contract v1). Every `:id` route is
 * gated on membership of the persona (creator or accepted co-owner) by the
 * service, the same `getOwned` check every persona editor write uses.
 *
 * Guards: `ActiveMemberGuard` for the whole class (as `SubprofilesController`);
 * `NotRestrictedGuard` on the writes that can put content in front of other
 * members (connect and PATCH can turn on auto-publish, sync can auto-publish,
 * publish does); `FeedImportThrottlerGuard`, one per-member bucket, on the
 * three routes that make an outbound fetch (preview, connect, sync). Dismiss,
 * restore and disconnect only take things away, so a restriction leaves them
 * open.
 *
 * Mounted under `subprofiles` beside `SubprofilesController`. The one literal
 * route (`feeds/preview`) has two segments, so no `:id` route there can
 * capture it.
 */
@ApiTags('Subprofiles')
@ApiCookieAuth()
@Feature('personaFeedImport')
@UseGuards(ActiveMemberGuard)
@Controller('subprofiles')
export class SubprofileFeedsController {
  constructor(private readonly feedsService: SubprofileFeedsService) {}

  @Post('feeds/preview')
  @HttpCode(HttpStatus.OK)
  @UseGuards(FeedImportThrottlerGuard)
  @ApiOperation({ summary: 'Preview a podcast RSS feed before connecting it' })
  @ApiOkResponse({ description: 'The show and its newest five episodes.' })
  @ApiBadRequestResponse({ description: 'Not an http(s) URL.' })
  @ApiForbiddenResponse({ description: MEMBER_ONLY })
  @ApiUnprocessableEntityResponse({ description: FEED_ERROR_DESCRIPTION })
  @ApiTooManyRequestsResponse({ description: 'Too many feed fetches.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  preview(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: PreviewFeedDTO,
  ): Promise<FeedPreviewDTO> {
    return this.feedsService.preview(user.userId, dto.url, dto.subprofileId);
  }

  @Get(':id/feeds')
  @ApiOperation({ summary: 'List the podcast feeds connected to a persona' })
  @ApiOkResponse({ description: 'The connected feeds.' })
  @ApiForbiddenResponse({ description: MEMBER_ONLY })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  list(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SubprofileFeedDTO[]> {
    return this.feedsService.list(user.userId, id);
  }

  @Post(':id/feeds')
  @UseGuards(NotRestrictedGuard, FeedImportThrottlerGuard)
  @ApiOperation({ summary: 'Connect a podcast RSS feed to a persona' })
  @ApiCreatedResponse({ description: 'The connected feed.' })
  @ApiBadRequestResponse({
    description:
      'Not an http(s) URL, or a section the persona kind cannot import into.',
  })
  @ApiForbiddenResponse({ description: MEMBER_ONLY })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiConflictResponse({
    description: '`{ code: "FEED_ALREADY_CONNECTED" }`.',
  })
  @ApiUnprocessableEntityResponse({
    description: `\`{ code: "FEED_LIMIT" }\` (three feeds per persona), or ${FEED_ERROR_DESCRIPTION}`,
  })
  @ApiTooManyRequestsResponse({ description: 'Too many feed fetches.' })
  connect(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConnectFeedDTO,
  ): Promise<SubprofileFeedDTO> {
    return this.feedsService.connect(user.userId, id, dto);
  }

  @Patch(':id/feeds/:feedId')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: 'Change a connected feed’s section or auto-publish',
  })
  @ApiOkResponse({ description: 'The updated feed.' })
  @ApiBadRequestResponse({
    description: 'A section the persona kind cannot import into.',
  })
  @ApiForbiddenResponse({ description: MEMBER_ONLY })
  @ApiNotFoundResponse({ description: 'No such persona or feed.' })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('feedId', ParseUUIDPipe) feedId: string,
    @Body() dto: UpdateFeedDTO,
  ): Promise<SubprofileFeedDTO> {
    return this.feedsService.update(user.userId, id, feedId, dto);
  }

  @Delete(':id/feeds/:feedId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Disconnect a feed (published items stay; pending and dismissed entries are deleted)',
  })
  @ApiNoContentResponse({ description: 'Disconnected.' })
  @ApiForbiddenResponse({ description: MEMBER_ONLY })
  @ApiNotFoundResponse({ description: 'No such persona or feed.' })
  async remove(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('feedId', ParseUUIDPipe) feedId: string,
  ): Promise<void> {
    await this.feedsService.remove(user.userId, id, feedId);
  }

  @Post(':id/feeds/:feedId/sync')
  @HttpCode(HttpStatus.OK)
  @UseGuards(NotRestrictedGuard, FeedImportThrottlerGuard)
  @ApiOperation({ summary: 'Check a connected feed for new episodes now' })
  @ApiOkResponse({
    description:
      'The feed after the check. A feed that could not be read reports it in `lastError`.',
  })
  @ApiForbiddenResponse({ description: MEMBER_ONLY })
  @ApiNotFoundResponse({ description: 'No such persona or feed.' })
  @ApiTooManyRequestsResponse({
    description:
      '`{ code: "SYNC_TOO_SOON", retryAfterSeconds }`: checked less than five minutes ago (or too many feed fetches).',
  })
  sync(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('feedId', ParseUUIDPipe) feedId: string,
  ): Promise<SubprofileFeedDTO> {
    return this.feedsService.syncNow(user.userId, id, feedId);
  }

  @Get(':id/feeds/:feedId/entries')
  @ApiOperation({ summary: 'List a feed’s episodes, newest first (max 500)' })
  @ApiOkResponse({ description: 'The feed’s entries.' })
  @ApiForbiddenResponse({ description: MEMBER_ONLY })
  @ApiNotFoundResponse({ description: 'No such persona or feed.' })
  listEntries(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('feedId', ParseUUIDPipe) feedId: string,
    @Query() query: ListFeedEntriesQuery,
  ): Promise<FeedEntryDTO[]> {
    return this.feedsService.listEntries(user.userId, id, feedId, query.status);
  }

  @Post(':id/feeds/:feedId/entries/publish')
  @HttpCode(HttpStatus.OK)
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: 'Publish pending episodes to the top of the feed’s section',
  })
  @ApiOkResponse({
    description:
      '`{ published, skipped, subprofile }`. Publishing bumps the persona editVersion; adopt the returned subprofile.',
  })
  @ApiForbiddenResponse({ description: MEMBER_ONLY })
  @ApiNotFoundResponse({ description: 'No such persona or feed.' })
  @ApiConflictResponse({
    description: '`{ code: "PERSONA_EDIT_CONFLICT", currentEditVersion }`.',
  })
  @ApiUnprocessableEntityResponse({
    description: '`{ code: "SECTION_FULL" }`: the section has no room left.',
  })
  publish(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('feedId', ParseUUIDPipe) feedId: string,
    @Body() dto: PublishFeedEntriesDTO,
  ): Promise<PublishFeedEntriesResponse> {
    return this.feedsService.publish(
      user.userId,
      id,
      feedId,
      dto.entryIds,
      dto.expectedEditVersion,
    );
  }

  @Post(':id/feeds/:feedId/entries/dismiss')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dismiss pending episodes' })
  @ApiOkResponse({ description: '`{ dismissed }`.' })
  @ApiForbiddenResponse({ description: MEMBER_ONLY })
  @ApiNotFoundResponse({ description: 'No such persona or feed.' })
  dismiss(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('feedId', ParseUUIDPipe) feedId: string,
    @Body() dto: FeedEntryIdsDTO,
  ): Promise<{ dismissed: number }> {
    return this.feedsService.dismiss(user.userId, id, feedId, dto.entryIds);
  }

  @Post(':id/feeds/:feedId/entries/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move dismissed episodes back to pending' })
  @ApiOkResponse({ description: '`{ restored }`.' })
  @ApiForbiddenResponse({ description: MEMBER_ONLY })
  @ApiNotFoundResponse({ description: 'No such persona or feed.' })
  restore(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('feedId', ParseUUIDPipe) feedId: string,
    @Body() dto: FeedEntryIdsDTO,
  ): Promise<{ restored: number }> {
    return this.feedsService.restore(user.userId, id, feedId, dto.entryIds);
  }
}
