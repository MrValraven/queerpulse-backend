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
import { Throttle, seconds } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Feature } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AnswerListingQuestionDto } from './dto/answer-listing-question.dto';
import { AskListingQuestionDto } from './dto/ask-listing-question.dto';
import { BulkRemoveDto, BulkStatusDto } from './dto/bulk-listing.dto';
import { CreateListingClaimDto } from './dto/create-listing-claim.dto';
import { CreateListingDto } from './dto/create-listing.dto';
import { DisputeListingDto } from './dto/dispute-listing.dto';
import { ReviewListingClaimDto } from './dto/review-listing-claim.dto';
import { SimilarListingsQuery } from './dto/similar-listings.query';
import { ListEditSuggestionsQuery } from './dto/list-edit-suggestions.query';
import { ListListingQueueQuery } from './dto/list-listing-queue.query';
import { ListMyListingsQuery } from './dto/list-my-listings.query';
import { RemoveListingDto } from './dto/remove-listing.dto';
import { ReplyToReviewDto } from './dto/reply-to-review.dto';
import { ResolveEditSuggestionDto } from './dto/resolve-edit-suggestion.dto';
import { UpdateListingStatusDto } from './dto/update-listing-status.dto';
import { UpdateListingDto } from './dto/update-listing.dto';
import { UpdateQueerOwnedVerifiedDto } from './dto/update-queer-owned-verified.dto';
import { UpdateSafeSpaceDto } from './dto/update-safe-space.dto';
import { ListingClaimsService } from './listing-claims.service';
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
    private readonly listingClaimsService: ListingClaimsService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a business listing for the current member' })
  @ApiCreatedResponse({ description: 'The newly created listing.' })
  @ApiConflictResponse({
    description: 'Could not allocate a unique listing reference.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateListingDto) {
    return this.listingsService.create(user.userId, dto);
  }

  @Get('mine')
  @ApiOperation({ summary: "List the current member's own listings" })
  @ApiOkResponse({ description: "Paginated page of the member's listings." })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  listMine(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListMyListingsQuery,
  ) {
    return this.listingsService.listMine(user.userId, query);
  }

  // Live dedupe search for the wizard (item #5): up to five live listings
  // matching the typed name or sitting within ~150m of a resolved pin.
  // Declared before `:ref` so Nest resolves the literal `similar` segment
  // rather than treating it as a `:ref` value.
  @Get('similar')
  @Throttle({ default: { limit: 40, ttl: seconds(60) } })
  @ApiOperation({
    summary: 'Find near-duplicate listings by name or proximity',
  })
  @ApiOkResponse({ description: 'Up to five similar listings.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  findSimilar(@Query() query: SimilarListingsQuery) {
    return this.listingsService.findSimilar(query.name, query.lat, query.lng);
  }

  // Moderator-only, same rationale as `setStatus` below. Declared before
  // `:ref` (mirrors `mine`'s ordering) so Nest's route matching resolves the
  // literal `admin/safe-space-candidates` segment rather than the `:ref`
  // param, even though the two-segment path wouldn't actually collide with
  // any single-segment `:ref` route.
  @Get('admin/safe-space-candidates')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  @ApiOperation({
    summary: 'List safe-space candidate listings (moderator only)',
  })
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
  @ApiOperation({
    summary: 'List the listings moderation queue (moderator only)',
  })
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
  @ApiOperation({
    summary: 'List the edit-suggestion review queue (moderator only)',
  })
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
  @ApiOperation({
    summary: 'Accept or dismiss an edit suggestion (moderator only)',
  })
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

  // Moderator-only: the "claim this existing listing" review queue. Declared
  // before `:ref`, same rationale as `admin/edit-suggestions` above — a
  // sibling sub-resource of `Listing`, kept on this controller (not a
  // separate top-level `Admin*Controller`) for the same reason
  // `ListingEditSuggestion`'s admin routes are.
  @Get('admin/claims')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  @ApiOperation({
    summary: 'List the pending listing-claim review queue (moderator only)',
  })
  @ApiOkResponse({ description: 'The pending claims, oldest first.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  listPendingClaims() {
    return this.listingClaimsService.listPending();
  }

  // Moderator-only: approve or decline a pending listing claim. On approval
  // this reassigns the listing's `ownerId` to the claimant.
  @Patch('admin/claims/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  @ApiOperation({
    summary: 'Approve or decline a listing claim (moderator only)',
  })
  @ApiOkResponse({ description: 'The reviewed claim.' })
  @ApiNotFoundResponse({ description: 'No claim or listing found.' })
  @ApiConflictResponse({ description: 'This claim has already been reviewed.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  reviewClaim(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() dto: ReviewListingClaimDto,
  ) {
    return this.listingClaimsService.review(id, user.userId, dto.decision);
  }

  // Moderator-only: bulk-apply one status transition to many listings (item
  // #9). Declared before `:ref` (mirrors every other `admin/*` route above)
  // so Nest resolves the literal `admin/bulk-status` segment.
  @Patch('admin/bulk-status')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  @ApiOperation({
    summary: 'Bulk-set the moderation status of many listings (moderator only)',
  })
  @ApiOkResponse({ description: 'Which refs updated and which failed.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  bulkSetStatus(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: BulkStatusDto,
  ) {
    return this.listingsService.bulkSetStatus(
      dto.refs,
      dto.status,
      user.userId,
      dto.reason,
    );
  }

  // Moderator-only: bulk hard-delete many listings (item #9). Declared
  // before `:ref`, same rationale as `bulk-status` above.
  @Post('admin/bulk-remove')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk-remove many listings (moderator only)' })
  @ApiOkResponse({
    description: 'Which refs were removed and which failed.',
  })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  bulkRemove(@CurrentUser() user: CurrentUserData, @Body() dto: BulkRemoveDto) {
    return this.listingsService.bulkRemove(dto.refs, user.userId, dto.reason);
  }

  // Moderator-only: a listing's moderation audit trail + Q&A thread (items
  // #16/#17), for the admin drawer's history panel. Declared before `:ref`,
  // same rationale as the other `admin/*` routes above.
  @Get('admin/:ref/history')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  @ApiOperation({
    summary:
      "Get a listing's moderation history and Q&A thread (moderator only)",
  })
  @ApiOkResponse({
    description: 'Moderation events and questions, newest first.',
  })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  getHistory(@Param('ref') ref: string) {
    return this.listingsService.getListingHistory(ref);
  }

  @Get(':ref')
  @ApiOperation({
    summary: "Get one of the member's own listings by reference",
  })
  @ApiOkResponse({ description: 'The listing owned by the caller.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  @ApiForbiddenResponse({
    description: 'The listing is not owned by the caller.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  get(@CurrentUser() user: CurrentUserData, @Param('ref') ref: string) {
    return this.listingsService.getByRef(ref, user.userId);
  }

  @Patch(':ref')
  @ApiOperation({ summary: "Update one of the member's own listings" })
  @ApiOkResponse({ description: 'The updated listing.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  @ApiForbiddenResponse({
    description: 'The listing is not owned by the caller.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
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
  @ApiForbiddenResponse({
    description: 'The listing is not owned by the caller.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  remove(@CurrentUser() user: CurrentUserData, @Param('ref') ref: string) {
    return this.listingsService.remove(ref, user.userId);
  }

  // Moderator-only: permanently delete any listing regardless of owner.
  // Separate path from the owner-only `DELETE :ref` above so the two
  // authorization models (owner vs. role) stay independent. Two-segment
  // path (`admin/:ref`) never collides with the single-segment `:ref`.
  @Delete('admin/:ref')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete any listing (moderator only)' })
  @ApiNoContentResponse({ description: 'The listing was deleted.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  removeByModerator(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto?: RemoveListingDto,
  ) {
    return this.listingsService.removeByModerator(
      ref,
      user.userId,
      dto?.reason,
    );
  }

  // Owner-gated (same `assertOwner` check as `update`/`remove`/`getByRef`
  // above, not a `RolesGuard` route): the listing owner posts (or overwrites)
  // their single public reply to a review on their own listing.
  @Patch(':ref/reviews/:reviewId/reply')
  @ApiOperation({
    summary: "Post or overwrite the owner's public reply to a review",
  })
  @ApiOkResponse({ description: 'The review with the updated owner reply.' })
  @ApiNotFoundResponse({ description: 'No listing or review found.' })
  @ApiForbiddenResponse({
    description: 'The listing is not owned by the caller.',
  })
  @ApiBadRequestResponse({ description: 'Reply cannot be empty.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  replyToReview(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Param('reviewId') reviewId: string,
    @Body() dto: ReplyToReviewDto,
  ) {
    return this.listingsService.replyToReview(ref, user.userId, reviewId, dto);
  }

  // Any active member (NOT owner-gated): contest a "friendly"/unowned listing
  // — including the named business claiming it (item #13). Files a
  // `listing_dispute` report through the shared report+moderation pipeline;
  // throttled like `POST /reports` since it is a report-filing surface.
  @Post(':ref/dispute')
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @ApiOperation({ summary: 'Dispute or claim a business listing' })
  @ApiCreatedResponse({
    description: 'The filed dispute (or the caller’s existing open dispute).',
  })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  dispute(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: DisputeListingDto,
  ) {
    return this.listingsService.dispute(ref, user.userId, dto);
  }

  // Any active member (NOT owner-gated): request ownership of an EXISTING
  // listing the caller doesn't currently own — the real "claim this listing"
  // flow (as opposed to `POST /listings`, which always creates a brand-new
  // row). Lands in the moderator-reviewable queue (`GET /listings/admin/claims`
  // / `PATCH /listings/admin/claims/:id`); throttled like `dispute` above,
  // same rationale (a member-initiated moderation-queue filing surface).
  @Post(':ref/claim')
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @ApiOperation({ summary: 'Claim ownership of an existing business listing' })
  @ApiCreatedResponse({
    description: 'The filed claim (or the caller’s existing open claim).',
  })
  @ApiBadRequestResponse({ description: 'The caller already owns this listing.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  claim(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: CreateListingClaimDto,
  ) {
    return this.listingClaimsService.requestClaim(ref, user.userId, dto.note);
  }

  // Moderator-only: the FE's `setListingStatus` comment is explicit that
  // this is "NOT called from the member client" — only the moderation
  // surface transitions a listing's status, so this route layers
  // `RolesGuard` on top of the controller's `ActiveMemberGuard`.
  @Patch(':ref/status')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  @ApiOperation({
    summary: "Set a listing's moderation status (moderator only)",
  })
  @ApiOkResponse({ description: 'The updated listing.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  setStatus(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: UpdateListingStatusDto,
  ) {
    return this.listingsService.setStatus(
      ref,
      dto.status,
      user.userId,
      dto.reason,
    );
  }

  // Moderator-only: ask the submitter a question. Sends the text as a DM and
  // moves the listing to `question` status (see `ListingsService.askQuestion`).
  @Post(':ref/question')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  @ApiOperation({
    summary: 'Ask the submitter a question via DM (moderator only)',
  })
  @ApiCreatedResponse({ description: 'The listing moved to question status.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  @ApiBadRequestResponse({
    description: 'This listing has no submitter to contact.',
  })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({
    description:
      'Requires moderator or admin role, or the message was blocked.',
  })
  askQuestion(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: AskListingQuestionDto,
  ) {
    return this.listingsService.askQuestion(ref, user.userId, dto.body);
  }

  // Owner-gated (same `assertOwner` check as `update`/`remove`/`getByRef`/
  // `replyToReview`, NOT a `RolesGuard` route): the listing owner answers a
  // moderator's question from the Q&A thread (item #17).
  @Post(':ref/questions/:id/answer')
  @ApiOperation({
    summary: "Owner answers a moderator's question about their listing",
  })
  @ApiOkResponse({ description: 'The answered question.' })
  @ApiNotFoundResponse({ description: 'No listing or question found.' })
  @ApiForbiddenResponse({
    description: 'The listing is not owned by the caller.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  answerQuestion(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Param('id') id: string,
    @Body() dto: AnswerListingQuestionDto,
  ) {
    return this.listingsService.answerQuestion(
      ref,
      id,
      user.userId,
      dto.answer,
    );
  }

  // Moderator-only, same rationale as `setStatus` above — only the
  // moderation surface toggles a listing's safe-space badge.
  @Patch(':ref/safe-space')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  @ApiOperation({
    summary: "Toggle a listing's safe-space badge (moderator only)",
  })
  @ApiOkResponse({ description: 'The updated listing.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  setSafeSpace(@Param('ref') ref: string, @Body() dto: UpdateSafeSpaceDto) {
    return this.listingsService.setSafeSpace(ref, dto);
  }

  // Moderator-only, same rationale as `setSafeSpace` above — only the
  // moderation surface confirms the "queer-owned" badge. Distinct from the
  // member's own self-reported `linkToProfile` claim.
  @Patch(':ref/queer-owned-verified')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  @ApiOperation({
    summary: "Toggle a listing's queer-owned verification (moderator only)",
  })
  @ApiOkResponse({ description: 'The updated listing.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  setQueerOwnedVerified(
    @Param('ref') ref: string,
    @Body() dto: UpdateQueerOwnedVerifiedDto,
  ) {
    return this.listingsService.setQueerOwnedVerified(ref, dto.verified);
  }
}
