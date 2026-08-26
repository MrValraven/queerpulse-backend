import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { CreateListingEnquiryDto } from './dto/create-listing-enquiry.dto';
import { ListingEnquiriesService } from './listing-enquiries.service';

/**
 * "Message this business" on a directory listing, for signed-in members.
 *
 * Its own controller rather than two more routes on `DirectoryController`, and
 * the reason is that controller's central invariant: every route on it is
 * `@Public()`, carries a positive `Cache-Control`, and returns a response that
 * is identical for every caller, precisely so a CDN can answer repeat anonymous
 * requests without touching Postgres. Both routes here are the opposite of all
 * three. They require a session, they vary per caller in the strongest possible
 * sense (whether YOU can write to this business, and whether YOU already have),
 * and a cached answer would hand one member another member's conversation id.
 * Keeping them apart makes that impossible by construction instead of by
 * remembering to leave a header off.
 *
 * Both hang off `/directory/:slug` because that is how the public detail page
 * addresses a listing. `ListingsController`'s routes are keyed by `ref` and are
 * the OWNER's view of their own submission, which is the wrong shape and the
 * wrong audience for this.
 */
@Feature('listings')
@ApiTags('Local Directory')
@ApiCookieAuth('access_token')
@Controller('directory')
@UseGuards(ActiveMemberGuard)
export class ListingEnquiriesController {
  constructor(
    private readonly listingEnquiriesService: ListingEnquiriesService,
  ) {}

  // Read-only, so it is throttled loosely: the detail page calls it once on
  // load to decide whether to render the contact button at all.
  @Get(':slug/contact')
  @Throttle({ default: { limit: 60, ttl: seconds(60) } })
  @ApiOperation({
    summary: 'Whether the caller can message this listing’s business',
  })
  @ApiOkResponse({
    description:
      'Whether the owner is reachable, why not when they are not, whether a reply will need a connection, and any conversation the caller already has with them.',
  })
  @ApiNotFoundResponse({ description: 'No live listing with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  getContact(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.listingEnquiriesService.getContact(slug, user.userId);
  }

  // Tight per-caller throttle on the WRITE, mirroring `POST /reports` and the
  // public-question route: this puts a message in somebody's inbox. The counted
  // per-listing and per-day caps in the service are the layer this one cannot
  // express (see `ListingEnquiriesService`).
  @Post(':slug/enquiries')
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 5, ttl: seconds(300) } })
  @ApiOperation({
    summary: 'Send a private enquiry to a listing’s business through messaging',
  })
  @ApiCreatedResponse({
    description: 'The conversation the enquiry was delivered into.',
  })
  @ApiBadRequestResponse({
    description:
      'The listing has no business account to write to, or it is the caller’s own.',
  })
  @ApiForbiddenResponse({ description: 'The two members cannot message.' })
  @ApiNotFoundResponse({ description: 'No live listing with that slug.' })
  @ApiTooManyRequestsResponse({
    description: 'The caller has hit a per-listing or per-day enquiry cap.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  send(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateListingEnquiryDto,
  ) {
    return this.listingEnquiriesService.send(slug, user.userId, dto);
  }
}
