import { MemberLookup, MemberRef } from '../common/member-ref';
import type { CropRect } from '../media-crops/crop-rect';
import { cropFor } from '../media-crops/crop-response';
import { StorageService } from '../storage/storage.service';
import { EventPhoto } from './entities/event-photo.entity';

export interface EventPhotoView {
  id: string;
  /** Short-lived presigned GET URL — the browser renders this directly. */
  url: string;
  /** Crop rect for the photo, when the uploader/organizer reframed it. */
  crop?: CropRect;
  uploader: MemberRef | null;
  caption: string | null;
  createdAt: string;
}

// Presigns each photo's storage key (the caller has already authorized the
// requester as a participant) and resolves uploaders to `MemberRef` in one
// lookup. Mapped by hand — this codebase has no global serializer. `crops` is
// a pre-loaded lookup (the caller batches ONE `MediaCropService.getMany`
// before calling this — this function was already async for the presign
// fan-out, so no NEW async work is introduced here).
export async function toEventPhotoViews(
  photos: EventPhoto[],
  storage: StorageService,
  memberLookup: MemberLookup,
  crops: Map<string, CropRect> = new Map(),
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
      crop: cropFor(photo.storageKey, crops),
      uploader:
        photo.uploaderId !== null
          ? (uploaderRefs.get(photo.uploaderId) ?? null)
          : null,
      caption: photo.caption,
      createdAt: photo.createdAt.toISOString(),
    })),
  );
}
