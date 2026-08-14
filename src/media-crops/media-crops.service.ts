import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MediaCrop } from './entities/media-crop.entity';
import { isIdentityCrop, type CropRect } from './crop-rect';
// `toBareKey` normalises a stored reference (bare key or `/files/<key>` URL)
// down to the bare key. It is NOT in `src/storage/storage-key.ts` (that file
// only owns key parsing/ownership: `parseStorageKey`, `isStorageKey`,
// `storageKeyOwnerId`) — it lives in its own entity-free module,
// `src/storage/bare-key.ts`, shared with `media-references` (which
// re-exports it for its existing importers).
import { toBareKey } from '../storage/bare-key';

@Injectable()
export class MediaCropService {
  constructor(
    @InjectRepository(MediaCrop)
    private readonly repository: Repository<MediaCrop>,
  ) {}

  async upsert(
    storageKey: string,
    ownerId: string,
    crop: CropRect,
  ): Promise<void> {
    const bareKey = toBareKey(storageKey);
    if (isIdentityCrop(crop)) {
      await this.remove(bareKey);
      return;
    }
    await this.repository.save({ storageKey: bareKey, ownerId, crop });
  }

  async remove(storageKey: string): Promise<void> {
    await this.repository.delete(toBareKey(storageKey));
  }

  async getMany(storageKeys: string[]): Promise<Map<string, CropRect>> {
    const bareKeys = [...new Set(storageKeys.filter(Boolean).map(toBareKey))];
    if (bareKeys.length === 0) return new Map();
    const rows = await this.repository.find({
      where: { storageKey: In(bareKeys) },
    });
    return new Map(rows.map((row) => [row.storageKey, row.crop]));
  }
}
