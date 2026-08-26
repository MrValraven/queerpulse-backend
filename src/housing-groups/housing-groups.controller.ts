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
  UseGuards,
} from '@nestjs/common';
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

  // Member-submitted housing content, so the CDN window is deliberately much
  // tighter than the group metadata above and carries NO
  // `stale-while-revalidate` (BE-HSG-01): with a 30s freshness plus a 120s
  // stale window, a listing a moderator had just taken down kept being served
  // for up to another two and a half minutes. 15s with no stale tail caps the
  // takedown-propagation delay while still absorbing a burst on a busy group.
  @Public()
  @Get(':slug/listings')
  @Header('Cache-Control', 'public, s-maxage=15')
  @ApiOperation({
    summary: "A group's public listings (approved, non-hidden)",
  })
  @ApiOkResponse({ description: 'The listings.' })
  @ApiNotFoundResponse({ description: 'No published group with that slug.' })
  listListings(@Param('slug') slug: string) {
    return this.groups.listVisibleListings(slug);
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
