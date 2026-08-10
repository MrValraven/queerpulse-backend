import { Inject, Injectable } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import {
  UPLOAD_KIND_SPECS,
  UPLOAD_KINDS,
  UploadKind,
} from '../storage/upload-kinds';
import { MyMediaItem } from './dto/my-media-item.dto';
import {
  MY_MEDIA_USAGE_RESOLVER,
  MyMediaUsageResolver,
} from './my-media-usage.resolver';

const MAX_KEYS_PER_PAGE = 1000;

@Injectable()
export class MyMediaService {
  constructor(
    private readonly storage: StorageService,
    @Inject(MY_MEDIA_USAGE_RESOLVER)
    private readonly usage: MyMediaUsageResolver,
  ) {}

  async listMine(userId: string): Promise<MyMediaItem[]> {
    const listed: {
      key: string;
      kind: UploadKind;
      size: number;
      lastModified: string | null;
    }[] = [];

    for (const kind of UPLOAD_KINDS) {
      const prefix = `${UPLOAD_KIND_SPECS[kind].prefix}/${userId}/`;
      let continuationToken: string | undefined;
      do {
        const page = await this.storage.listObjects({
          prefix,
          continuationToken,
          maxKeys: MAX_KEYS_PER_PAGE,
        });
        for (const object of page.objects) {
          listed.push({
            key: object.key,
            kind,
            size: object.size,
            lastModified: object.lastModified,
          });
        }
        continuationToken = page.nextContinuationToken ?? undefined;
      } while (continuationToken);
    }

    const usageByKey = await this.usage.resolve(
      userId,
      listed.map((entry) => entry.key),
    );

    const items: MyMediaItem[] = listed.map((entry) => ({
      key: entry.key,
      kind: entry.kind,
      size: entry.size,
      lastModified: entry.lastModified,
      fileUrl: `/files/${entry.key}`,
      inUse: usageByKey.has(entry.key),
      usedAs: usageByKey.get(entry.key) ?? null,
    }));

    // Newest first; objects with no lastModified sort last.
    items.sort((left, right) =>
      (right.lastModified ?? '').localeCompare(left.lastModified ?? ''),
    );
    return items;
  }
}
