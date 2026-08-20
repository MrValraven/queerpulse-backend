import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { DirectoryService } from './directory.service';
import { CreateEditSuggestionDto } from './dto/create-edit-suggestion.dto';
import { CreateReviewDto } from './dto/create-review.dto';
import { ListDirectoryQuery } from './dto/list-directory.query';
import { ListingEditSuggestionsService } from './listing-edit-suggestions.service';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/**
 * Public, read-only directory over the businesses (`listings`) table, backing
 * the marketing surfaces (`/local/directory`, `/host`). Deliberately a
 * SEPARATE controller from `ListingsController`: that one carries a class-level
 * `ActiveMemberGuard`, and `ActiveMemberGuard` does NOT honor `@Public()` (it
 * unconditionally requires an active member), so public reads cannot live under
 * it. Every route here is `@Public()` and there is no class guard.
 *
 * `spaces` is a static segment declared before the `:slug` detail route (added
 * in a later sub-project) so route matching resolves it literally.
 *
 * Every read here carries a positive `Cache-Control` (AUDIT-2026-07-30.md §I
 * "No CDN cache headers on public GETs"): none of these responses vary by
 * caller (no `@CurrentUser()`, no session-scoped filtering), so Vercel's CDN
 * can answer repeat anonymous requests without invoking the Function or
 * touching Postgres at all for up to 60s, then serve one more stale response
 * while revalidating in the background for up to 5 more minutes (see
 * `caching-and-cost.md`). The two write routes below stay uncached (POST is
 * never cached regardless).
 */
@Feature('listings')
@ApiTags('Local Directory')
@ApiCookieAuth()
@Controller('directory')
export class DirectoryController {
  constructor(
    private readonly directoryService: DirectoryService,
    private readonly editSuggestionsService: ListingEditSuggestionsService,
  ) {}

  // Host page "Partner spaces" — live listings flagged as partner venues.
  @Public()
  @Get('spaces')
  @Header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  @ApiOperation({ summary: 'List live listings flagged as partner venues' })
  @ApiOkResponse({ description: 'The partner spaces.' })
  listPartnerSpaces() {
    return this.directoryService.listPartnerSpaces();
  }

  // Public directory grid — every live listing, optionally filtered. Bare
  // array by default; sending `page` opts into the paginated envelope (see
  // `ListDirectoryQuery.page`'s doc comment).
  @Public()
  @Get()
  @Header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  @ApiOperation({ summary: 'List the public directory of live listings' })
  @ApiOkResponse({
    description:
      'Matching directory cards — a bare array by default, or a `{items,total,page,pageSize}` page when `page` is given.',
  })
  listDirectory(@Query() query: ListDirectoryQuery) {
    return query.page
      ? this.directoryService.listDirectoryPage(query)
      : this.directoryService.listDirectory(query);
  }

  // Public Safe Spaces page — verified + removed safe spaces with hero stats.
  @Public()
  @Get('safe-spaces')
  @Header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  @ApiOperation({
    summary: 'List verified and removed safe spaces with hero stats',
  })
  @ApiOkResponse({ description: 'The safe-spaces list and stats.' })
  listSafeSpaces() {
    return this.directoryService.listSafeSpaces();
  }

  // Public Safe Space detail (verified or removed).
  @Public()
  @Get('safe-spaces/:slug')
  @Header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  @ApiOperation({ summary: 'Get a safe space (verified or removed) by slug' })
  @ApiOkResponse({ description: 'The safe-space detail.' })
  @ApiNotFoundResponse({ description: 'No safe space with that slug.' })
  getSafeSpace(@Param('slug') slug: string) {
    return this.directoryService.getSafeSpaceBySlug(slug);
  }

  // Public: every live listing owned by one member, addressed by the member's
  // profile slug. Declared BEFORE the `:slug` detail route below so the static
  // `by-member` prefix resolves literally and isn't matched as a listing slug.
  // Returns the redacted `DirectoryCardDTO[]` (never owner/contact PII); an
  // unknown/inactive member yields an empty array, not a 404.
  @Public()
  @Get('by-member/:slug')
  @Header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  @ApiOperation({
    summary: "List live listings owned by a member's profile slug",
  })
  @ApiOkResponse({
    description:
      'Redacted directory cards (empty for an unknown/inactive member).',
  })
  listByMember(@Param('slug') slug: string) {
    return this.directoryService.listByMemberSlug(slug);
  }

  // Directory detail — declared AFTER the static `spaces`/`safe-spaces` routes
  // so route matching resolves those literally rather than as `:slug`.
  @Public()
  @Get(':slug')
  @Header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  @ApiOperation({ summary: 'Get a live directory listing by slug' })
  @ApiOkResponse({ description: 'The directory detail.' })
  @ApiNotFoundResponse({ description: 'No live listing with that slug.' })
  getDirectoryListing(@Param('slug') slug: string) {
    return this.directoryService.getDirectoryBySlug(slug);
  }

  // Public: paginated reviews for a listing.
  @Public()
  @Get(':slug/reviews')
  @Header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  @ApiOperation({ summary: 'List paginated reviews for a live listing' })
  @ApiOkResponse({ description: 'A page of reviews.' })
  @ApiNotFoundResponse({ description: 'No live listing with that slug.' })
  listReviews(@Param('slug') slug: string, @Query('page') page?: string) {
    return this.directoryService.listReviews(
      slug,
      page ? Number(page) : undefined,
    );
  }

  // Member-gated: leave a review. Guarded per-route (the controller has no
  // class guard, so the reads above stay public); state-changing, so it also
  // requires the global CSRF token like every other mutation.
  @Post(':slug/reviews')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Leave a review on a live listing' })
  @ApiCreatedResponse({ description: 'The created review.' })
  @ApiNotFoundResponse({ description: 'No live listing with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  addReview(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateReviewDto,
  ) {
    return this.directoryService.addReview(slug, user.userId, dto);
  }

  // Member-gated: propose a correction to this listing ("suggest an edit"),
  // landing in the moderator queue (`GET /listings/admin/edit-suggestions`).
  // Slug-keyed like `addReview` above, NOT `ref`-keyed — this is a non-owner
  // action reached from this same public detail page, which only ever has
  // the `slug` (`ref` lives solely on the owner-scoped `ListingDTO`, 403'd
  // for a non-owner caller — see `ListingEditSuggestionsService.submit`'s
  // doc comment). Guarded per-route, same as `addReview`.
  @Post(':slug/edit-suggestions')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({
    summary: 'Suggest an edit to a live listing (moderator queue)',
  })
  @ApiCreatedResponse({
    description: 'The created edit suggestion id and status.',
  })
  @ApiNotFoundResponse({ description: 'No live listing with that slug.' })
  @ApiBadRequestResponse({
    description: 'You own the listing, or the message is empty.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  suggestEdit(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateEditSuggestionDto,
  ) {
    return this.editSuggestionsService.submit(slug, user.userId, dto);
  }
}
