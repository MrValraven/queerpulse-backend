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
  subscribe(
    @Body() dto: SubscribeNewsletterDto,
  ): Promise<SubscribeResultDto> {
    return this.newsletter.subscribe(dto.email);
  }

  @ApiOperation({ summary: 'Confirm a newsletter subscription via emailed token.' })
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
}
