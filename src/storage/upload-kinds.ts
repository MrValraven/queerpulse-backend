// Per-kind storage-key prefix + byte cap for the unified `/uploads/presign`
// endpoint. Mirrors the frontend's authoritative-on-the-client copy of these
// caps in `features/members/api/uploadProcessing.ts` (`UPLOAD_LIMITS`) — the
// frontend only gives instant feedback; this table is the real enforcement.
export type UploadKind =
  'avatar' | 'work-image' | 'story-cover' | 'gathering-photo';

export interface UploadKindSpec {
  /** Storage-key prefix the object is namespaced under (then `/<userId>/<uuid>.<ext>`). */
  prefix: string;
  /** Hard per-kind byte cap, checked against the client-declared `byteSize`. */
  maxBytes: number;
}

const MB = 1024 * 1024;

export const UPLOAD_KIND_SPECS: Readonly<Record<UploadKind, UploadKindSpec>> = {
  avatar: { prefix: 'avatars', maxBytes: 5 * MB },
  'work-image': { prefix: 'work', maxBytes: 10 * MB },
  'story-cover': { prefix: 'story-covers', maxBytes: 10 * MB },
  'gathering-photo': { prefix: 'gathering-photos', maxBytes: 5 * MB },
};

export const UPLOAD_KINDS: readonly UploadKind[] = Object.keys(
  UPLOAD_KIND_SPECS,
) as UploadKind[];
