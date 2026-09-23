import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StickerPack, StickerPackStatus } from './entities/sticker-pack.entity';
import { StickerPackResponse, toStickerPackResponse } from './sticker-response';

@Injectable()
export class StickersService {
  constructor(
    @InjectRepository(StickerPack)
    private readonly packs: Repository<StickerPack>,
  ) {}

  /**
   * Every published pack with its stickers, pack order then sticker order.
   *
   * One query with a join rather than a query per pack: the whole catalogue
   * is a handful of packs and a few hundred small rows, the frontend caches
   * it for a long time, and it is read on every composer open.
   */
  async listPublishedPacks(): Promise<StickerPackResponse[]> {
    const packs = await this.packs.find({
      where: { status: StickerPackStatus.Published },
      relations: { stickers: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
    return packs.map(toStickerPackResponse);
  }
}
