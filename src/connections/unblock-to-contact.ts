import { ConflictException } from '@nestjs/common';

/**
 * SEC-19: the code of the 409 a member gets for a block they placed
 * themselves on the member they are trying to reach. The block is named
 * because they can lift it; a block the other member placed answers the
 * profile read's 404.
 *
 * Lives in `connections` so both first-contact paths share one body:
 * `ConnectionsService.requestConnection` and `MessageRequestsService`
 * (messaging already imports connections, so the import runs one way).
 */
export const UNBLOCK_TO_CONTACT_CODE = 'UNBLOCK_TO_CONTACT';

/** SEC-19: the one body of the {@link UNBLOCK_TO_CONTACT_CODE} refusal. */
export function unblockToContactException(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: UNBLOCK_TO_CONTACT_CODE,
    message: 'Unblock this member before sending a request',
  });
}
