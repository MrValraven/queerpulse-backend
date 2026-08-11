import { ForbiddenException, Injectable } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import {
  UPLOAD_KIND_SPECS,
  UPLOAD_KINDS,
  UploadKind,
} from '../storage/upload-kinds';
import { storageKeyOwnerId } from '../storage/storage-key';
import { MyMediaItem, MyMediaListResponse } from './dto/my-media-item.dto';
import { MediaReferenceResolver } from '../media-references/media-reference.resolver';

const MAX_KEYS_PER_PAGE = 1000;

@Injectable()
export class MyMediaService {
  constructor(
    private readonly storage: StorageService,
    private readonly references: MediaReferenceResolver,
  ) {}

  async listMine(userId: string): Promise<MyMediaListResponse> {
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

    const { references: referencesByKey, degraded } =
      await this.references.resolve(listed.map((entry) => entry.key));

    const items: MyMediaItem[] = listed.map((entry) => ({
      key: entry.key,
      kind: entry.kind,
      size: entry.size,
      lastModified: entry.lastModified,
      fileUrl: `/files/${entry.key}`,
      references: referencesByKey.get(entry.key) ?? [],
    }));

    // Newest first; objects with no lastModified sort last.
    items.sort((left, right) =>
      (right.lastModified ?? '').localeCompare(left.lastModified ?? ''),
    );
    return { items, degraded };
  }

  async deleteMine(userId: string, key: string): Promise<void> {
    // storageKeyOwnerId returns null for any malformed/unknown key, so this one
    // check covers both "not a valid key" and "not yours".
    if (storageKeyOwnerId(key) !== userId) {
      throw new ForbiddenException('That upload is not yours to delete.');
    }
    await this.storage.deleteObjectByReference(key);
  }
}
