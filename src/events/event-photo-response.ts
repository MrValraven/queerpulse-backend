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
  // `uploaderId` is nullable (an uploader who erased their account leaves the
  // photo standing with a NULL uploader — FK is `ON DELETE SET NULL`), so drop
  // the NULLs before the lookup and render those photos with no uploader ref.
  const uploaderIds = photos
    .map((photo) => photo.uploaderId)
    .filter((uploaderId): uploaderId is string => uploaderId !== null);
  const uploaderRefs = await memberLookup.byUserIds(uploaderIds);
  return Promise.all(
    photos.map(async (photo) => ({
      id: photo.id,
      url: await storage.createPresignedDownload(photo.storageKey),
      uploader:
        photo.uploaderId !== null
          ? (uploaderRefs.get(photo.uploaderId) ?? null)
          : null,
      caption: photo.caption,
      createdAt: photo.createdAt.toISOString(),
    })),
  );
}
