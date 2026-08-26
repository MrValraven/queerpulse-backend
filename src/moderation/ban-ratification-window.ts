/**
 * How long a permanent ban waits for its second signature, and the audit codes
 * the hold's three endings write.
 *
 * A separate file from `ban-ratification.service.ts` on purpose:
 * `AccountEnforcementService` opens the hold (it is the only thing that touches
 * `users.status`, so the interim suspension and the hold row have to be written
 * together) while `BanRatificationService` decides and expires it, and that
 * service already injects the enforcement one. Keeping the constants here means
 * neither file has to import the other.
 */

/**
 * 72 hours. Long enough that a hold opened on a Friday evening is still there
 * when the next moderator looks on Monday, which is the case that decides
 * whether this control gets used or gets routed around. Short enough that the
 * interim suspension it costs the member is measured in days, because that
 * suspension is a real consequence imposed before anyone has confirmed the
 * decision behind it.
 */
export const BAN_RATIFICATION_WINDOW_HOURS = 72;

const BAN_RATIFICATION_WINDOW_MS =
  BAN_RATIFICATION_WINDOW_HOURS * 60 * 60 * 1000;

/** The instant a hold opened at `now` lapses. */
export function banHoldExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + BAN_RATIFICATION_WINDOW_MS);
}

/**
 * The audit codes this flow writes. `ban` itself is deliberately absent: it is
 * still written, by `BanRatificationService.decide`, at the moment the ban
 * actually takes effect, so an appeal against "the ban" resolves to a real row
 * and the conflict-of-interest guard points at a moderator who was part of the
 * decision.
 */
export const BAN_PENDING_AUDIT_ACTION = 'ban_pending_ratification';
export const BAN_DECLINED_AUDIT_ACTION = 'ban_declined';
export const BAN_HOLD_EXPIRED_AUDIT_ACTION = 'ban_hold_expired';
