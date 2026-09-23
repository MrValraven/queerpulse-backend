import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
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
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { isPlatformStaffTier } from '../auth/platform-staff-tier';
import { Feature } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AdminCreateListingDto } from './dto/admin-create-listing.dto';
import { AnswerListingPublicQuestionDto } from './dto/answer-listing-public-question.dto';
import { AskListingQuestionDto } from './dto/ask-listing-question.dto';
import { BulkRemoveDto, BulkStatusDto } from './dto/bulk-listing.dto';
import { CreateListingOwnerOfferDto } from './dto/create-listing-owner-offer.dto';
import { InviteListingCoManagerDto } from './dto/invite-listing-co-manager.dto';
import { ListEditSuggestionsQuery } from './dto/list-edit-suggestions.query';
import { ListListingClaimsQuery } from './dto/list-listing-claims.query';
import { ListListingQueueQuery } from './dto/list-listing-queue.query';
import { RemoveListingDto } from './dto/remove-listing.dto';
import { ResolveEditSuggestionDto } from './dto/resolve-edit-suggestion.dto';
import { ReviewListingClaimDto } from './dto/review-listing-claim.dto';
import { UpdateListingStatusDto } from './dto/update-listing-status.dto';
import { UpdateQueerOwnedVerifiedDto } from './dto/update-queer-owned-verified.dto';
import { UpdateSafeSpaceDto } from './dto/update-safe-space.dto';
import { ListingClaimsService } from './listing-claims.service';
import { ListingCoManagerDTO } from './listing-co-manager-response';
import { ListingCoManagersService } from './listing-co-managers.service';
import { ListingEditSuggestionsService } from './listing-edit-suggestions.service';
import { ListingOwnerOfferDTO } from './listing-owner-offer-response';
import { ListingOwnerOffersService } from './listing-owner-offers.service';
import { toDirectoryModerationListingDTO } from './listing-owner-personal-fields';
import { ListingDTO } from './listing-response';
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
 *
 * WHO CAN BE HERE, AND WHAT THEY READ. `RolesOrStaffGuard` means a caller may
 * be a platform Moderator/Admin OR a plain member holding the
 * `directory_moderator` grant. Widening the gate did not narrow the bodies,
 * and every handler below that echoes a `ListingDTO` was handing a grant
 * holder the owner's own contact email and their consent decisions on top of
 * the business. Those handlers now pass the response through
 * `toDirectoryModerationListingDTO`, which omits three owner-personal fields
 * for a caller who is not platform staff by ACCOUNT TIER. See
 * `listing-owner-personal-fields.ts` for which three and why the other five
 * stay.
 */
@Feature('listings')
@ApiTags('Admin — Listings')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description:
    'Requires a moderator or admin role, or the `directory_moderator` staff role.',
})
@Controller('admin/listings')
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@StaffRoles('directory_moderator')
export class AdminListingsController {
  private readonly logger = new Logger(AdminListingsController.name);

  constructor(
    private readonly listingsService: ListingsService,
    private readonly editSuggestionsService: ListingEditSuggestionsService,
    private readonly listingClaimsService: ListingClaimsService,
    // The nomination an admin can make in the same form as the create. Owned
    // by its own service (`listings.module.ts` provides and exports it), so
    // this controller only needs the one `offer` call.
    private readonly listingOwnerOffersService: ListingOwnerOffersService,
    // The co-manager seats behind the same delegation panel. A provider of
    // this module already, so no new wiring.
    private readonly listingCoManagersService: ListingCoManagersService,
  ) {}

