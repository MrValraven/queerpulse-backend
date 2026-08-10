import { UploadKind } from '../../storage/upload-kinds';

/** One object the caller uploaded, as returned by GET /me/media. `inUse` is a
 *  BEST-EFFORT advisory flag (see MyMediaUsageResolver), never authoritative. */
export interface MyMediaItem {
  key: string;
  kind: UploadKind;
  size: number;
  lastModified: string | null;
  /** Served through the API: `/files/<key>`. */
  fileUrl: string;
  inUse: boolean;
  usedAs: string | null;
}

export interface MyMediaListResponse {
  items: MyMediaItem[];
}
