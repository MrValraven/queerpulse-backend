import {
  Body,
  Controller,
  Get,
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
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { ReplyToHousingReviewDto } from './dto/reply-to-housing-review.dto';
import { SubmitHousingReviewDto } from './dto/submit-housing-review.dto';
import { UpdateHousingReviewDto } from './dto/update-housing-review.dto';
import { HousingReviewsService } from './housing-reviews.service';

/**
 * Two-sided blind reviews for housing viewings. Submitting requires a completed
 * viewing the caller took part in; reads apply the blind-reveal rule so a
 * review is never disclosed to the counterparty before it has unlocked.
 *
 * REVEAL IS THE HINGE OF BOTH WRITE ROUTES BELOW, in opposite directions. A
 * reply opens at reveal, because replying proves the lister has read the
 * review. An edit closes at reveal, because editing after reading the other
 * side would end blindness. Both defer to the one `isRevealed` predicate in the
 * service; neither restates it.
 */
@Feature('housingListings')
@ApiTags('Housing reviews')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
@Controller('housing-reviews')
@UseGuards(ActiveMemberGuard)
export class HousingReviewsController {
  constructor(private readonly service: HousingReviewsService) {}

  @Post()
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Submit a review after a completed viewing' })
  @ApiCreatedResponse({ description: "The caller's own submitted review." })
  submit(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: SubmitHousingReviewDto,
  ) {
    return this.service.submit(user.userId, dto);
  }

  // THE REVIEW'S SUBJECT ONLY (`review.subjectId`), and only once the review
  // has revealed. Replying proves the lister read the review, so allowing it
  // while the review is still blind would itself be the leak the blind window
  // exists to prevent — see `HousingReviewsService.replyToReview` for the whole
  // rule. Posting again overwrites: one reply, never a thread.
  @Patch(':reviewId/reply')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: "Post or overwrite the lister's public reply to a review",
  })
  @ApiOkResponse({ description: 'The review with the updated lister reply.' })
  @ApiNotFoundResponse({ description: 'No review with that id.' })
  @ApiForbiddenResponse({
    description:
      'Not the subject of the review, the review is the private one, or it has not revealed yet.',
  })
  @ApiBadRequestResponse({
    description: 'Malformed review id, or the reply is empty.',
  })
  replyToReview(
    @CurrentUser() user: CurrentUserData,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() dto: ReplyToHousingReviewDto,
  ) {
    return this.service.replyToReview(reviewId, user.userId, dto);
  }

  // THE REVIEW'S AUTHOR ONLY, AND ONLY WHILE THE REVIEW IS STILL BLIND. Edits
  // close at the same instant a reply opens, so a member can correct their
  // words up until they go public and not after: an edit allowed past reveal
  // would let someone settle their rating only after reading the counterparty's
  // review of them, which is the end of blindness. Never clears the lister's
  // reply, and stamps `editedAt` when something actually changed.
  //
  // Three distinct statuses on purpose, so the client can tell them apart: 404
  // no such review, 403 not yours, 409 yours but already public.
  @Patch(':reviewId')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Edit your own review, while it is still blind' })
  @ApiOkResponse({ description: 'The updated review.' })
  @ApiNotFoundResponse({ description: 'No review with that id.' })
  @ApiForbiddenResponse({ description: 'Not the author of the review.' })
  @ApiConflictResponse({
    description:
      'The review has revealed, so it is public and can no longer be changed.',
  })
  @ApiBadRequestResponse({ description: 'Malformed review id or body.' })
  updateOwnReview(
    @CurrentUser() user: CurrentUserData,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() dto: UpdateHousingReviewDto,
  ) {
    return this.service.updateOwnReview(reviewId, user.userId, dto);
  }

  @Get('viewing/:viewingId')
  @ApiOperation({
    summary: 'The blind-review pair for a viewing (from the caller)',
  })
  @ApiOkResponse({
    description: 'Your review + the counterparty (if revealed).',
  })
  forViewing(
    @CurrentUser() user: CurrentUserData,
    // BE-HSG-10: a non-UUID segment used to reach a `uuid` column comparison
    // and surface as a 500 (Postgres 22P02 through TypeORM's QueryFailedError,
    // which `AllExceptionsFilter` cannot map). Now a 400.
    @Param('viewingId', ParseUUIDPipe) viewingId: string,
  ) {
    return this.service.forViewing(viewingId, user.userId);
  }

  @Get('listing/:slug')
  @ApiOperation({
    summary: 'Public revealed reviews + average for a listing',
  })
  @ApiOkResponse({
    description: 'Aggregate rating and revealed guest reviews.',
  })
  forListing(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    // The caller is passed so the block can answer "may I write the reply?"
    // (`isViewerTheLister`) rather than leaving the frontend to guess it from a
    // profile slug comparison. The route sits behind `ActiveMemberGuard`, so
    // there is always a caller; the service still takes a nullable id so the
    // rule reads correctly if this ever becomes a public read.
    return this.service.forListing(slug, user.userId);
  }
}
