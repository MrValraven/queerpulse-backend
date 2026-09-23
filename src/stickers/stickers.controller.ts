import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { StickersService } from './stickers.service';
import type { StickerPackResponse } from './sticker-response';

/**
 * The member-facing sticker catalogue, read by the composer's sticker picker.
 *
 * Authenticated like the rest of the app (the global JwtAuthGuard applies;
 * this route is not `@Public()`), because only a member can send a sticker
 * and there is no reason to hand the catalogue to a crawler. The PNG bytes
 * themselves are public through `GET /files/*`, which is a separate decision
 * documented on the `sticker` upload kind.
 */
@ApiTags('Stickers')
@Controller('sticker-packs')
export class StickersController {
  constructor(private readonly stickers: StickersService) {}

  @Get()
  @ApiOperation({ summary: 'List every published sticker pack' })
  @ApiOkResponse({ description: 'Published packs, each with its stickers.' })
  list(): Promise<StickerPackResponse[]> {
    return this.stickers.listPublishedPacks();
  }
}
