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
    summary: 'Subscribe an email to the newsletter (double opt-in).',
  })
  @ApiOkResponse({
    description:
      'Acknowledged. A confirmation email is sent when the address is not yet ' +
      'confirmed; the response never reveals whether the address already existed.',
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
    summary: 'Confirm a newsletter subscription via emailed token.',
  })
  @ApiOkResponse({ description: 'The address is now confirmed.' })
  @Public()
  // Version-neutral so the link baked into the confirmation email
  // (`<API_URL>/newsletter/confirm?token=...`) answers at its unprefixed path.
  @Version(VERSION_NEUTRAL)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Get('confirm')
  confirm(@Query('token') token: string): Promise<ConfirmResultDto> {
    return this.newsletter.confirm(token);
  }

  @ApiOperation({
    summary: 'Unsubscribe from the newsletter via the emailed/link token.',
  })
  @ApiOkResponse({
    description:
      'The address is now unsubscribed. Idempotent: calling this twice is not an error.',
  })
  @Public()
  // Unlike `confirm`, this is NOT version-neutral: the confirm link is opened
  // by hitting this API directly from the raw email link, but the unsubscribe
  // link points at the frontend's confirmation page (CNT-19 asked for real
  // success/already-unsubscribed/invalid states instead of bare JSON), which
  // calls this endpoint through the normal versioned API client.
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @HttpCode(HttpStatus.OK)
  @Get('unsubscribe')
  unsubscribe(@Query('token') token: string): Promise<UnsubscribeResultDto> {
    return this.newsletter.unsubscribe(token);
  }
}
