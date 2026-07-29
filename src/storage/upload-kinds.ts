// Per-kind storage-key prefix, byte cap, and read visibility for the unified
// `/uploads/presign` endpoint. Mirrors the frontend's authoritative-on-the-client
// copy of these caps in `features/members/api/uploadProcessing.ts`
// (`UPLOAD_LIMITS`) — the frontend only gives instant feedback; this table is
// the real enforcement.
export type UploadKind =
  'avatar' | 'work-image' | 'story-cover' | 'gathering-photo' | 'group-avatar';

export interface UploadKindSpec {
  /** Storage-key prefix the object is namespaced under (then `/<userId>/<uuid>.<ext>`). */
  readonly prefix: string;
  /** Hard per-kind byte cap, checked against the client-declared `byteSize`. */
  readonly maxBytes: number;
  /**
   * Whether `GET /files/<key>` demands a logged-in member.
   *
   * Railway Buckets are private with no public URL, so every kind is read
   * through our API regardless — this flag only decides whether that route
   * 401s without a session. Avatars, work images, and story covers are false
   * because `public-profiles.controller.ts` is `@Public()` and social-link
   * unfurlers cannot send a cookie; gating them would break logged-out profile
   * pages and blank every shared link preview. Gathering photos are true:
   * identifiable people at real events.
   */
  readonly requiresSession: boolean;
}

const MB = 1024 * 1024;

export const UPLOAD_KIND_SPECS: Readonly<Record<UploadKind, UploadKindSpec>> = {
  avatar: { prefix: 'avatars', maxBytes: 5 * MB, requiresSession: false },
  'work-image': { prefix: 'work', maxBytes: 10 * MB, requiresSession: false },
  'story-cover': {
    prefix: 'story-covers',
    maxBytes: 10 * MB,
    requiresSession: false,
  },
  'gathering-photo': {
    prefix: 'gathering-photos',
    maxBytes: 5 * MB,
    requiresSession: true,
  },
  // A group chat's photo. Same size/type constraints as a member `avatar`, and
  // deliberately `requiresSession: false` for the SAME reason avatars are:
  // `GET /files/<key>` serves a session-gated kind ONLY to the member who
  // uploaded it (see `files.controller.ts` — no photo↔resource table to scope
  // it any wider), which would hide the group photo from every OTHER member.
  // A group avatar must be visible to the whole group, so it is served like an
  // avatar. Ownership of the SET action is not weakened by this: the storage
  // key embeds the uploader's user id, the global StorageKeyOwnershipInterceptor
  // rejects a PATCH that references someone else's key, and `updateGroup`
  // re-checks the caller is an owner/admin of the target group before it
  // persists the key — so a member can never attach a photo to a group they
  // don't administer.
  'group-avatar': {
    prefix: 'group-avatars',
    maxBytes: 5 * MB,
    requiresSession: false,
  },
};

export const UPLOAD_KINDS: readonly UploadKind[] = Object.keys(
  UPLOAD_KIND_SPECS,
) as UploadKind[];
