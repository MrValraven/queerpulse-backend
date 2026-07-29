import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { LinkPreviewQuery } from './dto/link-preview.query';
import { LinkPreviewResponse } from './link-preview.response';
import { LinkPreviewService } from './link-preview.service';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';

/**
 * `GET /link-preview?url=` — server-side unfurl for a URL pasted into a DM.
 * Authenticated + active-member only (never an open proxy) and throttled, since
 * each call makes an outbound fetch. Returns an all-null card when the URL can't
 * be previewed (SSRF-declined, unreachable, no metadata) — the client shows
 * nothing rather than a broken card. GET, so no CSRF token is required; the
 * global JWT guard still applies on top of `ActiveMemberGuard`.
 */
@Feature('messaging')
@ApiTags('Link Previews')
@ApiCookieAuth()
@Controller('link-preview')
@UseGuards(ActiveMemberGuard)
export class LinkPreviewController {
  constructor(private readonly linkPreviewService: LinkPreviewService) {}

  @Throttle({ default: { limit: 40, ttl: seconds(60) } })
  @Get()
  preview(@Query() query: LinkPreviewQuery): Promise<LinkPreviewResponse> {
    return this.linkPreviewService.preview(query.url);
  }
}
