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
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import {
  NO_STALE_READ_CDN_CACHE,
  PUBLIC_READ_CACHE,
  PUBLIC_READ_CDN_CACHE,
} from '../common/public-read-cache';
import { AnonymousNoStaleCacheInterceptor } from '../subprofiles/anonymous-public-cache.interceptor';
import { UserStatus } from '../users/entities/user.entity';
import { DirectoryService } from './directory.service';
import { AskListingPublicQuestionDto } from './dto/ask-listing-public-question.dto';
import { CreateEditSuggestionDto } from './dto/create-edit-suggestion.dto';
import { CreateListingReviewDto } from './dto/create-review.dto';
import {
  ListAdultDirectoryQuery,
  ListListingDirectoryQuery,
} from './dto/list-directory.query';
import { UpdateReviewDto } from './dto/update-review.dto';
import { ListingEditSuggestionsService } from './listing-edit-suggestions.service';
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

/*
 * Which public reads here use `NO_STALE_READ_CDN_CACHE` in place of
 * `PUBLIC_READ_CDN_CACHE`, and why.
 *
 * The difference is the stale window, and only the stale window. The shared
 * default is `s-maxage=60, stale-while-revalidate=300`: 60 seconds fresh, then
 * up to five more minutes in which the CDN knowingly serves the stale copy and
 * refreshes behind it. For static data such as the tag vocabulary that is
 * exactly right, and it is why it is the default.
 *
 * Two facts here are designed to take effect promptly. A badge suspension:
 * three members flag a space and the badge stops speaking that instant, because
 * the promise the platform published is that it does. And a listing leaving the
 * public directory: an owner pausing it, or moving it into the 18+ category
 * that logged-out visitors never see. Under the shared header a stored copy
 * could go on presenting a withdrawn trust claim, or a listing its owner has
 * taken out of public view, for up to six minutes.
 *
 * So every read that carries either fact keeps the 60-second freshness window
 * and drops the stale window: the badge-bearing grids (`GET /directory`,
 * `safe-spaces`, `safe-spaces/:slug`, `by-member/:slug`), the partner spaces
 * (`GET /directory/spaces`), and the listing detail with its reviews and
 * questions (`:slug`, `:slug/reviews`, `:slug/questions`). Those three set
 * their headers through `AnonymousNoStaleCacheInterceptor`, which is
 * `AnonymousPublicCacheInterceptor` with this one value changed, so the
 * subprofile surfaces on the original keep theirs. The cost is
 * small and bounded: after 60 seconds an edge revalidates, and these responses
 * carry an ETag, so an unchanged page comes back 304 with no body. The
 * worst-case lag between the change being written and a logged-out visitor
 * seeing it falls from about six minutes to about one.
 */

/** Both cache headers of a members-only read: nothing stores it. */
const MEMBER_ONLY_READ_CACHE = 'private, no-store';

