/**
 * The one expiry window both halves of SUS-07 read.
 *
 * A card expires silently today: the only route back in date is an owner
 * running the roster bulk issue, so a member finds out their card is dead
 * standing at a door. Two things fix that, and both need the same number:
 * the warning job (`CardExpiryWarningService`) tells the holder while there
 * is still time to act, and the member-initiated renew
 * (`MembershipCardsService.renewOwnCard`) is open from the same moment.
 *
 * Keeping the two on one constant is what makes the notification honest: a
 * bell that says "renew it now" must never arrive before the button works.
 */
export const CARD_EXPIRY_WARNING_LEAD_DAYS = 30;

export const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

/**
 * Whether a card is close enough to its expiry (or already past it) for its
 * holder to renew it themselves.
 *
 * A card with no expiry at all returns false: there is nothing to renew, and
 * a "renew" that re-stamped a null expiry would be a no-op dressed as an
 * action. Everything further out than the lead window returns false too, so a
 * member cannot ratchet their expiry forward indefinitely by pressing the
 * button every morning.
 */
export function isWithinRenewalWindow(
  expiresAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (!expiresAt) return false;
  const horizon =
    now.getTime() + CARD_EXPIRY_WARNING_LEAD_DAYS * DAY_IN_MILLISECONDS;
  return expiresAt.getTime() <= horizon;
}

/**
 * Whole days between now and an expiry, floored at 1.
 *
 * A NUMBER, never a composed sentence: the frontend mirrors it onto `count`
 * and lets CLDR pick the plural in the member's own language, exactly the way
 * `account_deletion_final_warning` carries `daysRemaining`. The floor is what
 * stops a card the sweep reaches a few hours late reading "in 0 days".
 */
export function daysUntil(expiresAt: Date, now: Date = new Date()): number {
  return Math.max(
    1,
    Math.round((expiresAt.getTime() - now.getTime()) / DAY_IN_MILLISECONDS),
  );
}
