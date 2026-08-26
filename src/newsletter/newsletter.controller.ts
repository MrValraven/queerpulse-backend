import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  VERSION_NEUTRAL,
  Version,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, seconds } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { SkipCsrf } from '../security/skip-csrf.decorator';
import type {
  ConfirmResultDto,
  SubscribeResultDto,
  UnsubscribeResultDto,
} from './dto/newsletter-response.dto';
import { SubscribeNewsletterDto } from './dto/subscribe-newsletter.dto';
import { NewsletterService } from './newsletter.service';

@ApiTags('newsletter')
@Controller('newsletter')
export class NewsletterController {
  constructor(private readonly newsletter: NewsletterService) {}

  @ApiOperation({
    summary: 'Record an email address for the newsletter (nothing is sent).',
  })
  @ApiOkResponse({
    description:
      'Acknowledged. QueerPulse delivers no email, so no confirmation link is ' +
      'sent and the row stays pending; the response never reveals whether the ' +
      'address already existed.',
  })
  @Public()
  // Public form on the marketing homepage; keep it modest to blunt abuse. CSRF
  // still applies (the SPA bootstraps a token via /csrf-token, exactly like login).
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @HttpCode(HttpStatus.OK)
  @Post('subscribe')
  subscribe(@Body() dto: SubscribeNewsletterDto): Promise<SubscribeResultDto> {
    return this.newsletter.subscribe(dto.email);
  }

  @ApiOperation({
    summary: 'Confirm a newsletter subscription by token.',
  })
  @ApiOkResponse({ description: 'The address is now confirmed.' })
  @Public()
  // Version-neutral so a bare `<API_URL>/newsletter/confirm?token=...` answers
  // at its unprefixed path.
  //
  // STATE-CHANGING GET, knowingly: this is the shape of link that was handed
  // out historically, so it keeps working for anyone still holding one. It is
  // the weak half of a confirmation step (a link scanner that follows GET
  // links confirms the address on its own), and the POST below is the
  // replacement. Nothing in this repository delivers either link: QueerPulse
  // delivers no email, so both routes only ever serve a token someone was
  // handed out of band.
  @Version(VERSION_NEUTRAL)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Get('confirm')
  confirm(@Query('token') token: string): Promise<ConfirmResultDto> {
    return this.newsletter.confirm(token);
  }

  @ApiOperation({
    summary: 'Confirm a newsletter subscription (human-initiated POST).',
  })
  @ApiOkResponse({ description: 'The address is now confirmed.' })
  @Public()
  // The half of double opt-in a link scanner cannot trip: a POST needs a real
  // click on a real page. Mirrors `POST /newsletter/subscribe` — versioned, and
  // CSRF-guarded like every other SPA write (the marketing site already
  // bootstraps a token via `/csrf-token`), which is also why this one is NOT
  // `@SkipCsrf()` the way one-click unsubscribe has to be: no mail client ever
  // posts here, only the frontend confirmation page does.
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @HttpCode(HttpStatus.OK)
  @Post('confirm')
  confirmByPost(@Query('token') token: string): Promise<ConfirmResultDto> {
    return this.newsletter.confirm(token);
  }

  @ApiOperation({
    summary: 'Unsubscribe from the newsletter with the subscription token.',
  })
  @ApiOkResponse({
    description:
      'The address is now unsubscribed. Idempotent: calling this twice is not an error.',
  })
  @Public()
  // Unlike `confirm`, this is NOT version-neutral: a confirm link is opened by
  // hitting this API directly, but the unsubscribe link points at the
  // frontend's confirmation page (CNT-19 asked for real
  // success/already-unsubscribed/invalid states instead of bare JSON), which
  // calls this endpoint through the normal versioned API client.
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @HttpCode(HttpStatus.OK)
  @Get('unsubscribe')
  unsubscribe(@Query('token') token: string): Promise<UnsubscribeResultDto> {
    return this.newsletter.unsubscribe(token);
  }

  @ApiOperation({
    summary: 'One-click unsubscribe (RFC 8058) for bulk mail clients.',
  })
  @ApiOkResponse({
    description:
      'The address is now unsubscribed. Idempotent, exactly like the GET.',
  })
  @Public()
  // RFC 8058 shape, kept for any `List-Unsubscribe` URI that was ever handed
  // out: the URI has to accept a bare POST, with no browser session, no
  // landing page and no confirmation step. QueerPulse sends no bulk mail, so
  // nothing generates such a header today; the route stays because a token
  // holder must always be able to opt out. Hence:
  //
  // - `@Version(VERSION_NEUTRAL)`: such a URL is unversioned and must keep
  //   answering across API versions, same reasoning as `confirm` above.
  // - `@SkipCsrf()`: there is no SPA and no CSRF token in a mail client's
  //   POST. The route carries its OWN request authentication — the unguessable
  //   32-byte `confirmToken` — which is exactly the "routes with their own
  //   request authentication" case the decorator exists for. Nothing an
  //   attacker could forge cross-site helps: without the token the request
  //   does nothing, and with the token they could have used the GET anyway.
  // - The action is strictly REMOVAL of consent, so the worst case of a
  //   spurious call is a member stops receiving mail they can re-subscribe to.
  @SkipCsrf()
  @Version(VERSION_NEUTRAL)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @HttpCode(HttpStatus.OK)
  @Post('unsubscribe')
  unsubscribeOneClick(
    @Query('token') token: string,
  ): Promise<UnsubscribeResultDto> {
    return this.newsletter.unsubscribe(token);
  }
}
