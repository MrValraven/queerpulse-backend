import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
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
  @Public()
  @SkipCsrf()
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

    // Handlers are idempotent; Mux retries and may deliver out of order.
    switch (event.type) {
      case 'video.upload.asset_created':
        if (event.data.asset_id) {
          await this.cinema.onUploadAssetCreated(
            event.data.id,
            event.data.asset_id,
          );
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
