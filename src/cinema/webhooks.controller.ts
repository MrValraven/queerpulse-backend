import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { SkipCsrf } from '../security/skip-csrf.decorator';
import { CinemaService } from './cinema.service';
import { MuxService } from './mux.service';

type MuxWebhookEvent = {
  type: string;
  data: {
    id: string;
    asset_id?: string;
    playback_ids?: { id: string; policy?: string }[];
    duration?: number;
    aspect_ratio?: string;
    errors?: { type?: string; messages?: string[] };
  };
};

@Controller('cinema/webhooks')
export class CinemaWebhooksController {
  constructor(
    private readonly mux: MuxService,
    private readonly cinema: CinemaService,
  ) {}

  // No cookies/JWT here — the request is authenticated by the Mux HMAC
  // signature over the raw body (hence @Public + @SkipCsrf + rawBody).
  // @SkipThrottle: a Mux retry burst after an outage must not be rate-limited
  // into 429s and dropped — the HMAC signature is the abuse control here.
  @Public()
  @SkipCsrf()
  @SkipThrottle()
  @Post('mux')
  @HttpCode(HttpStatus.OK)
  async handleMux(@Req() req: RawBodyRequest<Request>) {
    if (!req.rawBody) {
      throw new BadRequestException('Missing request body');
    }
    const event = (await this.mux.verifyWebhook(
      req.rawBody.toString('utf8'),
      req.headers,
    )) as MuxWebhookEvent;

    // The object id is the sole match key for every transition; a payload
    // missing it must be rejected, not dispatched (an undefined id in a
    // TypeORM `where` is silently dropped and would match the first row).
    if (typeof event?.data?.id !== 'string' || !event.data.id) {
      throw new BadRequestException('Malformed webhook payload');
    }

    // Handlers are idempotent; Mux retries and may deliver out of order.
    switch (event.type) {
      case 'video.upload.asset_created':
        if (typeof event.data.asset_id === 'string' && event.data.asset_id) {
          await this.cinema.onUploadAssetCreated(
            event.data.id,
            event.data.asset_id,
          );
          // Heal out-of-order delivery: video.asset.ready may have already
          // fired (and been dropped as "unknown") before this event linked
          // the asset id — poll it once now instead of waiting for the cron.
          await this.cinema.syncAssetState(event.data.asset_id);
        }
        break;
      case 'video.asset.ready':
        await this.cinema.onAssetReady(event.data.id, {
          playbackId: event.data.playback_ids?.[0]?.id ?? null,
          durationSeconds:
            event.data.duration != null
              ? Math.round(event.data.duration)
              : null,
          aspectRatio: event.data.aspect_ratio ?? null,
        });
        break;
      case 'video.asset.errored':
        await this.cinema.onAssetErrored(
          event.data.id,
          event.data.errors?.messages?.join('; ') ?? 'Asset errored',
        );
        break;
      case 'video.upload.errored':
      case 'video.upload.cancelled':
        await this.cinema.onUploadFailed(event.data.id, event.type);
        break;
      default:
        break; // acknowledge event types we don't track
    }
    return { received: true };
  }
}
