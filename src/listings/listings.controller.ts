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
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { AnswerListingPublicQuestionDto } from './dto/answer-listing-public-question.dto';
import { AnswerListingQuestionDto } from './dto/answer-listing-question.dto';
import { CreateListingClaimDto } from './dto/create-listing-claim.dto';
import { CreateListingDto } from './dto/create-listing.dto';
import { DisputeListingDto } from './dto/dispute-listing.dto';
import { ListOwnerListingHistoryQuery } from './dto/list-owner-listing-history.query';
import { SimilarListingsQuery } from './dto/similar-listings.query';
import { ListMyListingsQuery } from './dto/list-my-listings.query';
import { ReplyToReviewDto } from './dto/reply-to-review.dto';
import { UpdateListingDto } from './dto/update-listing.dto';
import { UpdateListingVisibilityDto } from './dto/update-listing-visibility.dto';
import { UpdateOperatingStateDto } from './dto/update-operating-state.dto';
import { toListingClaimPolicyDTO } from './listing-claim-policy';
import { ListingClaimsService } from './listing-claims.service';
import { ListingOwnerPendingService } from './listing-owner-pending.service';
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
 * Member business directory listings (spec §3 Tier 4 "listings").
 * `GET/PATCH/DELETE /listings/:ref` are the caller's own submission-tracking
 * view (403 for a non-owner ref), not a public directory browse. FE:
 * `listings.api.ts`.
 *
 * THREE TIERS OF ACCESS live on this class, and every route says which one it
 * is in a comment above it:
 *
 *  - OWNER ONLY (`ListingsService.loadOwnedOr404`): `DELETE /:ref` and
 *    `POST /:ref/questions/:id/answer`. Deleting the business's page, and
 *    answering the moderator's private compliance thread.
 *  - OWNER OR CO-MANAGER (`ListingsService.loadOwnedOrCoManagedOr404`):
 *    everything else `:ref`-scoped. A listing has exactly one `owner_id`, so a
 *    venue run by two people shares its page through an invited, accepted
 *    co-manager seat (`ListingCoManagersController`). A co-manager's responses
 *    are redacted of the owner's personal fields and their writes to those
 *    fields are refused — see `listing-owner-personal-fields.ts`.
 *  - ANY ACTIVE MEMBER: `dispute`, `claim`.
 *
 * There is deliberately NO role-gated route left on this class: the
 * moderator/admin surface moved to `AdminListingsController`
 * (`/admin/listings/*`) so the whole class shares one guard shape instead of
 * mixing three (BE-HSG-29). Owner and co-manager gates are not role gates.
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
    private readonly listingClaimsService: ListingClaimsService,
    // C8: what is currently waiting on a listing, for the person who owns it.
    private readonly listingOwnerPendingService: ListingOwnerPendingService,
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

  // Every listing the caller OWNS plus every listing they CO-MANAGE, each row
  // carrying `managementRole` so the two are told apart. Without the co-managed
  // ones the feature would be unreachable: every management route is keyed by
  // `ref`, and this is the only endpoint that tells a member what their refs
  // are.
  @Get('mine')
  @ApiOperation({
    summary: 'List the listings the current member owns or co-manages',
  })
  @ApiOkResponse({
    description:
      "Paginated page of the member's listings, each tagged owner or co_manager.",
  })
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
    return this.listingsService.findSimilar(
      query.name,
      query.lat,
      query.lng,
      query.excludeRef,
    );
  }

  // What the claim flow is allowed to promise, served as data rather than
  // restated in a component. Declared before `:ref` so Nest resolves the
  // literal segment, same reason as `mine`/`similar` above.
  //
  // A constant with no database read behind it, but it belongs on the server
  // all the same: `POST /listings/:ref/claim` returns the same turnaround on
  // every claim DTO, and a frontend copy of the number would eventually
  // disagree with the one the claimant's own status line counts down against.
  @Get('claim-policy')
  @ApiOperation({
    summary:
      'How long a listing claim takes to review, and what evidence helps',
  })
  @ApiOkResponse({
    description: 'The published turnaround in days plus the evidence hints.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  claimPolicy() {
    return toListingClaimPolicyDTO();
  }

  // The caller's own claims, newest first, each carrying how long it has been
  // waiting and the date a decision was promised by. Two segments, so it can
  // never be confused with the one-segment `:ref` route above.
  @Get('claims/mine')
  @ApiOperation({ summary: "List the caller's own listing ownership claims" })
  @ApiOkResponse({
    description: 'The caller’s claims, newest first, with their age.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  listMyClaims(@CurrentUser() user: CurrentUserData) {
    return this.listingClaimsService.listMine(user.userId);
  }

  // OWNER OR CO-MANAGER (`loadOwnedOrCoManagedOr404`). A co-manager's copy is
  // redacted of the eight owner-personal fields and tagged
  // `managementRole: 'co_manager'`.
  @Get(':ref')
  @ApiOperation({
    summary: 'Get a listing the caller owns or co-manages, by reference',
  })
  @ApiOkResponse({
    description:
      'The listing, redacted of the owner’s personal fields for a co-manager.',
  })
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

  // OWNER OR CO-MANAGER (`loadOwnedOrCoManagedOr404`, the same gate as
  // `get`/`update`, NOT a `RolesGuard` route): C3, the management view of the
  // listing's moderation history. Someone editing a live listing has to see
  // what has already happened to it, including the `owner_edited` rows their
  // own edits write. The moderator's view of the same table is
  // `GET /admin/listings/:ref/history`; the two envelopes agree field for
  // field except where this one deliberately withholds (no actor identity, no
  // human-typed reason text). See `owner-listing-history.dto.ts` for the rule
  // and `ListingsService.getOwnerListingHistory` for why.
  @Get(':ref/history')
  @ApiOperation({
    summary: "Get the moderation history of one of the member's own listings",
  })
  @ApiOkResponse({
    description:
      'Moderation events (paginated) and the Q&A thread, both newest first.',
  })
  @ApiNotFoundResponse({
    description: 'No listing with that reference owned by the caller.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  getOwnHistory(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Query() query: ListOwnerListingHistoryQuery,
  ) {
    return this.listingsService.getOwnerListingHistory(
      ref,
      user.userId,
      query.page,
    );
  }

  // OWNER OR CO-MANAGER (`loadOwnedOrCoManagedOr404`, same gate again): C8,
  // everything currently awaiting a decision on the listing: pending edit
  // suggestions, pending ownership claims, open disputes, and the moderator
  // questions they have not answered yet. Counts come back alongside the items
  // so a badge never has to fetch the bodies.
  @Get(':ref/pending')
  @ApiOperation({
    summary: "List what is pending on one of the member's own listings",
  })
  @ApiOkResponse({
    description: 'Pending items and their counts, each list newest first.',
  })
  @ApiNotFoundResponse({
    description: 'No listing with that reference owned by the caller.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  getOwnPending(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
  ) {
    return this.listingOwnerPendingService.getPendingForOwner(ref, user.userId);
  }

  // OWNER OR CO-MANAGER (`loadOwnedOrCoManagedOr404`): the listing's content,
  // which is the largest thing a co-manager exists to do — hours, hours
  // exceptions, photos and the gallery, services, accessibility answers and
  // tags are all fields on this one PATCH.
  //
  // A CO-MANAGER'S PATCH CARRYING AN OWNER-PERSONAL FIELD IS REFUSED WITH 403
  // before anything is merged. Hiding those fields on read while leaving them
  // patchable would be a hole rather than a policy; see
  // `listing-owner-personal-fields.ts` for the eight fields and the argument
  // for refusing rather than dropping them.
  @Patch(':ref')
  @ApiOperation({ summary: 'Update a listing the caller owns or co-manages' })
  @ApiOkResponse({ description: 'The updated listing.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  @ApiForbiddenResponse({
    description:
      'A co-manager tried to change one of the owner’s personal fields.',
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

  // OWNER OR CO-MANAGER (same `loadOwnedOrCoManagedOr404` check as `update`
  // above, NOT a `RolesGuard` route): the business telling the directory
  // whether it is still trading. This is the OWNER's report about their own venue, which is
  // why it lives here and not on `AdminListingsController` next to the
  // moderation `status` routes. It never moves `status` and never sends the
  // listing back for review.
  @Patch(':ref/operating-state')
  @ApiOperation({
    summary: "Set a listing's operating state (open, closed, moved)",
  })
  @ApiOkResponse({ description: 'The listing with its new operating state.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  @ApiForbiddenResponse({
    description: 'The listing is not owned by the caller.',
  })
  @ApiBadRequestResponse({
    description:
      'A moved listing needs a destination, and any successor listing must be a different, live listing.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  setOperatingState(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: UpdateOperatingStateDto,
  ) {
    return this.listingsService.setOperatingState(ref, user.userId, dto);
  }

  // OWNER OR CO-MANAGER (same `loadOwnedOrCoManagedOr404` check as `update`
  // above): pause or resume the listing's appearance in the directory.
  // Reversible and destroys nothing, which is what separates it from
  // `DELETE /:ref` below, and why it is not owner-only.
  //
  // NOT to be confused with `listings.visibility`, which is the owner's own
  // identity-disclosure choice and one of the eight fields a co-manager can
  // neither read nor write.
  //
  // Sits beside `operating-state` and answers a different question. That one
  // is the business reporting whether it is still trading; this one is the
  // owner deciding whether their listing is currently shown. Overloading
  // either onto the other would have made "we are closed this month" and
  // "please take my entry down for a bit" the same statement, and they are
  // not. It never moves `status` and never sends the listing back for review.
  //
  // A hidden listing keeps every review, photo and badge it had, and the owner
  // still reaches it here and on `GET /listings/mine` to put it back.
  @Patch(':ref/visibility')
  @ApiOperation({
    summary: "Hide or show one of the member's own listings in the directory",
  })
  @ApiOkResponse({ description: 'The listing with its new visibility.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  @ApiForbiddenResponse({
    description: 'The listing is not owned by the caller.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  setDirectoryVisibility(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: UpdateListingVisibilityDto,
  ) {
    return this.listingsService.setDirectoryVisibility(ref, user.userId, dto);
  }

  // OWNER OR CO-MANAGER: "still accurate". Stamps `detailsConfirmedAt` and changes
  // nothing else, so the directory can show when a listing was last vouched
  // for by the person who runs it. A POST rather than a PATCH because it
  // carries no body at all: the act IS the payload.
  //
  // Throttled loosely rather than tightly. It is meant to be pressed often and
  // costs one indexed SELECT plus one single-column UPDATE, so the limit is
  // here to stop a script hammering it, not to ration honest use.
  @Post(':ref/confirm-details')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @ApiOperation({
    summary: "Confirm a listing's details are still accurate",
  })
  @ApiOkResponse({ description: 'The new confirmation timestamp.' })
  @ApiNotFoundResponse({ description: 'No listing with that reference.' })
  @ApiForbiddenResponse({
    description: 'The listing is not owned by the caller.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  confirmDetails(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
  ) {
    return this.listingsService.confirmDetails(ref, user.userId);
  }

  // OWNER ONLY, and it stays on `loadOwnedOr404`. A hard delete of the page,
  // its reviews, its Q&A and its photo objects is the one act on a listing that
  // whoever comes next cannot undo, so it belongs to the one accountable owner.
  // A co-manager who needs the page to stop showing has `:ref/visibility`.
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

  // OWNER OR CO-MANAGER (`loadOwnedOrCoManagedOr404`): posts or overwrites the
  // business's single public reply to a review. The reply publishes as the
  // venue either way, so nothing about which of the two typed it reaches the
  // public page.
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
  // row). Lands in the moderator-reviewable queue (`GET /admin/listings/claims`
  // / `PATCH /admin/listings/claims/:id`); throttled like `dispute` above,
  // same rationale (a member-initiated moderation-queue filing surface).
  @Post(':ref/claim')
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @ApiOperation({ summary: 'Claim ownership of an existing business listing' })
  @ApiCreatedResponse({
    description: 'The filed claim (or the caller’s existing open claim).',
  })
  @ApiBadRequestResponse({
    description: 'The caller already owns this listing.',
  })
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

  // OWNER ONLY, and it stays on `loadOwnedOr404` — the one route on this class
  // a reader might expect co-managers to reach and they do not. This is the
  // moderator's private compliance thread from review time, delivered as a DM
  // to `listing.ownerId` personally, and the questions are the vetting
  // questions (who are you to this business, what is your evidence). Answering
  // is the accountable owner speaking for themselves.
  //
  // A co-manager still SEES that one is waiting: `GET /:ref/pending` is
  // co-manager-allowed and counts the unanswered ones.
  //
  // NOT the public Q&A. That is `public-questions` below, which IS
  // co-manager-allowed.
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

  // OWNER OR CO-MANAGER (`loadOwnedOrCoManagedOr404`): answers a MEMBER'S
  // PUBLIC question, which then stays on the detail page underneath it for the
  // next reader. Leaving it owner-only would mean the person actually running
  // the page watches questions go unanswered.
  //
  // `public-questions`, not `questions`. The route directly above is the
  // moderator's private review-time thread, and the two must not collide in
  // this namespace or in anyone's head: different table, different author,
  // different audience. Asking happens on the public directory
  // (`POST /directory/:slug/questions`), because the asker is not the owner and
  // has no `ref`; answering happens here, because the answerer is.
  @Post(':ref/public-questions/:id/answer')
  @ApiOperation({
    summary: "Owner answers a member's public question on their listing",
  })
  @ApiOkResponse({ description: 'The answered question.' })
  @ApiNotFoundResponse({ description: 'No listing or question found.' })
  @ApiForbiddenResponse({
    description: 'The listing is not owned by the caller.',
  })
  @ApiBadRequestResponse({ description: 'Answer cannot be empty.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  answerPublicQuestion(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Param('id') id: string,
    @Body() dto: AnswerListingPublicQuestionDto,
  ) {
    return this.listingsService.answerPublicQuestion(
      ref,
      id,
      user.userId,
      dto.answer,
    );
  }
}
