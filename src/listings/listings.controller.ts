import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Feature } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AskListingQuestionDto } from './dto/ask-listing-question.dto';
import { CreateListingDto } from './dto/create-listing.dto';
import { ListEditSuggestionsQuery } from './dto/list-edit-suggestions.query';
import { ListListingQueueQuery } from './dto/list-listing-queue.query';
import { ListMyListingsQuery } from './dto/list-my-listings.query';
import { ReplyToReviewDto } from './dto/reply-to-review.dto';
import { ResolveEditSuggestionDto } from './dto/resolve-edit-suggestion.dto';
import { UpdateListingStatusDto } from './dto/update-listing-status.dto';
import { UpdateListingDto } from './dto/update-listing.dto';
import { UpdateSafeSpaceDto } from './dto/update-safe-space.dto';
import { ListingEditSuggestionsService } from './listing-edit-suggestions.service';
import { ListingsService } from './listings.service';
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

/**
 * Member business directory listings (spec §3 Tier 4 "listings"). Every
 * route but `setStatus` is owner-gated: `GET/PATCH/DELETE /listings/:ref`
 * are the caller's own submission-tracking view (403 for a non-owner ref),
 * not a public directory browse. FE: `listings.api.ts`.
 *
 * `mine` is declared before `:ref` so Nest/Express's route matching resolves
 * `GET /listings/mine` as the literal segment rather than the `:ref` param
 * (mirrors every other domain's "static path before dynamic param" ordering).
 */
