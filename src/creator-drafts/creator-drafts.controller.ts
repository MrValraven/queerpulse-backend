import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
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
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { CreatorDraftsService } from './creator-drafts.service';
import type {
  CreatorDraftResponse,
  CreatorDraftSaved,
} from './creator-draft.types';
import { SaveCreatorDraftDto } from './dto/save-creator-draft.dto';

const CONFLICT_DESCRIPTION =
  'The draft changed in another tab or device (creator_draft_revision_conflict); the body carries the live revision and saved time, or nulls for an empty slot.';
const TOO_LARGE_DESCRIPTION =
  'The payload is over 96 KiB (creator_draft_too_large).';

/**
 * The creator's own draft slots: the event wizard, Start a Community and the
 * listing editor. Every route reads and writes the caller's own slot only.
 * The request log, metrics, Sentry and feature usage skip the whole
 * `/me/creator-drafts` prefix, so no payload leaves through them. Each route
 * carries its kind's `@Feature`, so a kind whose feature is off answers the
 * guard's plain 404.
 */
@ApiTags('Creator drafts')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Not an active member.' })
@Controller('me/creator-drafts')
@UseGuards(ActiveMemberGuard)
export class CreatorDraftsController {
  constructor(private readonly creatorDrafts: CreatorDraftsService) {}

  @ApiOperation({ summary: "Read the caller's event wizard draft." })
  @ApiOkResponse({ description: 'The draft, or null for an empty slot.' })
  @Feature('events')
  @Get('event')
  getEventDraft(
    @CurrentUser() user: CurrentUserData,
  ): Promise<{ draft: CreatorDraftResponse | null }> {
    return this.creatorDrafts.getDraft(user.userId, { kind: 'event' });
  }

  @ApiOperation({ summary: "Save the caller's event wizard draft." })
  @ApiOkResponse({ description: 'The new revision and saved time.' })
  @ApiBadRequestResponse({ description: 'The body failed validation.' })
  @ApiConflictResponse({ description: CONFLICT_DESCRIPTION })
  @ApiPayloadTooLargeResponse({ description: TOO_LARGE_DESCRIPTION })
  @Feature('events')
  @Put('event')
  saveEventDraft(
    @CurrentUser() user: CurrentUserData,
    @Body() body: SaveCreatorDraftDto,
  ): Promise<CreatorDraftSaved> {
    return this.creatorDrafts.saveDraft(user.userId, { kind: 'event' }, body);
  }

  @ApiOperation({ summary: "Delete the caller's event wizard draft." })
  @ApiNoContentResponse({ description: 'The slot is empty.' })
  @Feature('events')
  @Delete('event')
  @HttpCode(HttpStatus.NO_CONTENT)
  discardEventDraft(@CurrentUser() user: CurrentUserData): Promise<void> {
    return this.creatorDrafts.discardDraft(user.userId, { kind: 'event' });
  }

  @ApiOperation({ summary: "Read the caller's Start a Community draft." })
  @ApiOkResponse({ description: 'The draft, or null for an empty slot.' })
  @Feature('communities')
  @Get('community')
  getCommunityDraft(
    @CurrentUser() user: CurrentUserData,
  ): Promise<{ draft: CreatorDraftResponse | null }> {
    return this.creatorDrafts.getDraft(user.userId, { kind: 'community' });
  }

  @ApiOperation({ summary: "Save the caller's Start a Community draft." })
  @ApiOkResponse({ description: 'The new revision and saved time.' })
  @ApiBadRequestResponse({ description: 'The body failed validation.' })
  @ApiConflictResponse({ description: CONFLICT_DESCRIPTION })
  @ApiPayloadTooLargeResponse({ description: TOO_LARGE_DESCRIPTION })
  @Feature('communities')
  @Put('community')
  saveCommunityDraft(
    @CurrentUser() user: CurrentUserData,
    @Body() body: SaveCreatorDraftDto,
  ): Promise<CreatorDraftSaved> {
    return this.creatorDrafts.saveDraft(
      user.userId,
      { kind: 'community' },
      body,
    );
  }

  @ApiOperation({ summary: "Delete the caller's Start a Community draft." })
  @ApiNoContentResponse({ description: 'The slot is empty.' })
  @Feature('communities')
  @Delete('community')
  @HttpCode(HttpStatus.NO_CONTENT)
  discardCommunityDraft(@CurrentUser() user: CurrentUserData): Promise<void> {
    return this.creatorDrafts.discardDraft(user.userId, { kind: 'community' });
  }

  @ApiOperation({ summary: "Read the caller's draft edit of one listing." })
  @ApiOkResponse({ description: 'The draft, or null for an empty slot.' })
  @ApiNotFoundResponse({
    description:
      'The caller cannot edit this listing (creator_draft_listing_unavailable).',
  })
  @Feature('listings')
  @Get('listing-edit/:listingRef')
  getListingEditDraft(
    @CurrentUser() user: CurrentUserData,
    @Param('listingRef') listingRef: string,
  ): Promise<{ draft: CreatorDraftResponse | null }> {
    return this.creatorDrafts.getDraft(user.userId, {
      kind: 'listing_edit',
      listingRef,
    });
  }

  @ApiOperation({ summary: "Save the caller's draft edit of one listing." })
  @ApiOkResponse({ description: 'The new revision and saved time.' })
  @ApiBadRequestResponse({ description: 'The body failed validation.' })
  @ApiNotFoundResponse({
    description:
      'The caller cannot edit this listing (creator_draft_listing_unavailable).',
  })
  @ApiConflictResponse({ description: CONFLICT_DESCRIPTION })
  @ApiPayloadTooLargeResponse({ description: TOO_LARGE_DESCRIPTION })
  @Feature('listings')
  @Put('listing-edit/:listingRef')
  saveListingEditDraft(
    @CurrentUser() user: CurrentUserData,
    @Param('listingRef') listingRef: string,
    @Body() body: SaveCreatorDraftDto,
  ): Promise<CreatorDraftSaved> {
    return this.creatorDrafts.saveDraft(
      user.userId,
      { kind: 'listing_edit', listingRef },
      body,
    );
  }

  @ApiOperation({ summary: "Delete the caller's draft edit of one listing." })
  @ApiNoContentResponse({ description: 'The slot is empty.' })
  @ApiNotFoundResponse({
    description:
      'The listing ref is malformed or unknown (creator_draft_listing_unavailable).',
  })
  @Feature('listings')
  @Delete('listing-edit/:listingRef')
  @HttpCode(HttpStatus.NO_CONTENT)
  discardListingEditDraft(
    @CurrentUser() user: CurrentUserData,
    @Param('listingRef') listingRef: string,
  ): Promise<void> {
    return this.creatorDrafts.discardDraft(user.userId, {
      kind: 'listing_edit',
      listingRef,
    });
  }
}