  /**
   * Author a listing on a business's behalf.
   *
   * ADMIN ONLY, and the empty `@StaffRoles()` is what makes that true.
   * `RolesOrStaffGuard` reads both metadata keys with `getAllAndOverride`, so
   * `@Roles(UserRole.Admin)` on its own would leave the class-level
   * `@StaffRoles('directory_moderator')` in scope and quietly re-open this
   * route to every grant holder. The empty decorator overrides the class
   * grant, leaving `@Roles` as the whole gate. Same idiom as
   * `admin-resources.controller.ts`'s publish/unpublish pair.
   *
   * Writing a public page about a queer business that never asked for one is
   * a platform-tier decision, which is why it sits above the directory
   * moderation grant that covers the rest of this class.
   *
   * The response is the full `ListingDTO` without passing through
   * `toDirectoryModerationListingDTO`: an admin-authored listing has no owner
   * and therefore none of the owner-personal fields that redaction exists to
   * withhold, and only platform admins reach this handler anyway.
   */
  @Post()
  @StaffRoles()
  @Roles(UserRole.Admin)
  @ApiOperation({ summary: "Author a listing on a business's behalf" })
  @ApiCreatedResponse({ description: 'The created listing.' })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  @ApiBadRequestResponse({
    description: 'The submission is missing a claim-path requirement.',
  })
  async create(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: AdminCreateListingDto,
  ): Promise<ListingDTO> {
    const listing = await this.listingsService.adminCreate(user.userId, dto);
    if (dto.ownerOffer) {
      await this.offerOwnershipBestEffort(
        listing.ref,
        user.userId,
        dto.ownerOffer,
      );
    }
    return listing;
  }