@Feature('listings')
@ApiTags('Listings')
@ApiCookieAuth()
@Controller('listings')
@UseGuards(ActiveMemberGuard)
export class ListingsController {
  constructor(
    private readonly listingsService: ListingsService,
    private readonly editSuggestionsService: ListingEditSuggestionsService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a business listing for the current member' })
  @ApiCreatedResponse({ description: 'The newly created listing.' })
  @ApiConflictResponse({ description: 'Could not allocate a unique listing reference.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateListingDto) {
    return this.listingsService.create(user.userId, dto);
  }

  @Get('mine')
  @ApiOperation({ summary: "List the current member's own listings" })
  @ApiOkResponse({ description: "Paginated page of the member's listings." })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  listMine(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListMyListingsQuery,
  ) {
    return this.listingsService.listMine(user.userId, query);
  }

  // Moderator-only, same rationale as `setStatus` below. Declared before
  // `:ref` (mirrors `mine`'s ordering) so Nest's route matching resolves the
  // literal `admin/safe-space-candidates` segment rather than the `:ref`
  // param, even though the two-segment path wouldn't actually collide with
  // any single-segment `:ref` route.
  @Get('admin/safe-space-candidates')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  @ApiOperation({ summary: 'List safe-space candidate listings (moderator only)' })
  @ApiOkResponse({ description: 'The candidate listings.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  listSafeSpaceCandidates() {
    return this.listingsService.listSafeSpaceCandidates();
  }

  // Moderator-only: the listings moderation queue (FE AdminListingsPage).
  // Declared before `:ref` so Nest resolves the literal `admin/queue`
  // segment rather than the `:ref` param (mirrors `mine` / the safe-space
  // candidates route ordering).
  @Get('admin/queue')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  @ApiOperation({ summary: 'List the listings moderation queue (moderator only)' })
  @ApiOkResponse({ description: 'Paginated page of queued listings.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  listQueue(@Query() query: ListListingQueueQuery) {
    return this.listingsService.listQueue(query);
  }

  // Moderator-only: the "suggest an edit" review queue. Submission itself is
  // NOT a route on this controller — it's slug-keyed and lives on the public
  // `DirectoryController` (`POST /directory/:slug/edit-suggestions`), since a
  // non-owner submitter never has this listing's `ref` (see
  // `ListingEditSuggestionsService.submit`'s doc comment). Declared before
  // `:ref`, mirroring `admin/queue`'s ordering rationale above.
  @Get('admin/edit-suggestions')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  @ApiOperation({ summary: 'List the edit-suggestion review queue (moderator only)' })
  @ApiOkResponse({ description: 'The edit suggestions, newest first.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  listEditSuggestions(@Query() query: ListEditSuggestionsQuery) {
    return this.editSuggestionsService.listForAdmin(query);
  }

  // Moderator-only: accept or dismiss a pending edit suggestion.
  @Patch('admin/edit-suggestions/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  @ApiOperation({ summary: 'Accept or dismiss an edit suggestion (moderator only)' })
  @ApiOkResponse({ description: 'The resolved edit suggestion.' })
  @ApiNotFoundResponse({ description: 'No edit suggestion or listing found.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  resolveEditSuggestion(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() dto: ResolveEditSuggestionDto,
  ) {
    return this.editSuggestionsService.resolve(id, user.userId, dto);
  }

  @Get(':ref')
  @ApiOperation({ summary: "Get one of the member's own listings by reference" })
  @ApiOkResponse({ description: 'The listing owned by the caller.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  @ApiForbiddenResponse({ description: 'The listing is not owned by the caller.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  get(@CurrentUser() user: CurrentUserData, @Param('ref') ref: string) {
    return this.listingsService.getByRef(ref, user.userId);
  }

  @Patch(':ref')
  @ApiOperation({ summary: "Update one of the member's own listings" })
  @ApiOkResponse({ description: 'The updated listing.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  @ApiForbiddenResponse({ description: 'The listing is not owned by the caller.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: UpdateListingDto,
  ) {
    return this.listingsService.update(ref, user.userId, dto);
  }

  @Delete(':ref')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete one of the member's own listings" })
  @ApiNoContentResponse({ description: 'The listing was deleted.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  @ApiForbiddenResponse({ description: 'The listing is not owned by the caller.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  remove(@CurrentUser() user: CurrentUserData, @Param('ref') ref: string) {
    return this.listingsService.remove(ref, user.userId);
  }

  // Owner-gated (same `assertOwner` check as `update`/`remove`/`getByRef`
  // above, not a `RolesGuard` route): the listing owner posts (or overwrites)
  // their single public reply to a review on their own listing.
  @Patch(':ref/reviews/:reviewId/reply')
  @ApiOperation({ summary: "Post or overwrite the owner's public reply to a review" })
  @ApiOkResponse({ description: 'The review with the updated owner reply.' })
  @ApiNotFoundResponse({ description: 'No listing or review found.' })
  @ApiForbiddenResponse({ description: 'The listing is not owned by the caller.' })
  @ApiBadRequestResponse({ description: 'Reply cannot be empty.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  replyToReview(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Param('reviewId') reviewId: string,
    @Body() dto: ReplyToReviewDto,
  ) {
    return this.listingsService.replyToReview(ref, user.userId, reviewId, dto);
  }

  // Moderator-only: the FE's `setListingStatus` comment is explicit that
  // this is "NOT called from the member client" — only the moderation
  // surface transitions a listing's status, so this route layers
  // `RolesGuard` on top of the controller's `ActiveMemberGuard`.
  @Patch(':ref/status')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  @ApiOperation({ summary: "Set a listing's moderation status (moderator only)" })
  @ApiOkResponse({ description: 'The updated listing.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  setStatus(@Param('ref') ref: string, @Body() dto: UpdateListingStatusDto) {
    return this.listingsService.setStatus(ref, dto.status);
  }

  // Moderator-only: ask the submitter a question. Sends the text as a DM and
  // moves the listing to `question` status (see `ListingsService.askQuestion`).
  @Post(':ref/question')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  @ApiOperation({ summary: 'Ask the submitter a question via DM (moderator only)' })
  @ApiCreatedResponse({ description: 'The listing moved to question status.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  @ApiBadRequestResponse({ description: 'This listing has no submitter to contact.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role, or the message was blocked.' })
  askQuestion(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: AskListingQuestionDto,
  ) {
    return this.listingsService.askQuestion(ref, user.userId, dto.body);
  }

  // Moderator-only, same rationale as `setStatus` above — only the
  // moderation surface toggles a listing's safe-space badge.
  @Patch(':ref/safe-space')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  @ApiOperation({ summary: "Toggle a listing's safe-space badge (moderator only)" })
  @ApiOkResponse({ description: 'The updated listing.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  setSafeSpace(@Param('ref') ref: string, @Body() dto: UpdateSafeSpaceDto) {
    return this.listingsService.setSafeSpace(ref, dto);
  }
}
