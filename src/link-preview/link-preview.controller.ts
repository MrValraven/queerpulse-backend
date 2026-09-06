import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { LinkPreviewBatchQuery } from './dto/link-preview-batch.query';
import { LinkPreviewQuery } from './dto/link-preview.query';
import { LinkPreviewFeatureGuard } from './link-preview-feature.guard';
import { LinkPreviewThrottlerGuard } from './link-preview-throttler.guard';
import {
  MAX_BATCH_URLS,
  UNFURL_URL_LIMIT,
  UNFURL_WINDOW_SECONDS,
} from './link-preview.constants';
import { LinkPreviewResponse } from './link-preview.response';
import { LinkPreviewService } from './link-preview.service';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/**
 * `GET /link-preview?url=` — server-side unfurl for a URL a member pasted.
 *
 * Shared by every surface where a member can paste a link: DMs, forum threads
 * and replies, and the feed cards built from them. It used to carry
 * `@Feature('messaging')`, which is a single key and so read as "messaging
 * only" — a URL in a forum thread stayed a bare string with no way to tell a
 * useful link from a dud without leaving the page. `LinkPreviewFeatureGuard`
 * replaces that tag with the honest condition (any link-pasting surface is
 * launched) and changes nothing else.
 *
 * Authenticated + active-member only (never an open proxy) and throttled, since
 * each call makes an outbound fetch. Returns an all-null card when the URL
 * can't be previewed (SSRF-declined, unreachable, no metadata): the client
 * shows nothing rather than a broken card. GET, so no CSRF token is required;
 * the global JWT guard still applies on top of `ActiveMemberGuard`.
 *
 * Guard order is deliberate: the feature check answers 404 before the
 * membership check can answer 403, and the per-URL rate guard runs last so a
 * caller who is refused for a different reason does not spend the allowance.
 * The rate guard keys its bucket on the member, which it can do anywhere in
 * this list: the global `JwtAuthGuard` populates `request.user` before any
 * controller guard runs. Sitting behind `ActiveMemberGuard` adds the guarantee
 * that the member is an active one.
 *
 * There is deliberately no `@Throttle` here. The rate limit lives inside
 * `LinkPreviewThrottlerGuard`, because a decorator on this class is read by the
 * global IP-keyed guard as well, and a number sized for one member is the wrong
 * number for everyone sharing a venue's wifi. Without it the IP bucket sits at
 * the app-wide default every other route already lives with, so nothing here is
 * left unmetered.
 */
@ApiTags('Link Previews')
@ApiCookieAuth()
@Controller('link-preview')
@UseGuards(
  LinkPreviewFeatureGuard,
  ActiveMemberGuard,
  LinkPreviewThrottlerGuard,
)
export class LinkPreviewController {
  constructor(private readonly linkPreviewService: LinkPreviewService) {}

  @Get()
  @ApiOperation({ summary: 'Server-side unfurl a URL for a link preview card' })
  @ApiOkResponse({
    description: 'A preview card; all-null when the URL cannot be previewed.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  @ApiTooManyRequestsResponse({
    description: `Over ${UNFURL_URL_LIMIT} unfurled URLs by this member in the last ${UNFURL_WINDOW_SECONDS} seconds.`,
  })
  preview(@Query() query: LinkPreviewQuery): Promise<LinkPreviewResponse> {
    return this.linkPreviewService.preview(query.url);
  }

  /**
   * `GET /link-preview/batch?url=A&url=B` — up to `MAX_BATCH_URLS` cards in one
   * round-trip, in the order requested, for a thread or feed page that quotes
   * several links. Every URL faces the identical SSRF, validation and cache
   * path a single unfurl faces, and each one costs a slot in the same rate
   * bucket, so this is a round-trip saver and gives no extra allowance.
   */
  @Get('batch')
  @ApiOperation({
    summary: 'Unfurl up to four URLs in one request, in the order requested',
  })
  @ApiQuery({
    name: 'url',
    isArray: true,
    type: String,
    description: `Repeat the parameter once per URL, at most ${MAX_BATCH_URLS}.`,
  })
  @ApiOkResponse({
    description:
      'One card per requested URL, in request order; all-null for any that cannot be previewed.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  @ApiTooManyRequestsResponse({
    description: `Over ${UNFURL_URL_LIMIT} unfurled URLs by this member in the last ${UNFURL_WINDOW_SECONDS} seconds.`,
  })
  previewBatch(
    @Query() query: LinkPreviewBatchQuery,
  ): Promise<LinkPreviewResponse[]> {
    return this.linkPreviewService.previewMany(query.url);
  }
}