  /**
   * Extend the nomination that came with the create, swallowing its failure.
   *
   * Best-effort on purpose, matching `enqueueOwnerNotifyIfNeeded` in
   * `ListingsService.create`. The listing is already committed by the time
   * this runs, so a member slug that no longer resolves, or an offer that
   * loses the open-offer slot to a concurrent one, must leave the admin with
   * their listing and a logged warning. They can re-offer from the delegation
   * panel, which is the surface that owns offers.
   */
  private async offerOwnershipBestEffort(
    ref: string,
    adminUserId: string,
    dto: CreateListingOwnerOfferDto,
  ): Promise<void> {
    try {
      await this.listingOwnerOffersService.offer(ref, adminUserId, dto);
    } catch (error) {
      this.logger.warn(
        `Could not offer freshly authored listing ${ref} to ${dto.memberSlug}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

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
  async listQueue(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListListingQueueQuery,
  ) {
    const isReaderPlatformStaff = isPlatformStaffTier(user.role);
    const page = await this.listingsService.listQueue(query);
    return {
      ...page,
      items: page.items.map((listing) =>
        toDirectoryModerationListingDTO(listing, isReaderPlatformStaff),
      ),
    };
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
  @ApiOkResponse({
    description:
      'A `{ items, total, page, pageSize }` page of the pending claims, oldest ' +
      'first (ENG-41: this used to be a flat array silently capped at 200, ' +
      'which hid the most recently filed claims). `total` is the size of the ' +
      'whole pending queue, so the desk can state its real depth and a ' +
      'moderator can page to the end of it.',
  })
  listPendingClaims(@Query() query: ListListingClaimsQuery) {
    return this.listingClaimsService.listPending(query);
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
  async setStatus(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: UpdateListingStatusDto,
  ) {
    return toDirectoryModerationListingDTO(
      await this.listingsService.setStatus(
        ref,
        dto.status,
        user.userId,
        dto.reason,
      ),
      isPlatformStaffTier(user.role),
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
  async askQuestion(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: AskListingQuestionDto,
  ) {
    return toDirectoryModerationListingDTO(
      await this.listingsService.askQuestion(ref, user.userId, dto.body),
      isPlatformStaffTier(user.role),
    );
  }

  // Moderator answers a member's PUBLIC question on a listing.
  //
  // WHY THIS ROUTE EXISTS AT ALL, given the owner already has one. A large
  // share of directory listings have no owner: the `friendly` and `suggested`
  // submission paths create rows with a null `owner_id` for businesses that
  // never claimed their page, and those are often exactly the venues people
  // have questions about. Owner-only would make the public question box on
  // every one of them a form that accepts questions nobody can answer, which is
  // worse than not offering it. Abandoned owned listings fail the same way,
  // more slowly.
  //
  // It does NOT let staff speak as the business. The answer is stamped
  // `is_answered_by_moderator` and surfaces as `answeredByRole: 'moderator'`,
  // so the page labels where it came from — an accessibility or safety answer
  // attributed to a venue is a commitment BY that venue, and staff must not be
  // able to make one on its behalf. The individual moderator is never named in
  // the response.
  @Post(':ref/public-questions/:id/answer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Moderator answers a member's public question on a listing",
  })
  @ApiOkResponse({
    description: 'The answered question, labelled as a moderator answer.',
  })
  @ApiNotFoundResponse({ description: 'No listing or question found.' })
  @ApiBadRequestResponse({ description: 'Answer cannot be empty.' })
  answerPublicQuestion(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Param('id') id: string,
    @Body() dto: AnswerListingPublicQuestionDto,
  ) {
    return this.listingsService.answerPublicQuestionAsModerator(
      ref,
      id,
      user.userId,
      dto.answer,
    );
  }

  // Only the moderation surface toggles a listing's safe-space badge.
  @Patch(':ref/safe-space')
  @ApiOperation({ summary: "Toggle a listing's safe-space badge" })
  @ApiOkResponse({ description: 'The updated listing.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  async setSafeSpace(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: UpdateSafeSpaceDto,
  ) {
    // Computed once and used twice: it narrows who may OVERRIDE the
    // independent-visit bar inside `setSafeSpace`, and it narrows what the
    // response shows a staff delegate.
    const isPlatformStaff = isPlatformStaffTier(user.role);
    return toDirectoryModerationListingDTO(
      await this.listingsService.setSafeSpace(ref, dto, isPlatformStaff),
      isPlatformStaff,
    );
  }

  // Only the moderation surface confirms the "queer-owned" badge. Distinct
  // from the member's own self-reported `linkToProfile` claim.
  //
  // Grants record their PROVENANCE: who confirmed it, when, on what basis, and
  // when it next needs re-confirming. The moderator may supply any of those; a
  // bare `{ verified: true }` still fills them all, naming the acting moderator
  // as the verifier. A badge whose evidence nobody can inspect is what this
  // replaced.
  @Patch(':ref/queer-owned-verified')
  @ApiOperation({
    summary: "Set a listing's queer-owned verification and its provenance",
  })
  @ApiOkResponse({ description: 'The updated listing.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  async setQueerOwnedVerified(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: UpdateQueerOwnedVerifiedDto,
  ) {
    return toDirectoryModerationListingDTO(
      await this.listingsService.setQueerOwnedVerified(ref, user.userId, dto),
      isPlatformStaffTier(user.role),
    );
  }

  // ---------------------------------------------------------------------------
  // DELEGATION: who is going to run this page.
  //
  // ADMIN ONLY, every one of the six. Each carries the empty `@StaffRoles()`
  // alongside `@Roles(UserRole.Admin)` for the reason `create`'s doc comment
  // sets out at length: `RolesOrStaffGuard` resolves both metadata keys with
  // `getAllAndOverride`, so without the empty decorator the class-level
  // `@StaffRoles('directory_moderator')` stays in scope and a volunteer grant
  // holder can reassign a business. Handing a listing to somebody, or seating
  // them behind a public page about a queer venue, is a platform-tier
  // decision, and it sits above the directory moderation grant that covers
  // the rest of this class.
  //
  // Declared here, above the bare `@Delete(':ref')`, following this class's
  // stated ordering rule: a route carrying a literal segment goes before the
  // parameter route that could absorb it, so no path segment is ever bound
  // as a `ref` value. `admin-listings-delegation.spec.ts` pins the order.
  // ---------------------------------------------------------------------------

  // What the delegation panel reads on a cold open. `null` with a 200 is the
  // ordinary answer, because almost every listing in the directory has no
  // open offer; the 404 is reserved for a `ref` that does not exist. Without
  // this the panel could only show an offer extended in the same session,
  // and an older one stayed invisible until a second offer came back 409.
  @Get(':ref/owner-offer')
  @StaffRoles()
  @Roles(UserRole.Admin)
  @ApiOperation({ summary: 'Get the open ownership offer on a listing' })
  @ApiOkResponse({
    description: 'The open offer, or null when the listing has none.',
  })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  getOwnershipOffer(
    @Param('ref') ref: string,
  ): Promise<ListingOwnerOfferDTO | null> {
    return this.listingOwnerOffersService.findOpenForListing(ref);
  }

  // Nominate a member as the owner of a listing that has none. The member
  // decides: the row sits at `offered` until they answer, and only their
  // accept reaches `listings.owner_id`.
  @Post(':ref/owner-offer')
  @StaffRoles()
  @Roles(UserRole.Admin)
  @ApiOperation({ summary: 'Offer ownership of a listing to a member' })
  @ApiCreatedResponse({ description: 'The open offer.' })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  @ApiNotFoundResponse({
    description: 'No listing with that reference, or no such active member.',
  })
  @ApiConflictResponse({
    description:
      'The listing already has an owner, or it already has an open offer.',
  })
  offerOwnership(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: CreateListingOwnerOfferDto,
  ): Promise<ListingOwnerOfferDTO> {
    return this.listingOwnerOffersService.offer(ref, user.userId, dto);
  }

  // Withdraw the open offer, which is also how staff re-offer a listing to
  // somebody else: one open offer per listing is a unique index, so the first
  // has to go before the second can be made.
  @Delete(':ref/owner-offer')
  @StaffRoles()
  @Roles(UserRole.Admin)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw the open ownership offer on a listing' })
  @ApiOkResponse({ description: 'The withdrawn offer.' })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  @ApiNotFoundResponse({
    description: 'No listing with that reference, or no open offer on it.',
  })
  revokeOwnershipOffer(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
  ): Promise<ListingOwnerOfferDTO> {
    return this.listingOwnerOffersService.revoke(ref, user.userId);
  }

  // The same roster the owner reads on their own listing, for any listing.
  // The member-facing `GET /listings/:ref/co-managers` gates on owner or
  // active co-manager, which an admin arranging a house-authored listing is
  // neither.
  @Get(':ref/co-managers')
  @StaffRoles()
  @Roles(UserRole.Admin)
  @ApiOperation({ summary: "List a listing's co-manager seats" })
  @ApiOkResponse({
    description:
      'The live seats: accepted ones and unanswered invitations. Ended seats are excluded.',
  })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  listCoManagers(@Param('ref') ref: string): Promise<ListingCoManagerDTO[]> {
    return this.listingCoManagersService.staffListCoManagers(ref);
  }

  // Seat somebody on a listing the house wrote, before anybody has accepted
  // ownership of it. The seat is stamped `isStaffAttached`, so it survives
  // the handover when an owner does accept; an owner's own appointees leave
  // with that owner. The invitation still has to be accepted by the member:
  // staff put nobody behind a public page about a queer venue without asking.
  @Post(':ref/co-managers')
  @StaffRoles()
  @Roles(UserRole.Admin)
  @ApiOperation({ summary: 'Seat a member as co-manager of a listing' })
  @ApiCreatedResponse({ description: 'The pending invitation.' })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  @ApiNotFoundResponse({
    description: 'No listing with that reference, or no such active member.',
  })
  @ApiConflictResponse({
    description:
      'That member already holds or has been offered a seat, or the listing is at its co-manager cap.',
  })
  inviteCoManager(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: InviteListingCoManagerDto,
  ): Promise<ListingCoManagerDTO> {
    return this.listingCoManagersService.staffInviteCoManager(
      ref,
      user.userId,
      dto,
    );
  }

  // Take a seat back, accepted or still unanswered. Writes the same
  // `co_manager_removed` audit row the owner's own revoke writes, naming the
  // acting admin.
  @Delete(':ref/co-managers/:memberSlug')
  @StaffRoles()
  @Roles(UserRole.Admin)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a co-manager seat from a listing' })
  @ApiNoContentResponse({ description: 'The seat was removed.' })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  @ApiNotFoundResponse({
    description:
      'No listing with that reference, or that member holds no live seat on it.',
  })
  revokeCoManager(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Param('memberSlug') memberSlug: string,
  ): Promise<void> {
    return this.listingCoManagersService.staffRevokeCoManager(
      ref,
      user.userId,
      memberSlug,
    );
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
