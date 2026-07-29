import { MemberLookup, MemberRef } from '../common/member-ref';
import { StorageService } from '../storage/storage.service';
import { EventPhoto } from './entities/event-photo.entity';

export interface EventPhotoView {
  id: string;
  /** Short-lived presigned GET URL — the browser renders this directly. */
  url: string;
  uploader: MemberRef | null;
  caption: string | null;
  createdAt: string;
}

// Presigns each photo's storage key (the caller has already authorized the
// requester as a participant) and resolves uploaders to `MemberRef` in one
// lookup. Mapped by hand — this codebase has no global serializer.
export async function toEventPhotoViews(
  photos: EventPhoto[],
  storage: StorageService,
  memberLookup: MemberLookup,
): Promise<EventPhotoView[]> {
  const uploaderRefs = await memberLookup.byUserIds(
    photos.map((photo) => photo.uploaderId),
  );
  return Promise.all(
    photos.map(async (photo) => ({
      id: photo.id,
      url: await storage.createPresignedDownload(photo.storageKey),
      uploader: uploaderRefs.get(photo.uploaderId) ?? null,
      caption: photo.caption,
      createdAt: photo.createdAt.toISOString(),
    })),
  );
}
