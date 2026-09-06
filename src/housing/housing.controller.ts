import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { Feature } from '../common/feature.decorator';
import { CreateHousingJoinRequestDto } from './dto/create-join-request.dto';
import { HousingService } from './housing.service';
import {
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  PUBLIC_READ_CACHE,
  PUBLIC_READ_CDN_CACHE,
} from '../common/public-read-cache';

/**
 * Public co-op directory. `coops` is a static segment declared before the
 * `:slug`-style join-request route so route matching resolves it literally
 * (mirrors the pattern in `DirectoryController`).
 *
 * Product decision (maintainer-approved): join requests must be submittable
 * by ANYONE, including anonymous non-members — the public marketing page
 * collects a `name` field for exactly this reason. So the public routes are
 * `@Public()` and an anonymous applicant is never rejected.
 *
 * A `@Public()` route does NOT populate `request.user` on its own: the global
 * `JwtAuthGuard` (see `app.module.ts` / `src/auth/guards/jwt-auth.guard.ts`)
 * returns `true` immediately when `@Public()` is set, WITHOUT calling
 * `super.canActivate()` (the Passport JWT strategy that fills `request.user`).
 * `OptionalJwtAuthGuard` is what best-effort attaches the principal WHEN a
 * valid session cookie is present, so a signed-in applicant's `userId` is
 * recorded while an anonymous one still gets through. This is the same pairing
 * the sibling `HousingGroupsController` uses on its own join-request route.
 *
 * PRD-242: recording the applicant is what makes the outcome reachable. Without
 * a `userId` there is nobody to send the `HousingJoinDecided` bell row to and
 * nothing for `GET /housing/coops/join-requests/mine` to return, so a member
 * who applied had no way to ever learn what was decided.
 */
@Feature('housing')
@ApiTags('Housing')
@Controller('housing')
export class HousingController {
  constructor(private readonly housing: HousingService) {}

  // Same published-co-op response for every anonymous visitor — see
  // AUDIT-2026-07-30.md §I "No CDN cache headers on public GETs" /
  // `caching-and-cost.md`.
  @Public()
  @Get('coops')
  @Header('Cache-Control', PUBLIC_READ_CACHE)
  @Header('CDN-Cache-Control', PUBLIC_READ_CDN_CACHE)
  @ApiOperation({ summary: 'List published co-ops in the public directory' })
  @ApiOkResponse({ description: 'All published co-ops.' })
  listCoops() {
    return this.housing.listPublished();
  }

  // PRD-242. The applicant's own half of the admin triage queue: what happened
  // to the applications THIS caller filed, across every co-op. The bell's
  // `housing_join_decided` row deep-links to `/local/housing/coop`, which is a
  // single page listing every co-op, so this is one flat read for the whole
  // grid rather than a per-slug lookup repeated once per card.
  //
  // Signed-in callers only (no `@Public()`, so the global `JwtAuthGuard`
  // applies) and no further guard: reading the outcome of your own application
  // is not a member-privileged action, and gating it on active membership would
  // hand the bell row a destination that answers its own recipient with a 403.
  // Ownership is the `user_id` match in the service, which an anonymous
  // by-name request can never satisfy.
  //
  // Member-private, so no cache header: this is one person's application state
  // and must never reach a shared cache.
  @Get('coops/join-requests/mine')
  @ApiOperation({ summary: 'Your own co-op join requests, with their state' })
  @ApiOkResponse({
    description: "The caller's own co-op join requests, newest first.",
  })
  listMyJoinRequests(@CurrentUser() user: CurrentUserData) {
    return this.housing.listMyJoinRequests(user.userId);
  }

  // Anonymous public write: tightly throttled per IP so the co-op review queue
  // can't be flooded with junk join requests (the global bucket alone is too
  // loose for an unauthenticated create). A real applicant submits once.
  //
  // `@Public()` + `OptionalJwtAuthGuard` means an anonymous applicant is
  // allowed and a signed-in one is identified, so the decision can reach them.
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post('coops/:slug/join-requests')
  @ApiOperation({
    summary: 'Submit a join request to a co-op (anonymous allowed)',
  })
  @ApiCreatedResponse({ description: 'The created join request.' })
  @ApiNotFoundResponse({ description: 'No co-op with that slug.' })
  submitJoinRequest(
    @Param('slug') slug: string,
    @Body() dto: CreateHousingJoinRequestDto,
    @CurrentUser() user: CurrentUserData | undefined,
  ) {
    return this.housing.createJoinRequest(slug, dto, user?.userId ?? null);
  }
}
