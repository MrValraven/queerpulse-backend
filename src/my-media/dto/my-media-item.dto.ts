import { UploadKind } from '../../storage/upload-kinds';
import { MyMediaUsage } from '../my-media-usage.resolver';

/** One object the caller uploaded, as returned by GET /me/media. `inUse` is a
 *  BEST-EFFORT advisory flag (see MyMediaUsageResolver), never authoritative.
 *  `usedAs` is a language-neutral slug the frontend translates — never prose. */
export interface MyMediaItem {
  key: string;
  kind: UploadKind;
  size: number;
  lastModified: string | null;
  /** Served through the API: `/files/<key>`. */
  fileUrl: string;
  inUse: boolean;
  usedAs: MyMediaUsage | null;
}

export interface MyMediaListResponse {
  items: MyMediaItem[];
}
