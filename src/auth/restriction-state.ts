import { LessThanOrEqual, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';

/** The two columns a restriction's lazy expiry reads and writes. Structural,
 *  so any freshly-loaded `User` row satisfies it without a cast. */
export interface RestrictionAware {
  id: string;
  restricted: boolean;
  restrictedUntil: Date | null;
}

/**
 * Lazy expiry for the `restrict` moderation action, with write-through —
 * extracted from `JwtStrategy.validate`'s original private
 * `liftExpiredRestriction` (ENG-242) so the HTTP/handshake read path
 * (`JwtStrategy`) and the WS/HTTP send write path
 * (`MessagesService.sendMessageWithOutcome`) can never disagree about whether
 * a restriction has lapsed.
 *
 * A restriction never has a `null` (permanent) expiry —
 * `AccountEnforcementService.enforceAgainstUser` always sets one — so every
 * restriction ends by the clock; there is no "ban" case to skip, unlike
 * `liftExpiredSuspension`'s handling of `suspendedUntil === null`.
 *
 * Returns the CURRENT truth (`false` once lifted), and writes the lapsed row
 * back conditionally on BOTH `restricted: true` still holding AND the stored
 * expiry still being at-or-before the moment this decision was taken, so a
 * concurrent moderator action landing between the caller's read and this write
 * is never clobbered by a stale expiry decision. `restricted: true` alone was
 * not enough: a moderator who re-restricts this member in that window leaves
 * the row `restricted: true` again, with a FRESH future `restricted_until`, so
 * the predicate still matched and the stale lift wiped the new restriction.
 * Matching on the expiry too means the re-restricted row no longer qualifies
 * and the lift affects no rows at all.
 */
export async function liftExpiredRestriction(
  users: Repository<User>,
  user: RestrictionAware,
): Promise<boolean> {
  const decidedAt = new Date();
  if (
    !user.restricted ||
    user.restrictedUntil === null ||
    user.restrictedUntil > decidedAt
  ) {
    return user.restricted;
  }

  // Guarded on the SAME instant the check above decided against, never a fresh
  // `new Date()`, so the write can only ever lift a restriction that had
  // genuinely lapsed at the moment this function judged it lapsed.
  await users.update(
    {
      id: user.id,
      restricted: true,
      restrictedUntil: LessThanOrEqual(decidedAt),
    },
    { restricted: false, restrictedUntil: null },
  );

  return false;
}
