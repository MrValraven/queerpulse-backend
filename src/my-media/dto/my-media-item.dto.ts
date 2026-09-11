import { UploadKind } from '../../storage/upload-kinds';
import { MediaReference } from '../../media-references/media-reference.types';
import type { CropRect } from '../../media-crops/crop-rect';

/** One object the caller uploaded, as returned by GET /me/media. `references`
 *  lists every place this upload is still referenced, resolved by the shared
 *  `MediaReferenceResolver` — empty means safe to delete. */
export interface MyMediaItem {
  key: string;
  kind: UploadKind;
  size: number;
  lastModified: string | null;
  /** Served through the API: `/files/<key>`. */
  fileUrl: string;
  /** Every place this upload is still referenced. Empty = safe to delete. */
  references: MediaReference[];
  /** The saved reframe crop (`media_crops`), shared by every place this upload
   *  is used, so the picker can reopen the reframer where it was left. Null
   *  when the upload was never reframed. */
  crop: CropRect | null;
}

export interface MyMediaListResponse {
  items: MyMediaItem[];
  /** True when some reference checks failed; treat 'not referenced' as
   *  unverified rather than a green light to delete. */
  degraded: boolean;
}
