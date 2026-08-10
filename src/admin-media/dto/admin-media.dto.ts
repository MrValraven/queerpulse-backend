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
}

export interface AdminMediaUploaderDTO {
  id: string;
  displayName: string;
  handle: string;
}

export interface AdminMediaListResponse {
  objects: AdminMediaObjectDTO[];
  nextContinuationToken: string | null;
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
}
