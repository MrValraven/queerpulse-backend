import { MediaReference } from '../../media-references/media-reference.types';

/** One object in the admin media console. `uploader` is null for keys with no
 *  resolvable owner (external/seeded/legacy). `contentType` is DERIVED from the
 *  key's extension and is UNVERIFIED — the drawer's head check confirms it. */
export interface AdminMediaObjectDTO {
  key: string;
  size: number;
  lastModified: string | null;
  /** Upload-kind prefix, e.g. `avatars` (first path segment). */
  kind: string;
  uploaderId: string | null;
  /** Extension-derived, unverified. */
  contentType: string | null;
  /** Stable proxy URL through `/files/*`. Relative to the API base. */
  fileUrl: string;
  /** Fresh short-TTL presigned GET straight to the bucket. */
  presignedUrl: string;
  uploader: AdminMediaUploaderDTO | null;
  /** Every place this object is still referenced. Empty = orphan / safe to delete. */
  references: MediaReference[];
}

export interface AdminMediaUploaderDTO {
  id: string;
  displayName: string;
  handle: string;
}

/** One row in the "filter by uploader" search results — the uploader identity
 *  plus an avatar for the picker. `avatarUrl` is resolved through `toImageUrl`,
 *  so it is a stable `/files/*` URL (or null). */
export interface AdminMediaUploaderSearchResultDTO extends AdminMediaUploaderDTO {
  avatarUrl: string | null;
}

export interface AdminMediaListResponse {
  objects: AdminMediaObjectDTO[];
  nextContinuationToken: string | null;
  /** True when some reference checks failed; treat an object's empty
   *  `references` as unverified rather than a confirmed orphan. */
  degraded: boolean;
}

export interface AdminMediaHeadResponse {
  key: string;
  contentType: string | null;
  contentLength: number | null;
}

export interface AdminMediaListQuery {
  /** An upload KIND prefix name (e.g. `avatars`) — validated to the allowlist. */
  prefix?: string;
  continuationToken?: string;
  limit?: number;
  /** When set, list every object owned by this member across ALL kinds — the
   *  "filter by uploader" view. Overrides `prefix`/`continuationToken`: the
   *  member's uploads are a bounded set returned in one page. */
  uploaderId?: string;
}
