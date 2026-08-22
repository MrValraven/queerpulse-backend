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
import { BulkRemoveDto, BulkStatusDto } from './dto/bulk-listing.dto';
import { ListEditSuggestionsQuery } from './dto/list-edit-suggestions.query';
import { ListListingQueueQuery } from './dto/list-listing-queue.query';
import { RemoveListingDto } from './dto/remove-listing.dto';
import { ResolveEditSuggestionDto } from './dto/resolve-edit-suggestion.dto';
import { ReviewListingClaimDto } from './dto/review-listing-claim.dto';
import { UpdateListingStatusDto } from './dto/update-listing-status.dto';
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
 * Every moderator/admin route over business listings, in ONE class with ONE
 * class-level guard pair (BE-HSG-29).
 *
 * These eleven handlers used to live on `ListingsController` — a class whose
 * class-level guard is only `ActiveMemberGuard` — each carrying its own
 * `@UseGuards(RolesGuard) @Roles(...)` pair. That put the whole authorization
 * decision on a per-handler decorator: one `admin/*` route added later without
 * both lines would have been reachable by any active member, and the security
 * scan's "every Admin*Controller is consistently gated" sweep could not see
 * these routes at all because they were not in an Admin controller. The guards
 * are now stated once for the class, so a new route here is gated by default
 * rather than by remembering.
 *
 * The moved routes also leave the member `:ref` namespace, which is what let
 * `DELETE /listings/admin/:ref` (moderator, any listing) sit one path segment
 * away from `DELETE /listings/:ref` (owner, own listing only).
 *
 * Route ordering: literal segments (`queue`, `claims`, `edit-suggestions`, …)
 * are declared before the `:ref` routes so Nest matches the literal rather
 * than binding it as a `ref` value — the same ordering rule
 * `ListingsController` follows for `mine`/`similar`.
 */
