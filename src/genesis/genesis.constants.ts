import { ForbiddenException, HttpStatus } from '@nestjs/common';

/**
 * Identity of the permanent QueerPulse house account — the inviter behind the
 * genesis invite, and the only way to satisfy `invites.inviter_id NOT NULL`
 * before any member exists.
 *
 * `HOUSE_GOOGLE_ID` and `HOUSE_EMAIL` are values no real Google account can
 * present. `HOUSE_EMAIL` must NEVER be an address anyone signs into Google
 * with: `findByGoogleId` would miss, signup would proceed, and the
 * `users.email` unique constraint would surface as a 500.
 */
export const HOUSE_GOOGLE_ID = 'system:queerpulse';
export const HOUSE_EMAIL = 'system@queerpulse.com';

/**
 * `last_name` is deliberately empty — the column is `NOT NULL` but an empty
 * string is legal, and the invite landing page should read "QueerPulse", not
 * "QueerPulse Team". `UsersService.generateUniqueSlug` slugifies
 * `"QueerPulse "` down to `queerpulse`, which is the slug we want.
 */
export const HOUSE_FIRST_NAME = 'QueerPulse';
export const HOUSE_LAST_NAME = '';

/**
 * Reason codes on the `POST /genesis/claim` 403s, so the client can name why a
 * claim was refused. They live here with the rest of the module, which keeps
 * the whole genesis feature deletable in one commit.
 */
export type GenesisErrorCode = 'genesis_closed' | 'genesis_not_founder_account';

const GENESIS_ERROR_MESSAGES: Record<GenesisErrorCode, string> = {
  genesis_closed: 'Genesis is closed',
  genesis_not_founder_account: 'Not the genesis account',
};

/**
 * The shared error body `{ statusCode, code, message }`. Every genesis reason
 * code is a 403, so this builds a `ForbiddenException` with that body.
 */
export function genesisError(code: GenesisErrorCode): ForbiddenException {
  return new ForbiddenException({
    statusCode: HttpStatus.FORBIDDEN,
    code,
    message: GENESIS_ERROR_MESSAGES[code],
  });
}
