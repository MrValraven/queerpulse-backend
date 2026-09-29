import { UserStatus } from '../users/entities/user.entity';
import { MembershipCardStatus } from './entities/membership-card.entity';

export type EffectiveCardStatus =
  'active' | 'suspended' | 'revoked' | 'expired';

export interface EffectiveStatusInput {
  status: MembershipCardStatus;
  expiresAt: Date | null;
  programEnabled: boolean;
  communityFrozenAt: Date | null;
  communityArchivedAt: Date | null;
  /**
   * The holder's platform account status, or `null` when the caller has a
   * reason not to gate on it. Anything other than `Active` (suspended or
   * banned by moderation, deactivated, or inside the erasure grace period,
   * which also sets `Deactivated`) reads as `suspended`. The same
   * `status = Active` predicate the directory, feed and member refs apply.
   *
   * Every door passes the real value: the public verification
   * (`CardVerificationService`) and the event check-in scan
   * (`EventCheckInService`). Required, so every call site must state it,
   * which keeps a future door caller from forgetting it and letting a
   * suspended holder's card read as valid.
   *
   * The callers that are not a door pass `null` explicitly, each with its own
   * reason on the call site: the issuer roster (`CardHoldersService`) keeps
   * showing the card's own status so its Pause, Revoke and Reinstate controls
   * act on what they say. The rest are all the holder's own view of their own
   * card, so none of them gates on the holder's account either: their wallet
   * (`MyCardsService`), their own token route
   * (`MembershipCardsService.resolveEffectiveStatus`), and their own renewal
   * (`MembershipCardsService.renewOwnCard`).
   */
  holderStatus: UserStatus | null;
  now?: Date;
}

/**
 * The status a verifier actually sees, combining the card's own status with
 * the issuing community's lifecycle and the expiry clock.
 *
 * The precedence order is deliberate and runs hardest first: a moderated
 * community must never keep issuing working credentials (spec §L.2), so an
 * archived community revokes and a frozen one suspends, regardless of how
 * healthy the individual card row looks. A holder whose account is not
 * active is treated like a frozen community: the card suspends, which tells a
 * door "not valid today" and says nothing about why.
 */
export function effectiveCardStatus({
  status,
  expiresAt,
  programEnabled,
  communityFrozenAt,
  communityArchivedAt,
  holderStatus,
  now = new Date(),
}: EffectiveStatusInput): EffectiveCardStatus {
  if (status === MembershipCardStatus.Revoked) return 'revoked';
  if (communityArchivedAt) return 'revoked';
  if (holderStatus && holderStatus !== UserStatus.Active) return 'suspended';
  if (status === MembershipCardStatus.Suspended) return 'suspended';
  if (communityFrozenAt) return 'suspended';
  if (!programEnabled) return 'suspended';
  if (expiresAt && expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
}