/**
 * Public, read-only directory over the businesses (`listings`) table, backing
 * the marketing surfaces (`/local/directory`, `/host`). Deliberately a
 * SEPARATE controller from `ListingsController`: that one carries a class-level
 * `ActiveMemberGuard`, and `ActiveMemberGuard` does NOT honor `@Public()` (it
 * unconditionally requires an active member), so public reads cannot live under
 * it. Every read here is `@Public()` except `GET /directory/adult`, and there
 * is no class guard.
 *
 * `spaces` and `tags` are static segments declared before the `:slug` detail
 * route (added in a later sub-project) so route matching resolves them
 * literally.
 *
 * Every public read here carries a positive cache header (AUDIT-2026-07-30.md
 * §I "No CDN cache headers on public GETs"), so Vercel's CDN can answer repeat
 * anonymous requests without invoking the Function or touching Postgres at all
 * for up to 60s (see `caching-and-cost.md`). Only `GET /directory/tags` adds
 * the shared stale window on top (`PUBLIC_READ_CDN_CACHE`: one more stale
 * response while revalidating for up to 5 more minutes), because its static
 * vocabulary names no listing. Every other public read uses the 60s window
 * with no stale answer (`NO_STALE_READ_CDN_CACHE`, see the block above). Any
 * stale window is addressed to the CDN ALONE, via `CDN-Cache-Control`: see
 * `common/public-read-cache.ts` for why a browser must never be given it. The
 * write routes stay uncached (POST/PATCH/DELETE are never cached regardless).
 *
 * That caching is also why no response here carries a per-caller field. A CDN
 * hit is served to everybody from one stored copy, so a "have I voted on this
 * review" flag on a cached read would be handed to the next reader as if it
 * were theirs. The helpful-vote WRITE routes return that answer instead, which
 * is the only place it is genuinely caller-specific.
 *
 * THREE reads are exceptions and state why at their own declarations: the
 * listing detail (`GET /directory/:slug`) and its two child reads
 * (`GET /directory/:slug/reviews`, `GET /directory/:slug/questions`). The
 * detail widens its "upcoming gatherings" block for a signed-in active member,
 * and all three answer an 18+ listing to a member while an anonymous caller
 * gets the 404 a missing slug gets. They carry `OptionalJwtAuthGuard` +
 * `AnonymousNoStaleCacheInterceptor` in place of the static `@Header` pair.
 * Only their anonymous variant is shared-cacheable; the member variant is
 * `private, no-store`, and both send `Vary: Cookie`. Any future per-caller
 * field on a read here needs the same treatment.
 *
 * `GET /directory/adult` is the one members-only read: `ActiveMemberGuard`
 * and `private, no-store` on both cache headers, so no CDN ever stores it.
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
  @Header('Cache-Control', PUBLIC_READ_CACHE)
  // Lists listings by identity, so a paused listing must drop out promptly.
  @Header('CDN-Cache-Control', NO_STALE_READ_CDN_CACHE)
  @ApiOperation({ summary: 'List live listings flagged as partner venues' })
  @ApiOkResponse({ description: 'The partner spaces.' })
  listPartnerSpaces() {
    return this.directoryService.listPartnerSpaces();
  }

  // The curated listing tag vocabulary, grouped, for the "list your business"
  // wizard and the listing editor's tag picker. Static data, so it caches like
  // every other public read here. A static segment, so it sits above the
  // `:slug` detail route.
  @Public()
  @Get('tags')
  @Header('Cache-Control', PUBLIC_READ_CACHE)
  @Header('CDN-Cache-Control', PUBLIC_READ_CDN_CACHE)
  @ApiOperation({
    summary: 'List the curated listing tag vocabulary, grouped',
  })
  @ApiOkResponse({
    description:
      "Every `{ id, tags, onlineTags }` group a listing may pick tags from, in display order. `tags` are offered to listings with a physical place and `onlineTags` to online-only listings; either may be empty. Tags are the stored English values. Create and update accept any tag from either list, whatever the listing's `online` flag, and reject everything else.",
  })
  listTagVocabulary() {
    return this.directoryService.listTagVocabulary();
  }

  // Public directory grid — every live listing, optionally filtered. Bare
  // array by default; sending `page` opts into the paginated envelope (see
  // `ListListingDirectoryQuery.page`'s doc comment).
  @Public()
  @Get()
  @Header('Cache-Control', PUBLIC_READ_CACHE)
  // Badge-bearing: every card carries `safeSpaceStatus`, and `safe=verified`
  // filters on it. See `NO_STALE_READ_CDN_CACHE`.
  @Header('CDN-Cache-Control', NO_STALE_READ_CDN_CACHE)
  @ApiOperation({ summary: 'List the public directory of live listings' })
  @ApiOkResponse({
    description:
      'Matching directory cards — a bare array by default, or a `{items,total,page,pageSize}` page when `page` is given.',
  })
  listDirectory(@Query() query: ListListingDirectoryQuery) {
    return query.page
      ? this.directoryService.listDirectoryPage(query)
      : this.directoryService.listDirectory(query);
  }

  // Public Safe Spaces page — verified + removed safe spaces with hero stats.
  @Public()
  @Get('safe-spaces')
  @Header('Cache-Control', PUBLIC_READ_CACHE)
  // Badge-bearing, and entirely so: this page IS the trust claim.
  @Header('CDN-Cache-Control', NO_STALE_READ_CDN_CACHE)
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
  @Header('Cache-Control', PUBLIC_READ_CACHE)
  // Badge-bearing: carries `isBadgeSuspended`.
  @Header('CDN-Cache-Control', NO_STALE_READ_CDN_CACHE)
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
  @Header('Cache-Control', PUBLIC_READ_CACHE)
  // Badge-bearing: returns `DirectoryCardDTO[]`.
  @Header('CDN-Cache-Control', NO_STALE_READ_CDN_CACHE)
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

  // Members only: the 18+ listings, for the Online tab's "Show 18+ shops"
  // chip. Every public grid leaves these out, so this is the one read that
  // lists them. A static segment, so it sits above the `:slug` detail route.
  @Get('adult')
  @UseGuards(ActiveMemberGuard)
  @Header('Cache-Control', MEMBER_ONLY_READ_CACHE)
  @Header('CDN-Cache-Control', MEMBER_ONLY_READ_CACHE)
  @ApiOperation({ summary: 'List live 18+ listings (members only)' })
  @ApiOkResponse({
    description:
      'Up to 100 directory cards, each with `isAdultsOnly: true`, in the grid order. Accepts `cat` and `q` only.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  listAdultDirectory(@Query() query: ListAdultDirectoryQuery) {
    return this.directoryService.listAdultDirectory(query);
  }

  // Directory detail — declared AFTER the static `spaces`/`safe-spaces` routes
  // so route matching resolves those literally rather than as `:slug`.
  //
  // The first of the three caller-aware reads named in the class doc, and the
  // reason they carry `OptionalJwtAuthGuard` + `AnonymousNoStaleCacheInterceptor`
  // in place of the static `@Header` pair the public grids use.
  //
  // The `upcoming` block lists gatherings held at this venue. A gathering
  // scoped `members` is for signed-in members and nobody else, so the response
  // has two variants: the anonymous one carries `public` gatherings only, and
  // the active-member one also carries `members`. Two variants under one URL
  // must never share a shared-cache entry, so the interceptor gives the
  // anonymous variant the CDN-cacheable header pair and the authenticated
  // variant `private, no-store`, and sets `Vary: Cookie` on both. Handing the
  // member variant to a CDN would publish an invite-only support group's title,
  // slug and start time to the open web for the next sixty seconds.
  //
  // The four narrower tiers (`invite_only`, `network`, `extended_network`,
  // `community`) never appear in either variant: their audience is a
  // per-viewer computation this cached surface cannot do, and a venue page is
  // not where that computation belongs.
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @UseInterceptors(AnonymousNoStaleCacheInterceptor)
  @Get(':slug')
  @ApiOperation({ summary: 'Get a live directory listing by slug' })
  @ApiOkResponse({ description: 'The directory detail.' })
  @ApiNotFoundResponse({ description: 'No live listing with that slug.' })
  getDirectoryListing(
    // Populated best-effort by `OptionalJwtAuthGuard`; undefined when anonymous.
    @CurrentUser() user: CurrentUserData | undefined,
    @Param('slug') slug: string,
  ) {
    return this.directoryService.getDirectoryBySlug(
      slug,
      user?.status === UserStatus.Active,
    );
  }

  // Public: paginated reviews for a listing. Caller-aware like the detail
  // above it: an 18+ listing's reviews 404 for an anonymous caller and load
  // for a signed-in active member, so the anonymous variant is the only one a
  // shared cache may keep.
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @UseInterceptors(AnonymousNoStaleCacheInterceptor)
  @Get(':slug/reviews')
  @ApiOperation({ summary: 'List paginated reviews for a live listing' })
  @ApiOkResponse({ description: 'A page of reviews.' })
  @ApiNotFoundResponse({ description: 'No live listing with that slug.' })
  listReviews(
    @CurrentUser() user: CurrentUserData | undefined,
    @Param('slug') slug: string,
    @Query('page') page?: string,
  ) {
    return this.directoryService.listReviews(
      slug,
      page ? Number(page) : undefined,
      user?.status === UserStatus.Active,
    );
  }

  // Member-gated: leave a review. Guarded per-route (the controller has no
  // class guard, so the reads above stay public); state-changing, so it also
  // requires the global CSRF token like every other mutation.
  @Post(':slug/reviews')
  @UseGuards(ActiveMemberGuard, NotRestrictedGuard)
  @ApiOperation({ summary: 'Leave a review on a live listing' })
  @ApiCreatedResponse({ description: 'The created review.' })
  @ApiNotFoundResponse({ description: 'No live listing with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  addReview(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateListingReviewDto,
  ) {
    return this.directoryService.addReview(slug, user.userId, dto);
  }

  // Member-gated: the REVIEWER edits their own review. Slug-keyed and living
  // here rather than under `/listings/:ref`, for the same reason `addReview`
  // is: `ref` is the OWNER-scoped identifier, a reviewer is by definition not
  // the owner (owners cannot review their own listing), and this action is
  // reached from this same public detail page, which only ever holds the slug.
  //
  // The owner's `PATCH /listings/:ref/reviews/:reviewId/reply` is the
  // deliberate mirror image of this: two different people, editing two
  // different parts of the same row, through the namespace each of them
  // actually has an identifier for.
  @Patch(':slug/reviews/:reviewId')
  @UseGuards(ActiveMemberGuard, NotRestrictedGuard)
  @ApiOperation({ summary: 'Edit your own review on a live listing' })
  @ApiOkResponse({ description: 'The updated review.' })
  @ApiNotFoundResponse({ description: 'No live listing or review found.' })
  @ApiForbiddenResponse({ description: 'The review is not yours.' })
  @ApiBadRequestResponse({
    description: 'Malformed review id, or the review is empty.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  updateReview(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() dto: UpdateReviewDto,
  ) {
    return this.directoryService.updateReview(slug, reviewId, user.userId, dto);
  }

  // Member-gated: mark a review helpful. Idempotent, so a double-tap answers
  // with the same count rather than a 409 — see `DirectoryService.voteHelpful`.
  //
  // `HttpCode(200)` rather than the POST default of 201: repeating this request
  // creates nothing the second time, and answering "201 Created" to a call that
  // created nothing describes the wrong thing.
  //
  // Throttled loosely. The write is one `ON CONFLICT DO NOTHING` insert plus a
  // single-review recount, and the button is meant to be pressed; the limit is
  // here to stop a script, not to ration honest use. Mirrors
  // `POST /listings/:ref/confirm-details`, which makes the same argument.
  @Post(':slug/reviews/:reviewId/helpful')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ActiveMemberGuard)
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @ApiOperation({ summary: 'Mark a review helpful' })
  @ApiOkResponse({ description: 'The refreshed helpful count.' })
  @ApiNotFoundResponse({ description: 'No live listing or review found.' })
  @ApiBadRequestResponse({
    description: 'Malformed review id, or you cannot vote on your own review.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  voteHelpful(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
  ) {
    return this.directoryService.voteHelpful(slug, reviewId, user.userId);
  }

  // Member-gated: take a helpful vote back. Also idempotent — withdrawing a
  // vote that was never cast answers with the unchanged count. Returns the
  // refreshed count rather than 204, so the client can render the new number
  // without a follow-up read.
  @Delete(':slug/reviews/:reviewId/helpful')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ActiveMemberGuard)
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @ApiOperation({ summary: 'Withdraw your helpful vote on a review' })
  @ApiOkResponse({ description: 'The refreshed helpful count.' })
  @ApiNotFoundResponse({ description: 'No live listing or review found.' })
  @ApiBadRequestResponse({ description: 'Malformed review id.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  withdrawHelpfulVote(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
  ) {
    return this.directoryService.withdrawHelpfulVote(
      slug,
      reviewId,
      user.userId,
    );
  }

  // Public: the full Q&A history for a listing, newest first, answers inline.
  // The detail read embeds only the most recent handful; this is the "see all".
  // Caller-aware for the reason the reviews read is: an 18+ listing's
  // questions 404 for an anonymous caller.
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @UseInterceptors(AnonymousNoStaleCacheInterceptor)
  @Get(':slug/questions')
  @ApiOperation({ summary: 'List public questions and answers for a listing' })
  @ApiOkResponse({ description: 'A page of questions with answers inline.' })
  @ApiNotFoundResponse({ description: 'No live listing with that slug.' })
  listQuestions(
    @CurrentUser() user: CurrentUserData | undefined,
    @Param('slug') slug: string,
    @Query('page') page?: string,
  ) {
    return this.directoryService.listQuestions(
      slug,
      page ? Number(page) : undefined,
      user?.status === UserStatus.Active,
    );
  }

  // Member-gated: ask the business a question, in public.
  //
  // Throttled HARD compared with the review and helpful routes, and that gap is
  // intentional. This is the one endpoint here that publishes unreviewed member
  // prose onto a business's page, where the business then has to answer it or
  // wear it, so a burst is worth stopping outright.
  //
  // The HTTP throttle is only the first of three layers, and on its own it is
  // the weakest: it tracks by IP over a 60-second window, while the shape that
  // actually hurts a queer venue is a slow drip from one account over days.
  // `DirectoryService.askQuestion` carries the two counted per-member caps that
  // cover that, and documents what each is defending against.
  @Post(':slug/questions')
  @UseGuards(ActiveMemberGuard, NotRestrictedGuard)
  @Throttle({ default: { limit: 5, ttl: seconds(300) } })
  @ApiOperation({ summary: 'Ask a public question about a live listing' })
  @ApiCreatedResponse({ description: 'The posted question, not yet answered.' })
  @ApiNotFoundResponse({ description: 'No live listing with that slug.' })
  @ApiBadRequestResponse({
    description: 'You own the listing, or the question is too short.',
  })
  @ApiTooManyRequestsResponse({
    description:
      'Too many questions: either unanswered ones already outstanding on this listing, or too many asked today.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  askQuestion(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: AskListingPublicQuestionDto,
  ) {
    return this.directoryService.askQuestion(slug, user.userId, dto);
  }

  // Member-gated: propose a correction to this listing ("suggest an edit"),
  // landing in the moderator queue (`GET /admin/listings/edit-suggestions`).
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
