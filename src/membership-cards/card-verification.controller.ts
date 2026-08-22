import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { CardVerificationService } from './card-verification.service';

/**
 * The public card verification endpoint. Deliberately unauthenticated: the
 * point of a membership card is that a stranger at a door can check it
 * without holding a QueerPulse account.
 *
 * `ThrottlerGuard` is already bound globally as `APP_GUARD` (see
 * `app.module.ts`'s `HttpThrottlerGuard`), so no per-controller
 * `@UseGuards` is needed here — only a tighter-than-default `@Throttle`.
 * This is throttled harder than the platform default (120/60s), because an
 * unauthenticated endpoint that resolves a token to a person's name is
 * exactly the surface a scraper would target.
 */
@Controller('cards/verify')
export class CardVerificationController {
  constructor(private readonly verification: CardVerificationService) {}

  @Public()
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Get(':token')
  async verify(@Param('token') token: string) {
    const result = await this.verification.verify(token);
    // A single 404 for every failure. Never distinguish "bad signature" from
    // "expired" from "no such card".
    if (!result) throw new NotFoundException('Card could not be verified');
    return result;
  }
}
