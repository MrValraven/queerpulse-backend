import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { CreateGroupJoinRequestDto } from './dto/create-group-join-request.dto';
import { CreateGroupListingDto } from './dto/create-group-listing.dto';
import { UpdateGroupListingDto } from './dto/update-group-listing.dto';
import { HousingGroupsService } from './housing-groups.service';
import {
  PUBLIC_READ_CACHE,
  PUBLIC_READ_CDN_CACHE,
} from '../common/public-read-cache';

/**
 * The listings read on an OPEN group (`isAccessGated: false`), whose answer is
 * the same for every caller. Member-submitted housing content, so the CDN
 * window is deliberately much tighter than the group metadata beside it and
 * carries NO `stale-while-revalidate` (BE-HSG-01): with a 30s freshness plus a
 * 120s stale window, a listing a moderator had just taken down kept being
 * served for up to another two and a half minutes. 15s with no stale tail caps
 * the takedown-propagation delay while still absorbing a burst on a busy group.
 */
const GROUP_LISTINGS_PUBLIC_CACHE = 'public, s-maxage=15';

/**
 * The listings read on an ACCESS-GATED group, where the same URL answers 200 to
 * a member and 403 to everyone else (ENG-172). Two variants under one URL must
 * never share a shared-cache entry: one stored member response handed to the
 * next visitor would publish exactly what the gate exists to keep in. `private`
 * bars a shared cache, and `no-store` bars holding it anywhere at all, so there
 * is nothing left to hand to a different viewer.
 */
const GATED_LISTINGS_CACHE = 'private, no-store';

/**
 * Set on BOTH branches of that read, and not optional. A shared cache keyed on
 * the URL alone would store one caller's answer and serve it to the next
 * request for the same URL regardless of its cookie. It costs the open branch
 * some cache-key cardinality, which is a fair price on a 15-second window, and
 * it keeps the gated branch honest for any intermediary that caches despite
 * `no-store`. Same reasoning as `AnonymousPublicCacheInterceptor`, which states
 * the edge incident behind it.
 */
const VARY_ON_SESSION = 'Cookie';

/**
 * Public directory of vetted housing groups. Static segments (`listings`,
 * `join-requests`) sit under the `:slug` prefix, so route matching resolves
 * them literally.
 *
 * Join requests may be submitted by anyone — the access-gated group model
 * collects a `name` and community-relationship answer precisely so a non-member
 * can ask to be let in. `OptionalJwtAuthGuard` + `@Public()` best-effort attach
 * `req.user` WHEN a valid session cookie is present (so a signed-in member's
 * `userId` is captured for the mutual-connections trust signal) without ever
 * rejecting an anonymous applicant.
 */
@Feature('housing')
@ApiTags('Housing groups')
@Controller('housing-groups')
export class HousingGroupsController {
  constructor(private readonly groups: HousingGroupsService) {}

  @Public()
  @Get()
  @Header('Cache-Control', PUBLIC_READ_CACHE)
  @Header('CDN-Cache-Control', PUBLIC_READ_CDN_CACHE)
  @ApiOperation({ summary: 'List published vetted housing groups' })
  @ApiOkResponse({ description: 'All published groups.' })
  listGroups() {
    return this.groups.listPublished();
  }

  // PRD-242. The applicant's own half of the moderator triage queue: what
  // happened to the applications THIS caller filed, across every group. The
  // bell's `housing_join_decided` row deep-links to
  // `/local/housing/groups/:slug`, and this is what that page reads to say
  // where the application stands.
  //
  // Declared BEFORE the `:slug` family so the literal two-segment path is never
  // read as a slug, and flat rather than `:slug/join-requests/mine` so it
  // matches the co-op read (`GET /housing/coops/join-requests/mine`), whose own
  // page is a grid of every co-op and cannot afford one request per card.
  //
  // Signed-in callers only (no `@Public()`, so the global `JwtAuthGuard`
  // applies) and no further guard: reading the outcome of your own application
  // is not a member-privileged action, and gating it on active membership would
  // hand the bell row a destination that answers its own recipient with a 403.
  // Ownership is the `user_id` match in the service, which an anonymous
  // by-name request can never satisfy.
  //
  // Member-private, so no cache header.
  @Get('join-requests/mine')
  @ApiOperation({ summary: 'Your own group join requests, with their state' })
  @ApiOkResponse({
    description: "The caller's own group join requests, newest first.",
  })
  listMyJoinRequests(@CurrentUser() user: CurrentUserData) {
    return this.groups.listMyJoinRequests(user.userId);
  }

  @Public()
  @Get(':slug')
  @Header('Cache-Control', PUBLIC_READ_CACHE)
  @Header('CDN-Cache-Control', PUBLIC_READ_CDN_CACHE)
  @ApiOperation({ summary: 'Get one published group by slug' })
  @ApiOkResponse({ description: 'The group.' })
  @ApiNotFoundResponse({ description: 'No published group with that slug.' })
  getGroup(@Param('slug') slug: string) {
    return this.groups.getPublishedBySlug(slug);
  }

