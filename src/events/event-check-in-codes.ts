/**
 * The machine-readable codes on `EventCheckInService`'s coded refusals, so a
 * client can branch on what happened.
 *
 * Same contract as `EVENT_ATTENDANCE_WINDOW_CLOSED_CODE`,
 * `INVITE_QUOTA_EXCEEDED` and `AFFIRMING_PLEDGE_REQUIRED`: `code` is what a
 * client branches on, `message` is only a human fallback. Every exception
 * that carries one of these uses the same object-body shape:
 * `{ statusCode, error, code, message }`.
 *
 * The 400 `checkIn` throws when the request names both `memberSlug` and
 * `cardToken`, or neither, stays uncoded: it is a client bug, so there is
 * nothing for a UI to branch on.
 */

/** A scanned card token that could not be resolved to an open door: bad
 *  signature, wrong generation, missing card, missing programme, missing
 *  community, or a card whose `effectiveCardStatus` is not `active`. One
 *  code for all of them, on purpose: see `resolveByCardToken`. */
export const CHECK_IN_CARD_UNREADABLE = 'CHECK_IN_CARD_UNREADABLE';

/** The resolved guest's RSVP is waitlisted, holding no seat yet. Thrown from
 *  `checkIn` whether the guest was resolved by name or by card. */
export const CHECK_IN_WAITLISTED = 'CHECK_IN_WAITLISTED';

/** The resolved guest's RSVP is "maybe", holding no seat. Thrown from
 *  `checkIn` whether the guest was resolved by name or by card. */
export const CHECK_IN_MAYBE = 'CHECK_IN_MAYBE';

/** There is no RSVP at all for this member on this gathering, or it was
 *  cancelled. Thrown from both `checkIn` and `undoCheckIn`. */
export const CHECK_IN_NOT_ON_GUEST_LIST = 'CHECK_IN_NOT_ON_GUEST_LIST';

/** A `memberSlug` could not be resolved to a member, from either of the two
 *  by-name resolvers: `resolveByMemberSlugForCheckIn` (`checkIn`), when the
 *  slug matches nobody or matches a member whose account is not active; and
 *  `resolveByMemberSlug` (`undoCheckIn` only, no account-status check), when
 *  the slug matches nobody. One code and one message across both resolvers
 *  and both reasons, on purpose: the card path never raises this code. */
export const CHECK_IN_MEMBER_NOT_FOUND = 'CHECK_IN_MEMBER_NOT_FOUND';
