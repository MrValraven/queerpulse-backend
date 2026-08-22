import {
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import {
  UPLOAD_KIND_SPECS,
  UPLOAD_KINDS,
  UploadKind,
} from '../storage/upload-kinds';
import { storageKeyOwnerId } from '../storage/storage-key';
import { MyMediaItem, MyMediaListResponse } from './dto/my-media-item.dto';
import { MediaReferenceResolver } from '../media-references/media-reference.resolver';
import type { MediaReference } from '../media-references/media-reference.types';

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

  /**
   * Deletes one of the caller's own uploads from the bucket — but only once the
   * object is proven to be REFERENCED BY NOTHING.
   *
   * A bucket delete is irreversible and the rows that point at a key keep
   * pointing at it, so deleting an object that is still live on a profile, a
   * community cover, a listing, a cinema title or a magazine byline leaves a
   * permanently broken image with no way back. `listMine` already resolves
   * references per key so the UI can grey out an in-use item, but that is a
   * hint, not a gate: a stale list, a raced second tab, a scripted call or any
   * other client can all reach this method with a key that has since been
   * attached to something. The authority therefore lives here.
   *
   * `degraded` is honoured as carefully as the reference list itself. It means
   * at least one source query threw and was swallowed, so "no references" is
   * UNVERIFIED rather than authoritative (see `MediaReferenceResolver`), and
   * treating it as a green light is exactly how a live image gets deleted. A
   * 503 says "try again", which is true and recoverable; a delete is not.
   *
   * There is deliberately no `force`. Detaching a key from its referencing rows
   * is a write into every module that owns one of those columns, which this
   * service has no business doing; a member who really wants the object gone
   * removes the image where it is used, and then this call succeeds.
   */
  async deleteMine(userId: string, key: string): Promise<void> {
    // storageKeyOwnerId returns null for any malformed/unknown key, so this one
    // check covers both "not a valid key" and "not yours". Stays FIRST: a
    // caller must never learn where somebody else's upload is referenced.
    if (storageKeyOwnerId(key) !== userId) {
      throw new ForbiddenException('That upload is not yours to delete.');
    }

    const { references, degraded } = await this.references.resolve([key]);
    if (degraded) {
      throw new ServiceUnavailableException(
        'Could not verify where this upload is used. Please try again.',
      );
    }
    const referencingPlaces: MediaReference[] = references.get(key) ?? [];
    if (referencingPlaces.length > 0) {
      // The reference list travels with the 409 so the client can name the
      // places to detach it from instead of guessing. It is scoped to a key
      // the caller uploaded, and `MediaReference` carries only `type`,
      // `entityId`, `label` and `slug` — never a private column.
      throw new ConflictException({
        message: 'This upload is still used. Remove it there first.',
        references: referencingPlaces,
      });
    }

    await this.storage.deleteObjectByReference(key);
  }
}
