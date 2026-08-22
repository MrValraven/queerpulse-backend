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
import { AnswerListingQuestionDto } from './dto/answer-listing-question.dto';
import { CreateListingClaimDto } from './dto/create-listing-claim.dto';
import { CreateListingDto } from './dto/create-listing.dto';
import { DisputeListingDto } from './dto/dispute-listing.dto';
import { SimilarListingsQuery } from './dto/similar-listings.query';
import { ListMyListingsQuery } from './dto/list-my-listings.query';
import { ReplyToReviewDto } from './dto/reply-to-review.dto';
import { UpdateListingDto } from './dto/update-listing.dto';
import { ListingClaimsService } from './listing-claims.service';
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
 * Every route here is either owner-gated in the service (`assertOwner`) or
 * open to any active member (`dispute`, `claim`). There is deliberately NO
 * role-gated route left on this class: the moderator/admin surface moved to
 * `AdminListingsController` (`/admin/listings/*`) so the whole class shares
 * one guard shape instead of mixing three (BE-HSG-29).
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
    return this.listingsService.findSimilar(
      query.name,
      query.lat,
      query.lng,
      query.excludeRef,
    );
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
}
