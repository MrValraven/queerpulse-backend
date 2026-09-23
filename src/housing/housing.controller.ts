import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { CreateHousingJoinRequestDto } from './dto/create-join-request.dto';
import { HousingService } from './housing.service';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/**
 * Members-only co-op directory. `coops` is a static segment declared before the
 * `:slug`-style join-request route so route matching resolves it literally
 * (mirrors the pattern in `DirectoryController`).
 *
 * Product decision: housing co-ops are visible to QueerPulse members only
 * (reversed by the maintainer 2026-09-23). Browsing the directory and applying
 * to a co-op both require an active member, guarded the same way as the member
 * housing board in `HousingDirectoryController`. No route here is `@Public()`,
 * so the global `JwtAuthGuard` populates `request.user` before
 * `ActiveMemberGuard` reads it.
 *
 * PRD-242: recording the applicant is what makes the outcome reachable. The
 * `userId` is who receives the `HousingJoinDecided` bell row and what
 * `GET /housing/coops/join-requests/mine` matches on, so a member who applied
 * can always learn what was decided.
 */
@Feature('housing')
@ApiTags('Housing')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('housing')
export class HousingController {
  constructor(private readonly housing: HousingService) {}

  // Active members only. Member-private, so no cache header: a response gated
  // on who is asking must never land in a shared or CDN cache.
  @UseGuards(ActiveMemberGuard)
  @Get('coops')
  @ApiOperation({ summary: 'List published co-ops (members only)' })
  @ApiOkResponse({ description: 'All published co-ops.' })
  @ApiForbiddenResponse({ description: 'Active membership required.' })
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
  // Ownership is the `user_id` match in the service.
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

  // Active members only. The applicant is always a signed-in member, so the
  // decision can reach them. Still throttled per IP so the co-op review queue
  // stays clear of junk join requests; a real applicant submits once.
  //
  // `NotRestrictedGuard` stays off by the TS-09 binding rule in
  // `not-restricted.guard.ts`: a join request sits in the admin triage queue
  // until staff decide it, and those submissions stay open to a restricted
  // member.
  @UseGuards(ActiveMemberGuard)
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post('coops/:slug/join-requests')
  @ApiOperation({ summary: 'Submit a join request to a co-op (members only)' })
  @ApiCreatedResponse({ description: 'The created join request.' })
  @ApiForbiddenResponse({ description: 'Active membership required.' })
  @ApiNotFoundResponse({ description: 'No co-op with that slug.' })
  submitJoinRequest(
    @Param('slug') slug: string,
    @Body() dto: CreateHousingJoinRequestDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.housing.createJoinRequest(slug, dto, user.userId);
  }
}
