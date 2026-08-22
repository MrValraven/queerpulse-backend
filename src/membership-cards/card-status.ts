import { MembershipCardStatus } from './entities/membership-card.entity';

export type EffectiveCardStatus =
  'active' | 'suspended' | 'revoked' | 'expired';

export interface EffectiveStatusInput {
  status: MembershipCardStatus;
  expiresAt: Date | null;
  programEnabled: boolean;
  communityFrozenAt: Date | null;
  communityArchivedAt: Date | null;
  now?: Date;
}

/**
 * The status a verifier actually sees, combining the card's own status with
 * the issuing community's lifecycle and the expiry clock.
 *
 * The precedence order is deliberate and runs hardest first: a moderated
 * community must never keep issuing working credentials (spec §L.2), so an
 * archived community revokes and a frozen one suspends, regardless of how
 * healthy the individual card row looks.
 */
export function effectiveCardStatus({
  status,
  expiresAt,
  programEnabled,
  communityFrozenAt,
  communityArchivedAt,
  now = new Date(),
}: EffectiveStatusInput): EffectiveCardStatus {
  if (status === MembershipCardStatus.Revoked) return 'revoked';
  if (communityArchivedAt) return 'revoked';
  if (status === MembershipCardStatus.Suspended) return 'suspended';
  if (communityFrozenAt) return 'suspended';
  if (!programEnabled) return 'suspended';
  if (expiresAt && expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
}
