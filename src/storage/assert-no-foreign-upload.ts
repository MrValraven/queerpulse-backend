import { ForbiddenException } from '@nestjs/common';
import { storageKeyOwnerId } from './storage-key';

/**
 * Shared service-side backstop for the multi-editor image surfaces listed in
 * `SHARED_UPLOAD_HANDLERS` (see `shared-upload-handlers.ts`).
 *
 * Those handlers keep the interceptor's foreign-upload exemption so a
 * collaborator can re-save an entity whose photo a DIFFERENT collaborator
 * uploaded (the edit form is seeded with the currently stored `/files/<key>`
 * URL and re-sends it verbatim). The exemption alone would also let a member
 * point the field at a NEW upload that is not theirs, which is the
 * impersonation vector. This function draws the line the interceptor cannot:
 * a foreign upload is allowed ONLY when it is ALREADY the stored value
 * (nothing changed); a foreign upload the entity does not already carry is a
 * new reference and is refused, exactly as the strict interceptor rule would.
 *
 * Call it in the service BEFORE mutating, once per image field, passing the
 * field's currently stored value(s) as `alreadyStored`. The interceptor has
 * already collapsed any `/files/<key>` URL to its bare key by the time this
 * runs, so both sides of the comparison are canonical keys.
 */
export function assertNoForeignUploadIntroduced(
  requesterUserId: string,
  incoming: string | null | undefined,
  alreadyStored: readonly (string | null | undefined)[],
): void {
  if (!incoming) {
    return;
  }
  const ownerUserId = storageKeyOwnerId(incoming);
  if (ownerUserId === null || ownerUserId === requesterUserId) {
    return;
  }
  if (alreadyStored.includes(incoming)) {
    return;
  }
  // Same wording as the interceptor's, and deliberately free of the owner's id
  // so a 403 cannot confirm who uploaded a key.
  throw new ForbiddenException('Referenced upload does not belong to you');
}
