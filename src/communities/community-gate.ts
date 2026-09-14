import { ForbiddenException } from '@nestjs/common';
import { AccessTier } from './entities/community.entity';

/**
 * The discriminator on the 403 body that tells a client "this community
 * exists, you may not see inside it, here is the gate card instead". A code
 * rather than a message so the frontend never has to match on prose that
 * reword or localization would break; the platform-lockdown 503 already sets
 * that precedent.
 */
export const COMMUNITY_MEMBERS_ONLY_CODE = 'COMMUNITY_MEMBERS_ONLY';

/**
 * A community whose interior and whose details are closed to anyone off its
 * roster. Every tier but `public` is gated: `request` and `invite` gate entry,
 * `private` also hides that the community is there at all.
 *
 * Expressed as "anything that is not `public`" rather than as a list of the
 * three closed tiers on purpose. A future tier is closed until somebody
 * deliberately opens it, which is the safe direction for a privacy rule to
 * drift in. Mirrors how `GATHERING_TIERS_VISIBLE_TO_NON_MEMBERS` reasons about
 * the same risk from the other side.
 */
export function isGatedTier(tier: AccessTier): boolean {
  return tier !== AccessTier.Public;
}

/**
 * The refusal a gated community hands a non-member. 403 and not 404, because
 * a `request` or `invite` community is already listed in discover and already
 * carries its tier on its card: its existence is not the secret, its contents
 * are. `private` never reaches this exception for an uninvited caller, since
 * the 404 gate above it in `getBySlug` fires first and existence IS the secret
 * there.
 */
export function membersOnlyException(): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    message: 'Members only',
    code: COMMUNITY_MEMBERS_ONLY_CODE,
  });
}