@Feature('listings')
@ApiTags('Admin — Listings')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
@Controller('admin/listings')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminListingsController {
  constructor(
    private readonly listingsService: ListingsService,
    private readonly editSuggestionsService: ListingEditSuggestionsService,
    private readonly listingClaimsService: ListingClaimsService,
  ) {}

  @Get('safe-space-candidates')
  @ApiOperation({ summary: 'List safe-space candidate listings' })
  @ApiOkResponse({ description: 'The candidate listings.' })
  listSafeSpaceCandidates() {
    return this.listingsService.listSafeSpaceCandidates();
  }

  // The listings moderation queue (FE AdminListingsPage).
  @Get('queue')
  @ApiOperation({ summary: 'List the listings moderation queue' })
  @ApiOkResponse({ description: 'Paginated page of queued listings.' })
  listQueue(@Query() query: ListListingQueueQuery) {
    return this.listingsService.listQueue(query);
  }

  // The "suggest an edit" review queue. Submission itself is NOT a route here
  // — it is slug-keyed and lives on the public `DirectoryController`
  // (`POST /directory/:slug/edit-suggestions`), since a non-owner submitter
  // never has this listing's `ref` (see `ListingEditSuggestionsService.submit`).
  @Get('edit-suggestions')
  @ApiOperation({ summary: 'List the edit-suggestion review queue' })
  @ApiOkResponse({ description: 'The edit suggestions, newest first.' })
  listEditSuggestions(@Query() query: ListEditSuggestionsQuery) {
    return this.editSuggestionsService.listForAdmin(query);
  }

  @Patch('edit-suggestions/:id')
  @ApiOperation({ summary: 'Accept or dismiss an edit suggestion' })
  @ApiOkResponse({ description: 'The resolved edit suggestion.' })
  @ApiNotFoundResponse({ description: 'No edit suggestion or listing found.' })
  resolveEditSuggestion(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() dto: ResolveEditSuggestionDto,
  ) {
    return this.editSuggestionsService.resolve(id, user.userId, dto);
  }

  @Get('claims')
  @ApiOperation({ summary: 'List the pending listing-claim review queue' })
  @ApiOkResponse({ description: 'The pending claims, oldest first.' })
  listPendingClaims() {
    return this.listingClaimsService.listPending();
  }

  // On approval this reassigns the listing's `ownerId` to the claimant.
  @Patch('claims/:id')
  @ApiOperation({ summary: 'Approve or decline a listing claim' })
  @ApiOkResponse({ description: 'The reviewed claim.' })
  @ApiNotFoundResponse({ description: 'No claim or listing found.' })
  @ApiConflictResponse({ description: 'This claim has already been reviewed.' })
  reviewClaim(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() dto: ReviewListingClaimDto,
  ) {
    return this.listingClaimsService.review(id, user.userId, dto.decision);
  }

  @Patch('bulk-status')
  @ApiOperation({ summary: 'Bulk-set the moderation status of many listings' })
  @ApiOkResponse({ description: 'Which refs updated and which failed.' })
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

  @Post('bulk-remove')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk-remove many listings' })
  @ApiOkResponse({ description: 'Which refs were removed and which failed.' })
  bulkRemove(@CurrentUser() user: CurrentUserData, @Body() dto: BulkRemoveDto) {
    return this.listingsService.bulkRemove(dto.refs, user.userId, dto.reason);
  }

  // A listing's moderation audit trail + Q&A thread, for the admin drawer's
  // history panel.
  @Get(':ref/history')
  @ApiOperation({
    summary: "Get a listing's moderation history and Q&A thread",
  })
  @ApiOkResponse({
    description: 'Moderation events and questions, newest first.',
  })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  getHistory(@Param('ref') ref: string) {
    return this.listingsService.getListingHistory(ref);
  }

  // Only the moderation surface transitions a listing's status — the FE's
  // `setListingStatus` comment is explicit that it is "NOT called from the
  // member client".
  @Patch(':ref/status')
  @ApiOperation({ summary: "Set a listing's moderation status" })
  @ApiOkResponse({ description: 'The updated listing.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
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

  // Ask the submitter a question. Sends the text as a DM and moves the listing
  // to `question` status (see `ListingsService.askQuestion`). The OWNER's
  // answer is not here — it stays owner-gated on `ListingsController`.
  @Post(':ref/question')
  @ApiOperation({ summary: 'Ask the submitter a question via DM' })
  @ApiCreatedResponse({ description: 'The listing moved to question status.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  @ApiBadRequestResponse({
    description: 'This listing has no submitter to contact.',
  })
  askQuestion(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: AskListingQuestionDto,
  ) {
    return this.listingsService.askQuestion(ref, user.userId, dto.body);
  }

  // Only the moderation surface toggles a listing's safe-space badge.
  @Patch(':ref/safe-space')
  @ApiOperation({ summary: "Toggle a listing's safe-space badge" })
  @ApiOkResponse({ description: 'The updated listing.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  setSafeSpace(@Param('ref') ref: string, @Body() dto: UpdateSafeSpaceDto) {
    return this.listingsService.setSafeSpace(ref, dto);
  }

  // Only the moderation surface confirms the "queer-owned" badge. Distinct
  // from the member's own self-reported `linkToProfile` claim.
  @Patch(':ref/queer-owned-verified')
  @ApiOperation({ summary: "Toggle a listing's queer-owned verification" })
  @ApiOkResponse({ description: 'The updated listing.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  setQueerOwnedVerified(
    @Param('ref') ref: string,
    @Body() dto: UpdateQueerOwnedVerifiedDto,
  ) {
    return this.listingsService.setQueerOwnedVerified(ref, dto.verified);
  }

  // Permanently delete any listing regardless of owner. The owner-only
  // `DELETE /listings/:ref` stays on `ListingsController`; keeping the two
  // authorization models on separate controllers is the point of the split.
  // Declared last: `:ref` is a single segment here, so it must not shadow the
  // literal-prefixed routes above.
  @Delete(':ref')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete any listing' })
  @ApiNoContentResponse({ description: 'The listing was deleted.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
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
}