  // ENG-172. What a group holds is for the people it has let in. An OPEN group
  // (`isAccessGated: false`) is an open reading room and stays exactly as
  // public as it has always been. An ACCESS-GATED group answers this read only
  // to a member, which is the flag's documented meaning finally applied to the
  // read side: ENG-171 stopped a stranger POSTING into a screened group while
  // leaving its rooms, their rents and their count readable by anyone with the
  // slug. A stranger still sees the group, its blurb and its norms, which is
  // what the join flow needs.
  //
  // `@Public()` + `OptionalJwtAuthGuard` is what makes that decidable at all.
  // `@Public()` alone (this route until now) means the global `JwtAuthGuard`
  // steps aside and NOTHING else populates `request.user`, so every caller
  // would look anonymous and every gated group would refuse everyone,
  // members included. The optional guard attaches the caller when a valid
  // session cookie is present and never rejects one who has none, so an
  // anonymous visitor still reaches the handler and still gets the open
  // group's list.
  //
  // The cache headers are set HERE rather than by the `@Header` decorator
  // every sibling read uses, because they now differ per branch. Nest applies
  // decorator headers before the handler runs, which would stamp
  // `public, s-maxage=15` onto the gated 403 as well and invite an edge to
  // hold it. The conservative header goes on FIRST, so a throw from the
  // service (the 404 for an unknown slug, the 403 from the gate) inherits it,
  // and only the open-group success path relaxes it.
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':slug/listings')
  @ApiOperation({
    summary: "A group's listings (approved, non-hidden; members only if gated)",
  })
  @ApiOkResponse({ description: 'The listings.' })
  @ApiForbiddenResponse({
    description:
      'The group is access-gated and the caller holds no approved join request.',
  })
  @ApiNotFoundResponse({ description: 'No published group with that slug.' })
  async listListings(
    @Param('slug') slug: string,
    // Populated best-effort by `OptionalJwtAuthGuard`; undefined when anonymous.
    @CurrentUser() user: CurrentUserData | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', GATED_LISTINGS_CACHE);
    // `res.vary()` APPENDS rather than replacing, so the `Vary: Origin` the
    // CORS layer already set survives alongside it.
    response.vary(VARY_ON_SESSION);
    const read = await this.groups.listVisibleListings(
      slug,
      user?.userId ?? null,
    );
    if (read.isCallerAgnostic) {
      response.setHeader('Cache-Control', GROUP_LISTINGS_PUBLIC_CACHE);
    }
    return read.listings;
  }

  // The poster's OWN rooms in this group, in whatever state each is in
  // (LOC-19). The public read above shows only what a moderator has cleared,
  // so a member who submitted a room watched it disappear with no surface
  // anywhere that could say it was waiting, had gone up, had a question
  // against it, or had been refused. Member-private, so no cache header: this
  // is one person's moderation state and must never reach a shared cache.
  @UseGuards(ActiveMemberGuard)
  @Get(':slug/listings/mine')
  @ApiOperation({
    summary: 'Your own rooms in this group, with their review state',
  })
  @ApiOkResponse({ description: "The caller's own listings, newest first." })
  @ApiNotFoundResponse({ description: 'No published group with that slug.' })
  listMyListings(
    @Param('slug') slug: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.groups.listMyListings(slug, user.userId);
  }

  // Anonymous public write: tightly throttled per IP so the group review queue
  // can't be flooded. `@Public()` + optional guard means an anonymous applicant
  // is allowed, a signed-in one is identified.
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post(':slug/join-requests')
  @ApiOperation({ summary: 'Ask to join a group (anonymous allowed)' })
  @ApiCreatedResponse({ description: 'The created join request.' })
  @ApiNotFoundResponse({ description: 'No published group with that slug.' })
  submitJoinRequest(
    @Param('slug') slug: string,
    @Body() dto: CreateGroupJoinRequestDto,
    @CurrentUser() user: CurrentUserData | undefined,
  ) {
    return this.groups.createJoinRequest(slug, dto, user?.userId ?? null);
  }

  // Sharing a listing into a group requires an active member. Norms (price +
  // accessibility transparency) are enforced by `CreateGroupListingDto`, and
  // the service adds the three gates the sibling member-listing surface has
  // always had (BE-HSG-01): the affirming pledge, a phone-verification step-up
  // and the deterministic risk pass. The result lands in `review` — a 201 here
  // means "submitted", never "published".
  @UseGuards(ActiveMemberGuard, NotRestrictedGuard)
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @Post(':slug/listings')
  @ApiOperation({
    summary: 'Submit a listing to a group for review (member only)',
  })
  @ApiCreatedResponse({
    description: 'The submitted listing, awaiting moderator review.',
  })
  @ApiNotFoundResponse({ description: 'No published group with that slug.' })
  createListing(
    @Param('slug') slug: string,
    @Body() dto: CreateGroupListingDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.groups.createListing(slug, dto, user.userId);
  }

  // BE-HSG-20: the poster corrects their own listing. Until this existed the
  // create was the ONLY member write on a group listing, so a wrong price could
  // not be fixed. An edit that changes what the group page shows re-opens the
  // review, so a listing cannot be approved clean and then rewritten in place.
  @UseGuards(ActiveMemberGuard, NotRestrictedGuard)
  @Patch(':slug/listings/:id')
  @ApiOperation({ summary: 'Correct your own group listing (poster only)' })
  @ApiOkResponse({ description: 'The updated listing.' })
  @ApiNotFoundResponse({ description: 'No such group or listing.' })
  @ApiForbiddenResponse({ description: 'Only the poster can edit a listing.' })
  updateListing(
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGroupListingDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.groups.updateListing(slug, id, dto, user.userId);
  }

  // BE-HSG-20: the poster withdraws their own listing once the room is let.
  // Distinct from the moderator's `hidden` takedown, which records a norm
  // violation and a reason.
  @UseGuards(ActiveMemberGuard)
  @Delete(':slug/listings/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Withdraw your own group listing (poster only)' })
  @ApiNoContentResponse({ description: 'Listing withdrawn.' })
  @ApiNotFoundResponse({ description: 'No such group or listing.' })
  @ApiForbiddenResponse({
    description: 'Only the poster can withdraw a listing.',
  })
  removeListing(
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.groups.removeListing(slug, id, user.userId);
  }
}
