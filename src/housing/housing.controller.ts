import { Body, Controller, Get, Header, Param, Post } from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import {} from '../auth/decorators/current-user.decorator';
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
 * collects a `name` field for exactly this reason. So both routes are
 * `@Public()` and there is no auth guard on the join-request route.
 *
 * `userId` is therefore always `null` here rather than best-effort read from
 * `request.user`: the global `JwtAuthGuard` (see `app.module.ts` /
 * `src/auth/guards/jwt-auth.guard.ts`) returns `true` immediately when
 * `@Public()` is set, WITHOUT calling `super.canActivate()` (the Passport JWT
 * strategy that populates `request.user`). So on a `@Public()` route
 * `request.user` is never populated, even with a valid session cookie — there
 * is nothing to read.
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

  // Anonymous public write: tightly throttled per IP so the co-op review queue
  // can't be flooded with junk join requests (the global bucket alone is too
  // loose for an unauthenticated create). A real applicant submits once.
  @Public()
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
  ) {
    return this.housing.createJoinRequest(slug, dto, null);
  }
}
