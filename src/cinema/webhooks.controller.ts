import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  RawBodyRequest,
  Req,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { SkipCsrf } from '../security/skip-csrf.decorator';
import { Feature } from '../common/feature.decorator';
import { CinemaService, MuxWebhookEvent } from './cinema.service';
import { MuxService } from './mux.service';

// Version-neutral: the `/cinema/webhooks/mux` URL is configured in the Mux
// dashboard and cannot change path in lockstep with the API version.
@ApiTags('cinema')
@Feature('cinema')
// `version: VERSION_NEUTRAL` in the @Controller options is how Nest sets
// controller-level version metadata (the standalone @Version() only works at
// the method level).
@Controller({ path: 'cinema/webhooks', version: VERSION_NEUTRAL })
export class CinemaWebhooksController {
  constructor(
    private readonly mux: MuxService,
    private readonly cinema: CinemaService,
  ) {}

  // No cookies/JWT here — the request is authenticated by the Mux HMAC
  // signature over the raw body (hence @Public + @SkipCsrf + rawBody).
  // @SkipThrottle: a Mux retry burst after an outage must not be rate-limited
  // into 429s and dropped — the HMAC signature is the abuse control here.
  //
  // Signature verification stays here (its correct home); the verified event's
  // payload → domain mapping (the event switch) lives in CinemaService.
  @Public()
  @SkipCsrf()
  @SkipThrottle()
  @Post('mux')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Receive a Mux webhook (HMAC-authenticated; no cookie auth). Version-neutral.',
  })
  @ApiOkResponse({
    description: 'The event was accepted (`{ received: true }`).',
  })
  @ApiBadRequestResponse({
    description: 'Missing request body or malformed webhook payload.',
  })
  @ApiForbiddenResponse({ description: 'Invalid Mux webhook signature.' })
  async handleMux(@Req() req: RawBodyRequest<Request>) {
    if (!req.rawBody) {
      throw new BadRequestException('Missing request body');
    }
    const event = (await this.mux.verifyWebhook(
      req.rawBody.toString('utf8'),
      req.headers,
    )) as MuxWebhookEvent;
    await this.cinema.handleWebhookEvent(event);
    return { received: true };
  }
}
