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
